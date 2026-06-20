'use strict';

// Generates menu-bar / tray icons: a monochrome paper-plane glyph on a
// transparent background, as a macOS "template" image (black + alpha, the
// OS recolors it for light/dark menu bars). Outputs 18px and 36px (@2x).
// Run: node build/generate-tray.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const PLANE = [
  [0.10, 0.50],
  [0.90, 0.14],
  [0.62, 0.90],
  [0.50, 0.60],
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
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(size) {
  const SS = 4;
  const W = size * SS;
  const big = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      if (pointInPoly(x / W, y / W, PLANE)) big[y * W + x] = 255;
    }
  }
  // Downsample to alpha, color = black.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0;
      for (let dy = 0; dy < SS; dy++)
        for (let dx = 0; dx < SS; dx++)
          a += big[(y * SS + dy) * W + (x * SS + dx)];
      const o = (y * size + x) * 4;
      out[o] = 0; out[o + 1] = 0; out[o + 2] = 0;
      out[o + 3] = Math.round(a / (SS * SS));
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    out.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

fs.writeFileSync(path.join(__dirname, 'trayTemplate.png'), makePng(18));
fs.writeFileSync(path.join(__dirname, 'trayTemplate@2x.png'), makePng(36));
console.log('Wrote build/trayTemplate.png and @2x');
