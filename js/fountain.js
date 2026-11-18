// LT (Luby Transform) fountain code.
//
// The sender turns the data into K source blocks and can then produce an endless stream
// of encoded blocks. Encoded block `seed` is the XOR of a few source blocks chosen by a
// seeded random generator. The receiver can rebuild the data from roughly K * 1.1-1.3
// encoded blocks, received in any order, so missed or blurry QR frames only cost time.
//
// Seeds 0..K-1 are "systematic": block i is just source block i. Later seeds are mixes:
// dense random mixes when K <= 600 (solved by Gaussian elimination, ~K+2 frames needed),
// sparse robust-soliton mixes for bigger transfers (solved by peeling, ~1.1-1.2 K frames).
// The degree (how many blocks are mixed) travels in each frame, and the choice of blocks
// uses integer-only math, so every browser and phone reconstructs exactly the same set.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function mix(seed, salt) {
  let h = (seed ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Source-block indices that are XORed together in encoded block `seed`. */
export function neighbors(seed, degree, K) {
  if (seed < K) return [seed];
  if (degree >= K) return Array.from({ length: K }, (_, i) => i);
  const next = mulberry32(mix(seed, 0x51a3c0de));
  if (degree * 3 >= K) {
    // Dense pick: partial Fisher-Yates shuffle.
    const all = Array.from({ length: K }, (_, i) => i);
    for (let i = 0; i < degree; i++) {
      const j = i + (next() % (K - i));
      const tmp = all[i];
      all[i] = all[j];
      all[j] = tmp;
    }
    return all.slice(0, degree);
  }
  const picked = new Set();
  while (picked.size < degree) picked.add(next() % K);
  return [...picked];
}

/** Cumulative robust soliton distribution over degrees 1..K (index 0 unused). */
export function robustSolitonCdf(K, c = 0.05, delta = 0.5) {
  const cdf = new Float64Array(K + 1);
  if (K === 1) {
    cdf[1] = 1;
    return cdf;
  }
  const R = c * Math.log(K / delta) * Math.sqrt(K);
  const pivot = Math.min(K, Math.max(1, Math.floor(K / R)));
  const p = new Float64Array(K + 1);
  p[1] = 1 / K;
  for (let d = 2; d <= K; d++) p[d] = 1 / (d * (d - 1));
  for (let d = 1; d < pivot; d++) p[d] += R / (d * K);
  p[pivot] += Math.max(0, (R * Math.log(R / delta)) / K);
  let sum = 0;
  for (let d = 1; d <= K; d++) sum += p[d];
  let acc = 0;
  for (let d = 1; d <= K; d++) {
    acc += p[d] / sum;
    cdf[d] = acc;
  }
  cdf[K] = 1;
  return cdf;
}

function sampleDegree(cdf, u) {
  let lo = 1;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] >= u) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function xorInto(target, source) {
  if (target.length % 4 === 0 && target.byteOffset % 4 === 0 && source.byteOffset % 4 === 0) {
    const t = new Uint32Array(target.buffer, target.byteOffset, target.length / 4);
    const s = new Uint32Array(source.buffer, source.byteOffset, target.length / 4);
    for (let i = 0; i < t.length; i++) t[i] ^= s[i];
    return;
  }
  for (let i = 0; i < target.length; i++) target[i] ^= source[i];
}

// Above this many unknown blocks, Gaussian elimination is too slow on a phone and the
// decoder relies on peeling alone (which is already efficient for large transfers).
const MAX_ELIMINATION_UNKNOWNS = 600;

/** Gauss-Jordan elimination over GF(2). rows[c] ends up holding unknown c. */
function eliminate(rows, unknowns, words, withData) {
  for (let c = 0; c < unknowns; c++) {
    const word = c >>> 5;
    const mask = 1 << (c & 31);
    let pivot = -1;
    for (let r = c; r < rows.length; r++) {
      if (rows[r].bits[word] & mask) {
        pivot = r;
        break;
      }
    }
    if (pivot < 0) return false;
    const pr = rows[pivot];
    rows[pivot] = rows[c];
    rows[c] = pr;
    for (let r = 0; r < rows.length; r++) {
      if (r === c || !(rows[r].bits[word] & mask)) continue;
      const bits = rows[r].bits;
      for (let w = word; w < words; w++) bits[w] ^= pr.bits[w];
      if (withData) xorInto(rows[r].data, pr.data);
    }
  }
  return true;
}

export class LTEncoder {
  constructor(data, blockSize, options = {}) {
    this.blockSize = blockSize;
    this.K = Math.max(1, Math.ceil(data.length / blockSize));
    this.blocks = [];
    for (let i = 0; i < this.K; i++) {
      const block = new Uint8Array(blockSize);
      block.set(data.subarray(i * blockSize, (i + 1) * blockSize));
      this.blocks.push(block);
    }
    this.cdf = robustSolitonCdf(this.K, options.c, options.delta);
  }

