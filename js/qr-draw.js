import qrcode from 'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.mjs';

const QUIET_ZONE = 4; // modules of white border the QR standard asks for

/**
 * Draw `text` as a QR code into `canvas` at 1 pixel per module; CSS scales it up with
 * `image-rendering: pixelated`, which keeps the edges sharp at any screen size.
 * Returns the QR version (1-40).
 */
export function renderQr(canvas, text, { ecl = 'L', mode = 'Byte' } = {}) {
  const qr = qrcode(0, ecl);
  qr.addData(text, mode);
  qr.make();
  const n = qr.getModuleCount();
  const size = n + QUIET_ZONE * 2;
  if (canvas.width !== size) {
    canvas.width = size;
    canvas.height = size;
  }
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  const px = new Uint32Array(image.data.buffer);
  px.fill(0xffffffff); // white, opaque
  for (let r = 0; r < n; r++) {
    const row = (r + QUIET_ZONE) * size + QUIET_ZONE;
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) px[row + c] = 0xff000000; // black, opaque
  }
  ctx.putImageData(image, 0, 0);
  return (n - 17) / 4;
}
