/**
 * 零依赖 QR 码编码器（byte 模式 / 纠错等级 L / 版本 1–10）。
 *
 * 只为「B 站扫码登录」这个用途写的：把 login URL 编成二维码，前端直接画成 SVG，
 * 不引外部库、不走第三方二维码服务（登录 key 不该离开本机）。
 *
 * 已与 Python `qrcode` 库逐格比对（见 test/qr-verify）。
 */

/* ── GF(256) ─────────────────────────────────────────────────────────── */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a, b) {
  return a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0;
}

/** 生成多项式 g(x) = ∏(x - α^i)，高次在前。 */
function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

/* ── 版本表（纠错等级 L） ─────────────────────────────────────────────── */

const VERSIONS = {
  1:  { ec: 7,  blocks: [[1, 19]] },
  2:  { ec: 10, blocks: [[1, 34]] },
  3:  { ec: 15, blocks: [[1, 55]] },
  4:  { ec: 20, blocks: [[1, 80]] },
  5:  { ec: 26, blocks: [[1, 108]] },
  6:  { ec: 18, blocks: [[2, 68]] },
  7:  { ec: 20, blocks: [[2, 78]] },
  8:  { ec: 24, blocks: [[2, 97]] },
  9:  { ec: 30, blocks: [[2, 116]] },
  10: { ec: 18, blocks: [[2, 68], [2, 69]] },
};

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const dataCapacity = (v) => VERSIONS[v].blocks.reduce((a, [n, d]) => a + n * d, 0);

/* ── 位流 ────────────────────────────────────────────────────────────── */

function toBytes(text) {
  return new TextEncoder().encode(text);
}

function buildCodewords(bytes, version) {
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };

  const capBits = dataCapacity(version) * 8;
  push(0b0100, 4);                 // byte 模式
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  // 终止符 + 补齐到字节
  const term = Math.min(4, capBits - bits.length);
  push(0, term);
  while (bits.length % 8 !== 0) bits.push(0);

  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[i + k];
    out.push(v);
  }
  // 填充字节 0xEC / 0x11 交替
  for (let i = 0; out.length < dataCapacity(version); i++) out.push(i % 2 === 0 ? 0xec : 0x11);
  return out;
}

/** 按 RS 分块、算纠错码、交织。 */
function interleave(dataCodewords, version) {
  const { ec, blocks } = VERSIONS[version];
  const groups = [];
  let offset = 0;
  for (const [count, size] of blocks) {
    for (let i = 0; i < count; i++) {
      const chunk = dataCodewords.slice(offset, offset + size);
      offset += size;
      groups.push({ data: chunk, ec: rsRemainder(chunk, rsDivisor(ec)) });
    }
  }
  const out = [];
  const maxData = Math.max(...groups.map((g) => g.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const g of groups) if (i < g.data.length) out.push(g.data[i]);
  }
  for (let i = 0; i < ec; i++) {
    for (const g of groups) out.push(g.ec[i]);
  }
  return out;
}

/* ── 矩阵装配 ────────────────────────────────────────────────────────── */

function newMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(false));
}

function placeFinder(m, cx, cy, reserved) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= m.length || y >= m.length) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      m[y][x] = d !== 2 && d !== 4;
      reserved[y][x] = true;
    }
  }
}

function placeFunctionPatterns(m, version, reserved) {
  const size = m.length;
  placeFinder(m, 3, 3, reserved);
  placeFinder(m, size - 4, 3, reserved);
  placeFinder(m, 3, size - 4, reserved);

  for (let i = 0; i < size; i++) {
    if (!reserved[6][i]) { m[6][i] = i % 2 === 0; reserved[6][i] = true; }
    if (!reserved[i][6]) { m[i][6] = i % 2 === 0; reserved[i][6] = true; }
  }

  const centres = ALIGN[version] || [];
  for (const cy of centres) {
    for (const cx of centres) {
      // 跳过与三个定位图形重叠的位置
      const nearFinder = (cx === 6 && cy === 6)
        || (cx === 6 && cy === size - 7)
        || (cx === size - 7 && cy === 6);
      if (nearFinder) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          m[cy + dy][cx + dx] = d !== 1;
          reserved[cy + dy][cx + dx] = true;
        }
      }
    }
  }

  // 保留格式信息区
  for (let i = 0; i < 9; i++) {
    if (i !== 6) { reserved[8][i] = true; reserved[i][8] = true; }
  }
  reserved[8][6] = true; reserved[6][8] = true;
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  m[size - 8][8] = true; // 恒暗模块

  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserved[i][size - 11 + j] = true;
        reserved[size - 11 + j][i] = true;
      }
    }
  }
}

