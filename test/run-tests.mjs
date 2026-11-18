// Run with: node test/run-tests.mjs
// Checks base45, the LT fountain code (with frame loss and late start), and the full
// sender -> QR text -> receiver pipeline without a camera.

import assert from 'node:assert/strict';
import { decodeBase45, encodeBase45 } from '../js/base45.js';
import { LTDecoder, LTEncoder } from '../js/fountain.js';
import { buildPayload, openPayload, packFrame, parseFrame } from '../js/protocol.js';

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${err.stack}`);
  }
}

// Small seeded RNG so failures are reproducible.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
function randomBytes(n, rand) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (rand() * 256) | 0;
  return out;
}

/** Simulate a camera that joins late and misses `loss` of the frames. Returns frames read. */
function simulate(data, blockSize, { loss, startSeed, rand, options }) {
  const enc = new LTEncoder(data, blockSize, options);
  const dec = new LTDecoder(enc.K, blockSize);
  let seed = startSeed;
  let read = 0;
  while (!dec.done) {
    const block = enc.block(seed++);
    if (rand() < loss) continue;
    dec.add(block.seed, block.degree, block.data);
    read++;
    if (read > enc.K * 20 + 100) throw new Error(`no convergence K=${enc.K}`);
  }
  assert.deepEqual(dec.result(data.length), data);
  return { read, K: enc.K };
}

await test('base45 matches RFC 9285 examples', () => {
  const enc = (s) => encodeBase45(new TextEncoder().encode(s));
  assert.equal(enc('AB'), 'BB8');
  assert.equal(enc('Hello!!'), '%69 VD92EX0');
  assert.equal(enc('ietf!'), 'QED8WEX0');
  assert.equal(new TextDecoder().decode(decodeBase45('QED8WEX0')), 'ietf!');
});

await test('base45 round-trips random bytes and rejects bad input', () => {
  const rand = rng(7);
  for (let n = 0; n < 300; n++) {
    const bytes = randomBytes(n, rand);
    assert.deepEqual(decodeBase45(encodeBase45(bytes)), bytes);
  }
  assert.throws(() => decodeBase45('AB'.slice(0, 1)));
  assert.throws(() => decodeBase45('abc'));
  assert.throws(() => decodeBase45(':::'));
});

await test('fountain code rebuilds data with 30% loss and a late start', () => {
  const rand = rng(42);
  const rows = [];
  for (const K of [1, 2, 3, 5, 10, 40, 150, 600, 2500]) {
    const trials = K >= 600 ? 6 : 25;
    const ratios = [];
    for (let t = 0; t < trials; t++) {
      const blockSize = 64;
      const data = randomBytes(K * blockSize - ((rand() * blockSize) | 0), rand);
      const late = t % 2 === 1; // half the trials join after the systematic blocks have passed
      const startSeed = late ? K + ((rand() * 1000) | 0) : 0;
      const { read } = simulate(data, blockSize, { loss: 0.3, startSeed, rand });
      ratios.push(read / K);
    }
    ratios.sort((a, b) => a - b);
    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    rows.push(`K=${String(K).padStart(4)}  avg ${avg.toFixed(2)}x  worst ${ratios.at(-1).toFixed(2)}x`);
  }
  console.log('     frames needed / K (on-time and late joins):\n     ' + rows.join('\n     '));
});

await test('protocol: Japanese text survives QR text frames', async () => {
  const text = '日本語のテキスト、絵文字 🎉 と改行\nsecond line\t tab '.repeat(30);
  const sent = await buildPayload({ kind: 'text', bytes: new TextEncoder().encode(text) });
  const got = await transfer(sent, 300, rng(1));
  assert.equal(got.kind, 'text');
  assert.equal(new TextDecoder().decode(got.bytes), text);
});

await test('protocol: 200 KB binary file keeps name, type and bytes', async () => {
  const bytes = randomBytes(200_000, rng(3));
  const sent = await buildPayload({ kind: 'file', name: 'photo 写真.jpg', mime: 'image/jpeg', bytes });
  assert.equal(sent.flags, 0, 'random data should not be gzipped');
  const got = await transfer(sent, 800, rng(5));
  assert.equal(got.name, 'photo 写真.jpg');
  assert.equal(got.mime, 'image/jpeg');
  assert.deepEqual(got.bytes, bytes);
});

await test('protocol: compressible file is gzipped', async () => {
  const bytes = new TextEncoder().encode('id,name,tel\n' + '1,Example Co.,03-0000-0000\n'.repeat(2000));
  const sent = await buildPayload({ kind: 'file', name: 'list.csv', mime: 'text/csv', bytes });
  assert.equal(sent.flags & 1, 1);
  const got = await transfer(sent, 450, rng(9));
  assert.deepEqual(got.bytes, bytes);
});

await test('protocol: ignores foreign QR codes and corrupted frames', async () => {
  assert.equal(parseFrame('https://example.com'), null);
  assert.equal(parseFrame('QB1:ABC'), null);
  const sent = await buildPayload({ kind: 'text', bytes: new TextEncoder().encode('hello') });
  const enc = new LTEncoder(sent.payload, 100);
  const text = packFrame({ ...frameFields(sent, 100), ...enc.block(0) });
  assert.ok(parseFrame(text));
  assert.equal(parseFrame(text.slice(0, -4) + 'a' + text.slice(-3)), null);
  assert.equal(parseFrame(text.slice(0, -1)), null);
  await assert.rejects(openPayload(sent.payload, sent.flags, sent.id ^ 1), /Checksum/);
});

function frameFields(sent, blockSize) {
  return { flags: sent.flags, id: sent.id, length: sent.payload.length, blockSize };
}

/** Full pipeline: payload -> frame strings (with loss) -> parseFrame -> decoder -> payload. */
async function transfer(sent, blockSize, rand) {
  const enc = new LTEncoder(sent.payload, blockSize);
  let dec = null;
  for (let seed = 0; ; seed++) {
    const text = packFrame({ ...frameFields(sent, blockSize), ...enc.block(seed) });
    if (rand() < 0.25) continue;
    const f = parseFrame(text);
    assert.ok(f, 'frame should parse');
    dec ??= new LTDecoder(Math.ceil(f.length / f.blockSize), f.blockSize);
    dec.add(f.seed, f.degree, f.data);
    if (dec.done) return openPayload(dec.result(f.length), f.flags, f.id);
    if (seed > enc.K * 20 + 100) throw new Error('no convergence');
  }
}

console.log(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
process.exit(failures ? 1 : 0);
