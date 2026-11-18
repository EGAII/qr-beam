import { LTDecoder } from './fountain.js';
import { openPayload, parseFrame } from './protocol.js';
import { formatBytes } from './util.js';

// ZXing (WebAssembly) behind the standard BarcodeDetector API, for browsers without a
// built-in detector (iPhone Safari, desktop Firefox/Windows Chrome).
const PONYFILL_URL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.3/dist/es/ponyfill.min.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const crop = document.createElement('canvas');
const cropCtx = crop.getContext('2d', { willReadFrequently: true });

const state = {
  stream: null,
  deviceId: null,
  scanning: false,
  detector: null,
  transfer: null,
  foreign: 0,
  lastPaint: 0,
  objectUrl: null,
  shareFile: null,
};

const detectorReady = createDetector()
  .then(({ detector, engine }) => {
    state.detector = detector;
    $('engine').textContent = engine === 'native' ? 'Scanner: built-in (fast)' : 'Scanner: ZXing WebAssembly';
  })
  .catch((err) => {
    $('engine').textContent = '';
    setStatus(`Could not load the QR scanner (${err.message}). Check the internet connection and reload.`, true);
  });

async function createDetector() {
  const forceZxing = new URLSearchParams(location.search).has('zxing');
  if (!forceZxing && 'BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        return { detector: new window.BarcodeDetector({ formats: ['qr_code'] }), engine: 'native' };
      }
    } catch {
      /* fall back to ZXing */
    }
  }
  const { BarcodeDetector } = await import(PONYFILL_URL);
  return { detector: new BarcodeDetector({ formats: ['qr_code'] }), engine: 'zxing' };
}

// ---- Camera -----------------------------------------------------------------
$('start-cam').addEventListener('click', () => startCamera());
$('stop-cam').addEventListener('click', () => {
  stopCamera();
  setStatus('Camera stopped. Tap Start camera to continue.');
});
$('camera-select').addEventListener('change', (e) => startCamera(e.target.value));

async function startCamera(deviceId) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus('The camera only works on a secure page. Open this page over https (for example GitHub Pages) or http://localhost.', true);
    return;
  }
  stopCamera();
  setStatus('Starting the camera…');
  const target = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...target, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (err) {
    setStatus(cameraError(err), true);
    return;
  }
  const track = state.stream.getVideoTracks()[0];
  state.deviceId = track.getSettings?.().deviceId || deviceId || null;
  tryContinuousFocus(track);
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  $('placeholder').hidden = true;
  $('start-cam').hidden = true;
  $('stop-cam').hidden = false;
  listCameras();

  await detectorReady;
  if (!state.detector) return;
  state.scanning = true;
  if (!state.transfer) setStatus('Point the camera at the animated QR code. Fill most of the square with it.');
  scheduleScan();
}

function stopCamera() {
  state.scanning = false;
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  video.srcObject = null;
  $('placeholder').hidden = false;
  $('start-cam').hidden = false;
  $('stop-cam').hidden = true;
}

async function tryContinuousFocus(track) {
  try {
    const caps = track.getCapabilities?.();
    if (caps?.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
  } catch {
    /* not supported: fine */
  }
}

async function listCameras() {
  const select = $('camera-select');
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    if (cams.length < 2) return;
    select.replaceChildren(
      ...cams.map((cam, i) => {
        const opt = new Option(cam.label || `Camera ${i + 1}`, cam.deviceId);
        opt.selected = cam.deviceId === state.deviceId;
        return opt;
      }),
    );
    select.hidden = false;
  } catch {
    select.hidden = true;
  }
}

function cameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      return 'Camera permission was denied. Allow camera access for this site in the browser settings, then reload.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No usable camera was found on this device.';
    case 'NotReadableError':
      return 'The camera is busy in another app. Close it and try again.';
    default:
      return `Could not start the camera: ${err?.message || err}`;
  }
}

// ---- Scanning ---------------------------------------------------------------
function scheduleScan() {
  if (!state.scanning) return;
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(scanOnce);
  else requestAnimationFrame(scanOnce);
}

async function scanOnce() {
  if (!state.scanning) return;
  try {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w && h) {
      // Decode only the centre square (where the guide is): less work, faster frames.
      const side = Math.min(w, h);
      const out = Math.min(side, 1080);
      if (crop.width !== out) {
        crop.width = out;
        crop.height = out;
      }
      cropCtx.drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out);
      const codes = await state.detector.detect(crop);
      for (const code of codes) handleText(code.rawValue);
    }
  } catch (err) {
    console.warn('scan failed', err);
  }
  scheduleScan();
}

