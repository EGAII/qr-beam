# QR Beam

Send a file or text from one screen to a phone **with only a camera**: no network between
the devices, no app, no pairing, no upload. The sender page shows an animated QR code, and
the receiver page (in the phone's browser) reads it in real time, then lets you **copy the
text** or **download the file**.

- `index.html`: **Send**. Type or paste text, or choose, drop or paste a file (up to 20 MB).
- `receive.html`: **Receive**. Opens the camera, shows progress, then *Copy text*,
  *Open link*, *Download file* or *Share / Save to…*.

Everything runs in the browser. The data never leaves the two devices. The only network
requests are for the two libraries below, from the jsDelivr CDN.

## How to use

1. Open the site on the computer (the **Send** page).
2. Scan the small QR code on that page with the phone's camera app. It opens **Receive**.
3. On the phone, tap **Start camera** and allow camera access.
4. On the computer, enter text or choose a file and press **Start sending**.
5. Point the phone at the animated code so it fills most of the square. When it reaches 100%
   the phone shows the result.

If scanning is slow, lower **QR density** or **Speed** on the sender, turn the screen
brightness up, or use **Full screen**.

## How it works

| Step | What happens | File |
|---|---|---|
| Pack | `meta (type, name, MIME) + bytes`, gzip if it helps, SHA-256 transfer ID | `js/protocol.js` |
| Split | Fountain code (LT): endless stream of blocks; any ~K of them rebuild K blocks | `js/fountain.js` |
| Encode | Each block + 17-byte header → Base45 → QR **alphanumeric** mode | `js/base45.js`, `js/qr-draw.js` |
| Scan | Native `BarcodeDetector` (Android Chrome) or ZXing WebAssembly (iPhone and others) | `js/receive.js` |
| Rebuild | Peeling decoder + Gaussian elimination; checksum; gunzip | `js/fountain.js` |

Why a fountain code: the phone misses frames (blur, glare, rolling shutter) and may start
scanning in the middle. With a fountain code, **which** frames it catches doesn't matter,
only how many. Measured in `test/run-tests.mjs` (30% of frames dropped, late start), up to
600 blocks the phone needs about K + 2 good frames, and above that about 1.2 × K.

Why Base45 + alphanumeric mode instead of binary QR: the native `BarcodeDetector` returns
text only and can mangle binary QR content. Base45 survives every scanner and costs only
~3% more space than binary.

Frame format (`QB1:` + Base45 + `.`):

```
flags u8 | transferId u32 | payloadLength u32 | blockSize u16 | seed u32 | degree u16 | block
```

Rough throughput: the density × speed setting, for example 760 B × 12 frames/s ≈ 9 KB/s
(about 1 MB in 2 minutes). It's best for text, links, small documents and images.

## Run locally

Camera access needs a secure page (`https://` or `localhost`), and ES modules need a server:

```
py -m http.server 8080
```

Then open <http://localhost:8080/>. To test on a phone you need https (GitHub Pages), because
`http://192.168.x.x` is not a secure page and the phone won't allow the camera there.

Tests (Node 20+, no dependencies):

```
node test/run-tests.mjs
```

Add `?zxing` to the receive page URL to force the ZXing scanner even where a native one exists.

## Deploy to GitHub Pages

1. Create a **public** repository on GitHub (Pages on a free plan needs public), for example `qr-beam`.
2. Push this folder:
   ```
   git remote add origin https://github.com/<your-account>/qr-beam.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch →
   Branch: `main` / `(root)` → Save**.
4. After about a minute, the site is at `https://<your-account>.github.io/qr-beam/`.

There's no build step: GitHub Pages serves the files as they are (`.nojekyll` turns off Jekyll).

## Libraries

- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 (MIT): QR encoding.
- [barcode-detector](https://github.com/Sec-ant/barcode-detector) 3.2.3 (MIT): `BarcodeDetector`
  ponyfill on top of [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) (MIT) /
  [ZXing-C++](https://github.com/zxing-cpp/zxing-cpp) (Apache-2.0).

Both are loaded from jsDelivr with pinned versions.

## Limits

- Not encrypted: anyone who can film the screen can read the data. Don't beam secrets in public.
- Files up to 20 MB, held in memory on both sides. Large files take minutes.
- iPhone: use Safari (iOS 16.4+ for gzip support). *Download* opens the iOS download prompt,
  and *Share / Save to…* can save to Photos or Files.
