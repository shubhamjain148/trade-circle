/**
 * A minimal QR encoder — byte mode, error-correction level M, versions 1–10.
 *
 * Vendored rather than depended on. The whole need is "turn a 90-character URL
 * into a square a phone camera can read", offline, with no network fetch and no
 * canvas; every package that does this ships forty versions, four ECC levels,
 * Kanji mode and a renderer, which is a lot of surface for one settings panel.
 *
 * Algorithm (and the structure of this file) follows Project Nayuki's QR Code
 * generator library, MIT licensed:
 *   https://www.nayuki.io/page/qr-code-generator-library
 *   Copyright (c) Project Nayuki. MIT License.
 * This is an independent TypeScript implementation of that algorithm, cut down
 * to the one mode and one ECC level this app uses.
 *
 * ECC level M (~15% recovery) is the usual choice for a URL on a screen: L is
 * thinner than a phone camera at an angle wants, and Q/H buy robustness we do
 * not need by making the modules smaller, which costs more than it buys.
 */

/** Error-correction codewords per block, level M, indexed by version. */
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26] as const;
/** Number of error-correction blocks, level M, indexed by version. */
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5] as const;

const MIN_VERSION = 1;
const MAX_VERSION = 10;

/** Level M's two-bit code, as it appears in the format information. */
const ECC_FORMAT_BITS = 0b00;

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/**
 * `matrix[y][x]` — true is a dark module. Includes no quiet zone; the renderer
 * adds it, because the quiet zone is padding and padding is a layout decision.
 *
 * Throws only if the text cannot fit in version 10 (~200 bytes), which for the
 * link this app encodes cannot happen.
 */
export function encodeQr(text: string): boolean[][] {
  const data = new TextEncoder().encode(text);
  const version = chooseVersion(data.length);
  const codewords = addEccAndInterleave(encodeData(data, version), version);
  return draw(codewords, version);
}

function chooseVersion(byteLength: number): number {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    // 4 bits of mode indicator + the character count field.
    const headerBits = 4 + (version < 10 ? 8 : 16);
    if (headerBits + byteLength * 8 <= dataCodewords(version) * 8) return version;
  }
  throw new Error(`qr: ${byteLength} bytes is too long to encode`);
}

/** Total codewords in the symbol, data and error correction together. */
function rawCodewords(version: number): number {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    modules -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) modules -= 36;
  }
  return Math.floor(modules / 8);
}

function dataCodewords(version: number): number {
  return rawCodewords(version) - ECC_PER_BLOCK[version] * NUM_BLOCKS[version];
}

/** Mode indicator, length, payload, terminator, pad — as a byte array. */
function encodeData(data: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(data.length, version < 10 ? 8 : 16);
  for (const byte of data) push(byte, 8);

  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length)); // terminator
  push(0, (8 - (bits.length % 8)) % 8); // to a byte boundary

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  // The standard's alternating pad bytes, to the end of the data capacity.
  for (let pad = 0xec; codewords.length < dataCodewords(version); pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return codewords;
}

/** Splits into blocks, appends each block's ECC, and interleaves the lot. */
function addEccAndInterleave(data: number[], version: number): number[] {
  const numBlocks = NUM_BLOCKS[version];
  const eccLen = ECC_PER_BLOCK[version];
  const total = rawCodewords(version);
  const numShort = numBlocks - (total % numBlocks);
  const shortLen = Math.floor(total / numBlocks);
  const divisor = reedSolomonDivisor(eccLen);

  const blocks: number[][] = [];
  for (let i = 0, offset = 0; i < numBlocks; i++) {
    const length = shortLen - eccLen + (i < numShort ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    const ecc = reedSolomonRemainder(block, divisor);
    // Short blocks carry a placeholder so every block is the same length while
    // interleaving; it is skipped on the way out.
    if (i < numShort) block.push(0);
    blocks.push(block.concat(ecc));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]);
    });
  }
  return result;
}

/** Multiplication in GF(2^8) modulo the QR primitive polynomial x^8+x^4+x^3+x^2+1. */
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