function handleText(text) {
  const frame = parseFrame(text);
  if (!frame) {
    if (state.foreign++ % 20 === 0 && !state.transfer) {
      setStatus('That QR code is not from QR Beam. Point at the animated code on the sender page.');
    }
    return;
  }
  let t = state.transfer;
  if (!t || t.id !== frame.id || t.length !== frame.length || t.blockSize !== frame.blockSize) {
    t = state.transfer = {
      id: frame.id,
      flags: frame.flags,
      length: frame.length,
      blockSize: frame.blockSize,
      decoder: new LTDecoder(Math.ceil(frame.length / frame.blockSize), frame.blockSize),
      frames: 0,
      startedAt: performance.now(),
      finishing: false,
    };
  }
  if (t.finishing) return;
  if (t.decoder.add(frame.seed, frame.degree, frame.data)) t.frames++;
  if (t.decoder.done) finish(t);
  else paintProgress(t);
}

function paintProgress(t, force = false) {
  const now = performance.now();
  if (!force && now - state.lastPaint < 100) return;
  state.lastPaint = now;
  const pct = Math.floor(t.decoder.progress * 100);
  setProgress(pct);
  const seconds = (now - t.startedAt) / 1000;
  const speed = seconds > 0.5 ? ` · ${formatBytes(Math.round((t.frames * t.blockSize) / seconds))}/s` : '';
  setStatus(`Receiving ${formatBytes(t.length)} · ${pct}% · ${t.frames.toLocaleString()} codes read${speed}. Hold steady.`);
}

async function finish(t) {
  t.finishing = true;
  stopCamera();
  setProgress(100, true);
  navigator.vibrate?.(80);
  try {
    const result = await openPayload(t.decoder.result(t.length), t.flags, t.id);
    showResult(result, (performance.now() - t.startedAt) / 1000);
    setStatus('Done.');
  } catch (err) {
    state.transfer = null;
    setProgress(0);
    setStatus(`${err.message} Tap Start camera to try again.`, true);
  }
}

// ---- Result -------------------------------------------------------------------
function showResult(r, seconds) {
  const took = `received in ${seconds.toFixed(1)} s`;
  $('result').hidden = false;
  if (r.kind === 'text') {
    const text = new TextDecoder().decode(r.bytes);
    $('result-title').textContent = 'Text received';
    $('result-meta').textContent = `${[...text].length.toLocaleString()} characters · ${took}`;
    $('text-out').value = text;
    $('text-result').hidden = false;
    $('file-result').hidden = true;
    const url = text.trim();
    const isLink = /^https?:\/\/\S+$/i.test(url);
    $('open-link').hidden = !isLink;
    if (isLink) $('open-link').href = url;
    $('share-text').hidden = !navigator.share;
  } else {
    const mime = r.mime || 'application/octet-stream';
    const name = r.name || 'download';
    const blob = new Blob([r.bytes], { type: mime });
    revokeUrl();
    state.objectUrl = URL.createObjectURL(blob);
    $('result-title').textContent = name;
    $('result-meta').textContent = `${formatBytes(blob.size)} · ${mime} · ${took}`;
    $('download').href = state.objectUrl;
    $('download').download = name;
    const preview = $('preview');
    preview.hidden = !mime.startsWith('image/');
    if (!preview.hidden) preview.src = state.objectUrl;
    state.shareFile = new File([blob], name, { type: mime });
    $('share-file').hidden = !(navigator.canShare && navigator.canShare({ files: [state.shareFile] }));
    $('file-result').hidden = false;
    $('text-result').hidden = true;
  }
  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('copy').addEventListener('click', async () => {
  const text = $('text-out').value;
  try {
    await navigator.clipboard.writeText(text);
    flash($('copy'), 'Copied ✓');
  } catch {
    $('text-out').select();
    flash($('copy'), document.execCommand('copy') ? 'Copied ✓' : 'Select the text and copy it');
  }
});

$('share-text').addEventListener('click', () => navigator.share({ text: $('text-out').value }).catch(() => {}));
$('share-file').addEventListener('click', () => {
  if (state.shareFile) navigator.share({ files: [state.shareFile], title: state.shareFile.name }).catch(() => {});
});

$('again').addEventListener('click', () => {
  $('result').hidden = true;
  $('preview').removeAttribute('src');
  revokeUrl();
  state.transfer = null;
  setProgress(0);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  startCamera(state.deviceId || undefined);
});

function revokeUrl() {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null;
}

function flash(button, label) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = label;
  clearTimeout(button._timer);
  button._timer = setTimeout(() => (button.textContent = original), 1800);
}

function setProgress(pct, done = false) {
  $('bar').style.width = `${pct}%`;
  $('progress').setAttribute('aria-valuenow', String(pct));
  $('progress').classList.toggle('done', done);
}

function setStatus(message, isError = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', isError);
}

// Exposed for automated tests (feeds scanned text without a camera).
window.qrBeamReceive = { handleText };
