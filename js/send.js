import { LTEncoder } from './fountain.js';
import { buildPayload, packFrame } from './protocol.js';
import { renderQr } from './qr-draw.js';
import { formatBytes, formatDuration, loadSetting, saveSetting } from './util.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const $ = (id) => document.getElementById(id);
const state = { mode: 'text', file: null, session: null, raf: 0, paused: false, wakeLock: null };

// ---- Receiver link ---------------------------------------------------------
const receiverUrl = new URL('receive.html', location.href).href;
$('receiver-link').href = receiverUrl;
$('receiver-link').textContent = receiverUrl.replace(/^https?:\/\//, '');
renderQr($('receiver-qr'), receiverUrl, { ecl: 'M', mode: 'Byte' });

// ---- Settings (remembered per browser) ------------------------------------
for (const id of ['fps', 'density', 'ecl']) {
  const el = $(id);
  const saved = loadSetting(id);
  if (saved && [...el.options].some((o) => o.value === saved)) el.value = saved;
  el.addEventListener('change', () => {
    saveSetting(id, el.value);
    updateEstimate();
  });
}

// ---- Input ----------------------------------------------------------------
for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', () => setMode(tab.dataset.tab));
}

function setMode(mode) {
  state.mode = mode;
  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === mode));
  }
  $('tab-text').hidden = mode !== 'text';
  $('tab-file').hidden = mode !== 'file';
  showError('');
  updateEstimate();
}

$('text-input').addEventListener('input', updateEstimate);
$('text-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) start();
});
$('file-input').addEventListener('change', (e) => pickFile(e.target.files[0]));

const dropzone = $('dropzone');
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('over');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
// Accept a file dropped anywhere on the page.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  const file = e.dataTransfer?.files?.[0];
  if (file) {
    setMode('file');
    pickFile(file);
  }
});
// Accept a pasted file or screenshot.
document.addEventListener('paste', (e) => {
  const file = e.clipboardData?.files?.[0];
  if (file) {
    e.preventDefault();
    setMode('file');
    pickFile(file);
  }
});

function pickFile(file) {
  if (!file) return;
  state.file = file;
  $('file-label').innerHTML = '';
  const name = document.createElement('strong');
  name.textContent = file.name;
  $('file-label').append(name, ` · ${formatBytes(file.size)} · `, Object.assign(document.createElement('u'), { textContent: 'change' }));
  showError(file.size > MAX_FILE_BYTES ? `This file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)}.` : '');
  updateEstimate();
}

function inputSize() {
  if (state.mode === 'text') return new TextEncoder().encode($('text-input').value).length;
  return state.file ? state.file.size : 0;
}

function updateEstimate() {
  const size = inputSize();
  if (!size) {
    $('estimate').textContent = '';
    return;
  }
  const blockSize = Number($('density').value);
  const fps = Number($('fps').value);
  const frames = Math.max(1, Math.ceil((size + 60) / blockSize));
  // Phones miss some frames; ~1.3x is typical when held steady.
  const seconds = Math.max(1, (frames * 1.3) / fps);
  $('estimate').textContent = `About ${frames.toLocaleString()} code${frames > 1 ? 's' : ''} · around ${formatDuration(seconds)} (less if it compresses well)`;
}

// ---- Sending ---------------------------------------------------------------
$('start').addEventListener('click', start);
$('stop').addEventListener('click', stop);
$('pause').addEventListener('click', () => {
  state.paused = !state.paused;
  $('pause').textContent = state.paused ? 'Resume' : 'Pause';
});
$('fullscreen').addEventListener('click', () => {
  const stage = $('stage');
  if (document.fullscreenElement) document.exitFullscreen();
  else (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage);
});

async function start() {
  showError('');
  let input;
  if (state.mode === 'text') {
    const text = $('text-input').value;
    if (!text) return showError('Type or paste some text first.');
    input = { kind: 'text', bytes: new TextEncoder().encode(text), label: `Text · ${[...text].length.toLocaleString()} characters` };
  } else {
    const file = state.file;
    if (!file) return showError('Choose a file first.');
    if (file.size > MAX_FILE_BYTES) return showError(`This file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)}.`);
    input = {
      kind: 'file',
      name: file.name,
      mime: file.type || 'application/octet-stream',
      bytes: new Uint8Array(await file.arrayBuffer()),
      label: file.name,
    };
  }

  $('start').disabled = true;
  try {
    const sent = await buildPayload(input);
    // Same number of blocks as the chosen density, but no wasted padding: short text gets a
    // small, easy-to-scan code. Multiples of 4 keep the XOR fast path.
    const blocks = Math.max(1, Math.ceil(sent.payload.length / Number($('density').value)));
    const blockSize = Math.ceil(sent.payload.length / blocks / 4) * 4;
    stopAnimation();
    state.session = {
      sent,
      blockSize,
      encoder: new LTEncoder(sent.payload, blockSize),
      fps: Number($('fps').value),
      ecl: $('ecl').value,
      seed: 0,
      lastFrameAt: -Infinity,
      label: input.label,
      inputBytes: input.bytes.length,
      version: 0,
    };
    state.paused = false;
    $('pause').textContent = 'Pause';
    $('idle-view').hidden = true;
    $('send-view').hidden = false;
    requestWakeLock();
    state.raf = requestAnimationFrame(tick);
    if (window.matchMedia('(max-width: 860px)').matches) $('stage').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    showError(`Could not prepare the data: ${err.message}`);
  } finally {
    $('start').disabled = false;
  }
}

function tick(now) {
  const s = state.session;
  if (!s) return;
  state.raf = requestAnimationFrame(tick);
  if (state.paused || now - s.lastFrameAt < 1000 / s.fps - 4) return;
  s.lastFrameAt = now;
  const block = s.encoder.block(s.seed++);
  const text = packFrame({ flags: s.sent.flags, id: s.sent.id, length: s.sent.payload.length, blockSize: s.blockSize, ...block });
  s.version = renderQr($('qr'), text, { ecl: s.ecl, mode: 'Alphanumeric' });
  if (s.seed === 1 || s.seed % 6 === 0) updateStats();
}

function updateStats() {
  const s = state.session;
  const K = s.encoder.K;
  const zipped = s.sent.payload.length < s.inputBytes ? ` → ${formatBytes(s.sent.payload.length)} compressed` : '';
  const pass = Math.max(1, (K * 1.3) / s.fps);
  $('stats').replaceChildren(
    line(strong(s.label), ` · ${formatBytes(s.inputBytes)}${zipped}`),
    line(`${K.toLocaleString()} block${K > 1 ? 's' : ''} · QR version ${s.version} · ${s.fps} frames/s · frame ${s.seed.toLocaleString()}`),
    line(`The phone needs about ${K.toLocaleString()} good frame${K > 1 ? 's' : ''} (around ${formatDuration(pass)}). Keep this visible until it says done.`),
  );
}

function line(...parts) {
  const div = document.createElement('div');
  div.append(...parts);
  return div;
}
function strong(text) {
  return Object.assign(document.createElement('strong'), { textContent: text });
}

function stopAnimation() {
  cancelAnimationFrame(state.raf);
  state.session = null;
}

function stop() {
  stopAnimation();
  releaseWakeLock();
  if (document.fullscreenElement) document.exitFullscreen();
  $('send-view').hidden = true;
  $('idle-view').hidden = false;
}

function showError(message) {
  $('input-error').textContent = message;
}

// Keep the screen on while sending (supported in most current browsers).
async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    state.wakeLock = null;
  }
}
function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.session) requestWakeLock();
});