function placeData(m, reserved, codewords) {
  const size = m.length;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  const bitAt = (i) => (i < totalBits ? (codewords[i >> 3] >> (7 - (i & 7))) & 1 : 0);

  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳过竖向 timing 列
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let k = 0; k < 2; k++) {
        const x = right - k;
        if (reserved[y][x]) continue;
        m[y][x] = bitAt(bitIndex) === 1;
        bitIndex++;
      }
    }
    upward = !upward;
  }
  return bitIndex;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m, maskId, reserved) {
  const size = m.length;
  const fn = MASKS[maskId];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!reserved[y][x] && fn(x, y)) m[y][x] = !m[y][x];
    }
  }
}

function bchFormat(data) {
  let d = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((d >> i) & 1) d ^= 0x537 << (i - 10);
  }
  return ((data << 10) | d) ^ 0x5412;
}

function bchVersion(version) {
  let d = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((d >> i) & 1) d ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | d;
}

function drawFormat(m, maskId) {
  const size = m.length;
  const bits = bchFormat((1 << 3) | maskId); // 纠错等级 L = 01
  const set = (x, y, i) => { m[y][x] = ((bits >> i) & 1) === 1; };

  for (let i = 0; i <= 5; i++) set(8, i, i);
  set(8, 7, 6);
  set(8, 8, 7);
  set(7, 8, 8);
  for (let i = 9; i <= 14; i++) set(14 - i, 8, i);

  for (let i = 0; i <= 7; i++) set(size - 1 - i, 8, i);
  for (let i = 8; i <= 14; i++) set(8, size - 15 + i, i);
  m[size - 8][8] = true;
}

function drawVersion(m, version) {
  if (version < 7) return;
  const size = m.length;
  const bits = bchVersion(version);
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = i % 3;
    m[size - 11 + b][a] = bit;
    m[a][size - 11 + b] = bit;
  }
}

function penalty(m) {
  const size = m.length;
  let score = 0;

  // 规则 1：连续同色 ≥5
  for (let a = 0; a < 2; a++) {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const cur = a === 0 ? m[i][j] : m[j][i];
        const prev = a === 0 ? m[i][j - 1] : m[j - 1][i];
        if (cur === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
  }

  // 规则 2：2×2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = m[y][x];
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
    }
  }

  // 规则 3：1:1:3:1:1 且外侧有 4 空白
  const finderA = [true, false, true, true, true, false, true, false, false, false, false];
  const finderB = finderA.slice().reverse();
  const match = (arr, pat, at) => pat.every((p, k) => arr[at + k] === p);
  for (let i = 0; i < size; i++) {
    const row = m[i];
    const col = m.map((r) => r[i]);
    for (let j = 0; j + 11 <= size; j++) {
      if (match(row, finderA, j) || match(row, finderB, j)) score += 40;
      if (match(col, finderA, j) || match(col, finderB, j)) score += 40;
    }
  }

  // 规则 4：暗色比例
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

/* ── 对外接口 ────────────────────────────────────────────────────────── */

function pickVersion(bytes) {
  for (let v = 1; v <= 10; v++) {
    const overhead = 4 + (v < 10 ? 8 : 16);
    if (Math.ceil((overhead + bytes.length * 8) / 8) <= dataCapacity(v)) return v;
  }
  throw new Error(`内容太长（${bytes.length} 字节），超出二维码 v10 容量`);
}

/** 自检用：把版本和最终码字暴露出来，便于和参考实现逐字节比对。 */
export function qrCodewords(text) {
  const bytes = toBytes(text);
  const version = pickVersion(bytes);
  return { version, codewords: interleave(buildCodewords(bytes, version), version) };
}

/** 返回 { size, modules } —— modules[y][x] === true 表示黑格（不含静区）。 */
export function encodeQr(text) {
  const bytes = toBytes(text);
  const version = pickVersion(bytes);

  const size = 17 + version * 4;
  const codewords = interleave(buildCodewords(bytes, version), version);

  let best = null;
  for (let maskId = 0; maskId < 8; maskId++) {
    const m = newMatrix(size);
    const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
    placeFunctionPatterns(m, version, reserved);
    placeData(m, reserved, codewords);
    applyMask(m, maskId, reserved);
    drawFormat(m, maskId);
    drawVersion(m, version);
    const p = penalty(m);
    if (!best || p < best.p) best = { p, m };
  }
  return { size, version, modules: best.m };
}

/** 直接产出 SVG 字符串（含静区），给浏览器画二维码用。 */
export function encodeQrSvg(text, { scale = 4, margin = 4, dark = '#000', light = 'none' } = {}) {
  const { size, modules } = encodeQr(text);
  const dim = (size + margin * 2) * scale;
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules[y][x]) continue;
      path += `M${(x + margin) * scale} ${(y + margin) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  const bg = light === 'none' ? '' : `<rect width="${dim}" height="${dim}" fill="${light}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">${bg}<path d="${path}" fill="${dark}"/></svg>`;
}
