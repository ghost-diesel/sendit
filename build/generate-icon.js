'use strict';

// Generates build/icon.png (1024x1024) — a rounded gradient tile with a
// white paper-plane glyph. Pure Node (zlib only), supersampled for smooth
// edges. Run: node build/generate-icon.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;
const SS = 3; // supersample factor
const W = SIZE * SS;

function lerp(a, b, t) { return a + (b - a) * t; }
function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }

const C1 = hex('#6d8bff');
const C2 = hex('#9b6dff');

// Paper-plane polygon (in 0..1 unit space), classic send glyph.
const PLANE = [
  [0.14, 0.50],
  [0.86, 0.16],
  [0.60, 0.86],
  [0.49, 0.60],
];
// Inner fold line darkens slightly — we approximate with a second triangle.
const FOLD = [
  [0.14, 0.50],
  [0.49, 0.60],
  [0.36, 0.70],
];

function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

const radius = 0.225 * W; // rounded corner radius

function inRoundedRect(x, y) {
  const r = radius;
  if (x >= r && x <= W - r) return true;
  if (y >= r && y <= W - r) return true;
  const cx = x < r ? r : W - r;
  const cy = y < r ? r : W - r;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const buf = Buffer.alloc(W * W * 4);

for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    if (!inRoundedRect(x, y)) {
      buf[o] = buf[o + 1] = buf[o + 2] = buf[o + 3] = 0;
      continue;
    }
    const t = (x / W + y / W) / 2; // diagonal gradient
    let r = lerp(C1[0], C2[0], t);
    let g = lerp(C1[1], C2[1], t);
    let b = lerp(C1[2], C2[2], t);

    const ux = x / W, uy = y / W;
    if (pointInPoly(ux, uy, PLANE)) {
      r = g = b = 255;
    }
    if (pointInPoly(ux, uy, FOLD)) {
      r = 226; g = 230; b = 245;
    }
    buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
  }
}

// Downsample SSxSS -> 1px (box filter) for anti-aliasing.
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const o = ((y * SS + dy) * W + (x * SS + dx)) * 4;
        r += buf[o]; g += buf[o + 1]; b += buf[o + 2]; a += buf[o + 3];
      }
    }
    const n = SS * SS;
    const o2 = (y * SIZE + x) * 4;
    out[o2] = Math.round(r / n);
    out[o2 + 1] = Math.round(g / n);
    out[o2 + 2] = Math.round(b / n);
    out[o2 + 3] = Math.round(a / n);
  }
}

// Encode PNG.
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log('Wrote build/icon.png');
