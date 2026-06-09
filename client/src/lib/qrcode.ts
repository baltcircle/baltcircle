// Minimal, dependency-free QR Code generator (byte mode).
//
// Produces a boolean module matrix for a short payload (a bike URL or code),
// which the UI renders as crisp SVG. Scope is deliberately small: byte-mode
// encoding, error-correction level M, automatic version selection up to the
// size a station label needs. This avoids pulling a runtime dependency just to
// draw a few QR codes in the admin panel.
//
// Adapted from the public-domain "QR Code generator" reference algorithm
// (Project Nayuki), trimmed to byte mode + the pieces we use.

type Ecc = { ordinal: number; formatBits: number };
const ECC_MEDIUM: Ecc = { ordinal: 1, formatBits: 0 };

// ---- Galois field arithmetic for Reed–Solomon ----
function reedSolomonMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function reedSolomonComputeDivisor(degree: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < degree - 1; i++) result.push(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonComputeRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < result.length; i++) {
      result[i] ^= reedSolomonMultiply(divisor[i], factor);
    }
  }
  return result;
}

// ---- Per-version error-correction parameters for ECC level M ----
const ECC_CODEWORDS_PER_BLOCK_M = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
];
const NUM_ERROR_CORRECTION_BLOCKS_M = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
];

function getNumRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function getNumDataCodewords(ver: number): number {
  const totalCodewords = Math.floor(getNumRawDataModules(ver) / 8);
  const eccPerBlock = ECC_CODEWORDS_PER_BLOCK_M[ver];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_M[ver];
  return totalCodewords - eccPerBlock * numBlocks;
}

// ---- Bit buffer ----
function appendBits(val: number, len: number, bb: number[]): void {
  for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
}

// ---- Matrix construction ----
class Matrix {
  size: number;
  modules: boolean[][];
  isFunction: boolean[][];
  constructor(ver: number) {
    this.size = ver * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.isFunction = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
  }
  setFunctionModule(x: number, y: number, isDark: boolean): void {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  }
}

function drawFinder(m: Matrix, x: number, y: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && xx < m.size && yy >= 0 && yy < m.size) {
        m.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }
}

function drawAlignment(m: Matrix, x: number, y: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      m.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function getAlignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

function drawFormatBits(m: Matrix, mask: number): void {
  const data = (ECC_MEDIUM.formatBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  for (let i = 0; i <= 5; i++) m.setFunctionModule(8, i, ((bits >>> i) & 1) !== 0);
  m.setFunctionModule(8, 7, ((bits >>> 6) & 1) !== 0);
  m.setFunctionModule(8, 8, ((bits >>> 7) & 1) !== 0);
  m.setFunctionModule(7, 8, ((bits >>> 8) & 1) !== 0);
  for (let i = 9; i < 15; i++) m.setFunctionModule(14 - i, 8, ((bits >>> i) & 1) !== 0);
  for (let i = 0; i < 8; i++) m.setFunctionModule(m.size - 1 - i, 8, ((bits >>> i) & 1) !== 0);
  for (let i = 8; i < 15; i++) m.setFunctionModule(8, m.size - 15 + i, ((bits >>> i) & 1) !== 0);
  m.setFunctionModule(8, m.size - 8, true);
}

function drawFunctionPatterns(m: Matrix, ver: number): void {
  for (let i = 0; i < m.size; i++) {
    m.setFunctionModule(6, i, i % 2 === 0);
    m.setFunctionModule(i, 6, i % 2 === 0);
  }
  drawFinder(m, 3, 3);
  drawFinder(m, m.size - 4, 3);
  drawFinder(m, 3, m.size - 4);

  const alignPos = getAlignmentPositions(ver);
  const n = alignPos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      drawAlignment(m, alignPos[i], alignPos[j]);
    }
  }
  drawFormatBits(m, 0);
}