function draw(codewords: number[], version: number): boolean[][] {
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const isFunction: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );

  const set = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  // Timing patterns.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Finders, with their separators.
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          set(x, y, distance !== 2 && distance !== 4);
        }
      }
    }
  }

  // Alignment patterns, minus the three that would sit on a finder.
  const align = alignmentPositions(version, size);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === align.length - 1) ||
        (i === align.length - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Format information is reserved now and written for real once a mask is
  // chosen; version information is fixed and can go in immediately.
  drawFormat(set, size, 0);
  if (version >= 7) drawVersion(set, size, version);

  // Data, in the two-module-wide zigzag from the bottom right.
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bit < codewords.length * 8) {
          modules[y][x] = ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) !== 0;
          bit++;
        }
      }
    }
  }

  // Try all eight masks, keep the least ugly. Any mask is readable; the score
  // is about how well a camera copes with the result.
  let best = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, isFunction, mask);
    drawFormat(set, size, mask);
    const penalty = penaltyScore(modules, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = mask;
    }
    applyMask(modules, isFunction, mask); // XOR is its own undo
  }
  applyMask(modules, isFunction, best);
  drawFormat(set, size, best);

  return modules;
}

function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  // Even spacing between the outermost centres, rounded up to an even number of
  // modules: 6 … size-7. (Below version 7 there are only two, so step is moot.)
  const step = Math.ceil((size - 13) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

type Setter = (x: number, y: number, dark: boolean) => void;

function drawFormat(set: Setter, size: number, mask: number) {
  const data = (ECC_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;

  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));

  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // the always-dark module
}

function drawVersion(set: Setter, size: number, version: number) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    set(a, b, dark);
    set(b, a, dark);
  }
}

function applyMask(modules: boolean[][], isFunction: boolean[][], mask: number) {
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFunction[y][x]) continue;
      let invert: boolean;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (invert) modules[y][x] = !modules[y][x];
    }
  }
}

/** The standard's four ugliness rules; lower is better. */
function penaltyScore(modules: boolean[][], size: number): number {
  let result = 0;

  for (let y = 0; y < size; y++) {
    let runColor = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let x = 0; x < size; x++) {
      if (modules[y][x] === runColor) {
        runLength++;
        if (runLength === 5) result += PENALTY_N1;
        else if (runLength > 5) result++;
      } else {
        addRunToHistory(runLength, history, size);
        if (!runColor) result += countFinderLikePatterns(history) * PENALTY_N3;
        runColor = modules[y][x];
        runLength = 1;
      }
    }
    result += terminateRun(runColor, runLength, history, size) * PENALTY_N3;
  }

  for (let x = 0; x < size; x++) {
    let runColor = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let y = 0; y < size; y++) {
      if (modules[y][x] === runColor) {
        runLength++;
        if (runLength === 5) result += PENALTY_N1;
        else if (runLength > 5) result++;
      } else {
        addRunToHistory(runLength, history, size);
        if (!runColor) result += countFinderLikePatterns(history) * PENALTY_N3;
        runColor = modules[y][x];
        runLength = 1;
      }
    }
    result += terminateRun(runColor, runLength, history, size) * PENALTY_N3;
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const colour = modules[y][x];
      if (
        colour === modules[y][x + 1] &&
        colour === modules[y + 1][x] &&
        colour === modules[y + 1][x + 1]
      ) {
        result += PENALTY_N2;
      }
    }
  }

  let dark = 0;
  for (const row of modules) for (const module of row) if (module) dark++;
  const total = size * size;
  const skew = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return result + skew * PENALTY_N4;
}

function addRunToHistory(runLength: number, history: number[], size: number) {
  if (history[0] === 0) runLength += size; // the light border before the first run
  history.pop();
  history.unshift(runLength);
}

function terminateRun(
  runColor: boolean,
  runLength: number,
  history: number[],
  size: number,
): number {
  if (runColor) {
    addRunToHistory(runLength, history, size);
    runLength = 0;
  }
  addRunToHistory(runLength + size, history, size);
  return countFinderLikePatterns(history);
}

/** The 1:1:3:1:1 ratio a decoder mistakes for a finder. */
function countFinderLikePatterns(history: number[]): number {
  const n = history[1];
  const core =
    n > 0 &&
    history[2] === n &&
    history[3] === n * 3 &&
    history[4] === n &&
    history[5] === n;
  return (
    (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
    (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
  );
}