  degreeFor(seed) {
    if (seed < this.K) return 1;
    const next = mulberry32(mix(seed, 0x0d3e6ee5));
    if (this.K <= MAX_ELIMINATION_UNKNOWNS) {
      // Small/medium transfers: dense random mixes (each block in with probability 1/2).
      // The receiver solves them by elimination after about K + 2 frames.
      let degree = 0;
      for (let i = 0; i < this.K; i++) degree += next() & 1;
      return Math.max(1, degree);
    }
    // Large transfers: sparse robust-soliton mixes that the cheap peeling decoder handles.
    return sampleDegree(this.cdf, next() / 4294967296);
  }

  block(seed) {
    const degree = this.degreeFor(seed);
    const data = new Uint8Array(this.blockSize);
    for (const i of neighbors(seed, degree, this.K)) xorInto(data, this.blocks[i]);
    return { seed, degree, data };
  }
}

export class LTDecoder {
  constructor(K, blockSize) {
    this.K = K;
    this.blockSize = blockSize;
    this.source = new Array(K).fill(null);
    this.solved = 0;
    this.received = 0;
    this.stored = 0; // useful mixed blocks not solved yet
    this.seen = new Set();
    this.waiting = new Map(); // source index -> Set of packets still needing it
  }

  get done() {
    return this.solved === this.K;
  }

  /** Rough 0..1 progress: blocks solved plus useful mixes waiting to be solved. */
  get progress() {
    return this.done ? 1 : Math.min(0.99, (this.solved + this.stored) / this.K);
  }

  /** Feed one encoded block. Returns true if it was new. */
  add(seed, degree, data) {
    if (this.done || this.seen.has(seed) || data.length !== this.blockSize) return false;
    this.seen.add(seed);
    this.received++;
    const buf = Uint8Array.from(data);
    const pending = new Set();
    for (const i of neighbors(seed, degree, this.K)) {
      if (this.source[i]) xorInto(buf, this.source[i]);
      else pending.add(i);
    }
    if (pending.size === 0) return true;
    if (pending.size === 1) {
      this._solve(pending.values().next().value, buf);
    } else {
      const packet = { pending, data: buf };
      this.stored++;
      for (const i of pending) {
        let set = this.waiting.get(i);
        if (!set) this.waiting.set(i, (set = new Set()));
        set.add(packet);
      }
    }
    if (!this.done && this.received >= this.K) this._tryEliminate();
    return true;
  }

  /** Peeling is stuck but we may already hold enough blocks: solve the rest as a linear system. */
  _tryEliminate() {
    const unknown = [];
    const column = new Map();
    for (let i = 0; i < this.K; i++) {
      if (!this.source[i]) {
        column.set(i, unknown.length);
        unknown.push(i);
      }
    }
    const U = unknown.length;
    if (U === 0 || U > MAX_ELIMINATION_UNKNOWNS) return;
    const packets = new Set();
    for (const set of this.waiting.values()) for (const p of set) packets.add(p);
    if (packets.size < U) return;

    const words = (U + 31) >>> 5;
    const rows = [...packets].map((p) => {
      const bits = new Uint32Array(words);
      for (const i of p.pending) {
        const c = column.get(i);
        bits[c >>> 5] |= 1 << (c & 31);
      }
      return { bits, data: p.data };
    });
    // Cheap rank check on the bit matrix first; touch the block data only if it will succeed.
    const probe = rows.map((r) => ({ bits: r.bits.slice() }));
    if (!eliminate(probe, U, words, false)) return;
    eliminate(rows, U, words, true);
    for (let c = 0; c < U; c++) this.source[unknown[c]] = rows[c].data;
    this.solved = this.K;
    this.stored = 0;
    this.waiting.clear();
  }

  _solve(index, data) {
    const stack = [[index, data]];
    while (stack.length) {
      const [i, d] = stack.pop();
      if (this.source[i]) continue;
      this.source[i] = d;
      this.solved++;
      const packets = this.waiting.get(i);
      if (!packets) continue;
      this.waiting.delete(i);
      for (const p of packets) {
        xorInto(p.data, d);
        p.pending.delete(i);
        if (p.pending.size === 1) {
          const j = p.pending.values().next().value;
          this.waiting.get(j)?.delete(p);
          this.stored--;
          stack.push([j, p.data]);
        }
      }
    }
  }

  /** The rebuilt data, trimmed to `length` bytes. Only valid when `done`. */
  result(length) {
    const out = new Uint8Array(this.K * this.blockSize);
    this.source.forEach((block, i) => out.set(block, i * this.blockSize));
    return out.subarray(0, length);
  }
}