function drawCodewords(m: Matrix, data: number[]): void {
  let i = 0;
  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < m.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? m.size - 1 - vert : vert;
        if (!m.isFunction[y][x] && i < data.length * 8) {
          m.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

function applyMask(m: Matrix, mask: number): void {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.isFunction[y][x]) continue;
      let invert = false;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (invert) m.modules[y][x] = !m.modules[y][x];
    }
  }
}

function penaltyScore(m: Matrix): number {
  let result = 0;
  const size = m.size;
  // Adjacent runs in rows/columns.
  for (let y = 0; y < size; y++) {
    let runColor = false;
    let runLen = 0;
    for (let x = 0; x < size; x++) {
      if (m.modules[y][x] === runColor) {
        runLen++;
        if (runLen === 5) result += 3;
        else if (runLen > 5) result++;
      } else {
        runColor = m.modules[y][x];
        runLen = 1;
      }
    }
  }
  for (let x = 0; x < size; x++) {
    let runColor = false;
    let runLen = 0;
    for (let y = 0; y < size; y++) {
      if (m.modules[y][x] === runColor) {
        runLen++;
        if (runLen === 5) result += 3;
        else if (runLen > 5) result++;
      } else {
        runColor = m.modules[y][x];
        runLen = 1;
      }
    }
  }
  // 2x2 blocks.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m.modules[y][x];
      if (c === m.modules[y][x + 1] && c === m.modules[y + 1][x] && c === m.modules[y + 1][x + 1]) {
        result += 3;
      }
    }
  }
  return result;
}

function addEccAndInterleave(data: number[], ver: number): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_M[ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK_M[ver];
  const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  const rsDiv = reedSolomonComputeDivisor(blockEccLen);
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    const ecc = reedSolomonComputeRemainder(dat, rsDiv);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result.push(blocks[j][i]);
      }
    }
  }
  return result;
}

/** Encode `text` (UTF-8 byte mode) into a square module matrix (true = dark). */
export function encodeQr(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);

  // Pick the smallest version (1..20) whose data capacity fits.
  let version = 1;
  for (; version <= 20; version++) {
    const capacityBits = getNumDataCodewords(version) * 8;
    const charCountBits = version <= 9 ? 8 : 16;
    const usedBits = 4 + charCountBits + bytes.length * 8;
    if (usedBits <= capacityBits) break;
  }
  if (version > 20) throw new Error("Данные слишком длинные для QR");

  const bb: number[] = [];
  appendBits(0x4, 4, bb); // byte mode
  appendBits(bytes.length, version <= 9 ? 8 : 16, bb);
  for (let i = 0; i < bytes.length; i++) appendBits(bytes[i], 8, bb);

  const dataCapacityBits = getNumDataCodewords(version) * 8;
  appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
  appendBits(0, (8 - (bb.length % 8)) % 8, bb);
  for (let padByte = 0xec; bb.length < dataCapacityBits; padByte ^= 0xec ^ 0x11) {
    appendBits(padByte, 8, bb);
  }

  const dataCodewords: number[] = [];
  for (let i = 0; i < bb.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bb[i + j];
    dataCodewords.push(byte);
  }

  const allCodewords = addEccAndInterleave(dataCodewords, version);

  // Build matrix, try all masks, keep the lowest-penalty one.
  let best: Matrix | null = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = new Matrix(version);
    drawFunctionPatterns(m, version);
    drawCodewords(m, allCodewords);
    drawFormatBits(m, mask);
    applyMask(m, mask);
    const penalty = penaltyScore(m);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = m;
    }
  }
  return best!.modules;
}

/** Render an encoded matrix as an SVG string with a quiet zone. */
export function qrToSvg(text: string, opts?: { size?: number; quiet?: number }): string {
  const modules = encodeQr(text);
  const count = modules.length;
  const quiet = opts?.quiet ?? 4;
  const dim = count + quiet * 2;
  const px = opts?.size ?? 256;

  let path = "";
  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) {
      if (modules[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">`,
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/>`,
    `<path d="${path}" fill="#000000"/>`,
    `</svg>`,
  ].join("");
}
