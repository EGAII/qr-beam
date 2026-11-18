// Wire format shared by the sender and the receiver.
//
// Payload  = gzip?( uint32 metaLength | meta JSON {k: "text"|"file", n: name, m: mime} | bytes )
// Frame    = "QB1:" + base45( header | encoded block ) + "."
// Header   = flags u8 | transferId u32 | payloadLength u32 | blockSize u16 | seed u32 | degree u16
//
// transferId is the first 4 bytes of SHA-256(payload): it tells transfers apart and is
// checked again once the payload is rebuilt. The trailing "." guards against scanners
// that trim a final space (space is a base45 character).

import { decodeBase45, encodeBase45 } from './base45.js';

export const PREFIX = 'QB1:';
export const SUFFIX = '.';
export const HEADER_SIZE = 17;
export const FLAG_GZIP = 1;

export function packFrame({ flags, id, length, blockSize, seed, degree, data }) {
  const buf = new Uint8Array(HEADER_SIZE + data.length);
  const view = new DataView(buf.buffer);
  view.setUint8(0, flags);
  view.setUint32(1, id);
  view.setUint32(5, length);
  view.setUint16(9, blockSize);
  view.setUint32(11, seed);
  view.setUint16(15, degree);
  buf.set(data, HEADER_SIZE);
  return PREFIX + encodeBase45(buf) + SUFFIX;
}

/** Parse scanned QR text. Returns null for anything that is not one of our frames. */
export function parseFrame(text) {
  if (typeof text !== 'string' || !text.startsWith(PREFIX) || !text.endsWith(SUFFIX)) return null;
  let buf;
  try {
    buf = decodeBase45(text.slice(PREFIX.length, -SUFFIX.length));
  } catch {
    return null;
  }
  if (buf.length <= HEADER_SIZE) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const frame = {
    flags: view.getUint8(0),
    id: view.getUint32(1),
    length: view.getUint32(5),
    blockSize: view.getUint16(9),
    seed: view.getUint32(11),
    degree: view.getUint16(15),
    data: buf.subarray(HEADER_SIZE),
  };
  if (frame.data.length !== frame.blockSize || frame.length === 0 || frame.degree === 0) return null;
  return frame;
}

export async function buildPayload({ kind, name = '', mime = '', bytes }) {
  const meta = new TextEncoder().encode(JSON.stringify({ k: kind, n: name, m: mime }));
  const container = new Uint8Array(4 + meta.length + bytes.length);
  new DataView(container.buffer).setUint32(0, meta.length);
  container.set(meta, 4);
  container.set(bytes, 4 + meta.length);

  let payload = container;
  let flags = 0;
  if (typeof CompressionStream === 'function') {
    const zipped = await transform(container, new CompressionStream('gzip'));
    if (zipped.length < container.length * 0.97) {
      payload = zipped;
      flags |= FLAG_GZIP;
    }
  }
  return { payload, flags, id: await transferId(payload) };
}

export async function openPayload(payload, flags, id) {
  if ((await transferId(payload)) !== id) throw new Error('Checksum mismatch. Please scan again.');
  const container = flags & FLAG_GZIP ? await transform(payload, new DecompressionStream('gzip')) : payload;
  const metaLength = new DataView(container.buffer, container.byteOffset).getUint32(0);
  const meta = JSON.parse(new TextDecoder().decode(container.subarray(4, 4 + metaLength)));
  return { kind: meta.k, name: meta.n, mime: meta.m, bytes: container.subarray(4 + metaLength) };
}

export async function transferId(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return ((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0;
}

async function transform(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
