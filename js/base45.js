// Base45 (RFC 9285): bytes <-> text made only of QR "alphanumeric" characters.
// QR alphanumeric mode packs 2 characters into 11 bits, so base45 costs only ~3% more
// space than raw binary, and every scanner returns the text exactly (raw binary QR codes
// are often mangled by text-only scanners such as the native BarcodeDetector).

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const VALUES = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i;

export function encodeBase45(bytes) {
  const out = [];
  let i = 0;
  for (; i + 1 < bytes.length; i += 2) {
    let n = (bytes[i] << 8) | bytes[i + 1];
    out.push(ALPHABET[n % 45]);
    n = (n / 45) | 0;
    out.push(ALPHABET[n % 45]);
    out.push(ALPHABET[(n / 45) | 0]);
  }
  if (i < bytes.length) {
    const n = bytes[i];
    out.push(ALPHABET[n % 45], ALPHABET[(n / 45) | 0]);
  }
  return out.join('');
}

export function decodeBase45(text) {
  if (text.length % 3 === 1) throw new Error('Invalid base45 length');
  const out = new Uint8Array(Math.floor(text.length / 3) * 2 + (text.length % 3 === 2 ? 1 : 0));
  const value = (k) => {
    const code = text.charCodeAt(k);
    const v = code < 128 ? VALUES[code] : -1;
    if (v < 0) throw new Error('Invalid base45 character');
    return v;
  };
  let o = 0;
  let k = 0;
  for (; k + 2 < text.length; k += 3) {
    const n = value(k) + value(k + 1) * 45 + value(k + 2) * 2025;
    if (n > 0xffff) throw new Error('Invalid base45 triplet');
    out[o++] = n >> 8;
    out[o++] = n & 0xff;
  }
  if (k < text.length) {
    const n = value(k) + value(k + 1) * 45;
    if (n > 0xff) throw new Error('Invalid base45 pair');
    out[o++] = n;
  }
  return out;
}
