// Draws the menu bar icon as PNGs, at 1x and 2x (Retina). Pure: no
// Electron here, so the drawing is testable and can be written to disk to look at.
//
//   something needs you, failed or finished: a square in the most urgent
//     colour with the count of those sessions
//   sessions working or idle: a dot, blue while any is working, else gray
//   no sessions: a gray ring
//   hooks not installed: a gray square with "!"
'use strict';
const zlib = require('zlib');

const COLORS = {
  needs: [245, 158, 11],
  error: [239, 68, 68],
  done: [34, 197, 94],
  working: [59, 130, 246],
  idle: [156, 163, 175],
};
const TEXT = [255, 255, 255];
// The menu bar is 22 pt tall; 18 pt icons sit in it like the system's own.
const SIZES = [[18, 1], [36, 2]];

const GLYPHS = {
  0: [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
  1: [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
  2: [0x0E, 0x11, 0x01, 0x0E, 0x10, 0x10, 0x1F],
  3: [0x0E, 0x11, 0x01, 0x0E, 0x01, 0x11, 0x0E],
  4: [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
  5: [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
  6: [0x0E, 0x10, 0x10, 0x1E, 0x11, 0x11, 0x0E],
  7: [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
  9: [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x01, 0x0E],
  '+': [0x00, 0x04, 0x04, 0x1F, 0x04, 0x04, 0x00],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
};
const GLYPH_W = 5;
const GLYPH_H = 7;
const SUB = 4; // 4x4 samples per pixel for smooth edges

/** What the icon shows for a summary from state.summarize(). */
function iconSpec(summary, { hooksInstalled = true } = {}) {
  if (!hooksInstalled) return { shape: 'square', color: COLORS.idle, text: '!' };
  const s = summary || { total: 0, badge: 0, counts: {} };
  if (s.badge > 0) return { shape: 'square', color: COLORS[s.top] || COLORS.done, text: s.badge > 9 ? '9+' : String(s.badge) };
  if (s.total > 0) return { shape: 'dot', color: s.counts && s.counts.working ? COLORS.working : COLORS.idle };
  return { shape: 'ring', color: COLORS.idle };
}

/** Coverage (0..1) of pixel (x, y) by the shape, from SUB x SUB samples. */
function coverage(shape, size, x, y) {
  const c = size / 2;
  let hit = 0;
  for (let i = 0; i < SUB; i++) {
    for (let j = 0; j < SUB; j++) {
      const px = x + (i + 0.5) / SUB;
      const py = y + (j + 0.5) / SUB;
      if (shape === 'square') {
        const r = size * 0.22;
        const dx = Math.max(r - px, px - (size - r), 0);
        const dy = Math.max(r - py, py - (size - r), 0);
        if (dx * dx + dy * dy <= r * r) hit++;
      } else {
        const d = Math.hypot(px - c, py - c);
        if (shape === 'dot' && d <= size * 0.34) hit++;
        if (shape === 'ring' && d <= size * 0.34 && d >= size * 0.34 - Math.max(1.5, size * 0.11)) hit++;
      }
    }
  }
  return hit / (SUB * SUB);
}

/** Straight-alpha RGBA pixels, row by row. */
function drawIcon(spec, size) {
  const px = Buffer.alloc(size * size * 4);
  const [r, g, b] = spec.color;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = coverage(spec.shape, size, x, y);
      const i = (y * size + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = Math.round(a * 255);
    }
  }
  if (spec.text) drawText(px, size, spec.text);
  return px;
}

function drawText(px, size, text) {
  const chars = [...text].filter((ch) => GLYPHS[ch]);
  const scale = Math.max(1, Math.floor(size / 16));
  const w = (chars.length * (GLYPH_W + 1) - 1) * scale;
  const h = GLYPH_H * scale;
  const x0 = Math.floor((size - w) / 2);
  const y0 = Math.floor((size - h) / 2);
  chars.forEach((ch, k) => {
    const rows = GLYPHS[ch];
    for (let row = 0; row < GLYPH_H; row++) {
      for (let col = 0; col < GLYPH_W; col++) {
        if (!(rows[row] & (1 << (GLYPH_W - 1 - col)))) continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const x = x0 + (k * (GLYPH_W + 1) + col) * scale + sx;
            const y = y0 + row * scale + sy;
            if (x < 0 || y < 0 || x >= size || y >= size) continue;
            const i = (y * size + x) * 4;
            px[i] = TEXT[0]; px[i + 1] = TEXT[1]; px[i + 2] = TEXT[2]; px[i + 3] = 255;
          }
        }
      }
    }
  });
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes straight-alpha RGBA as a PNG, so channel order never depends on the platform. */
function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PNGs for every display scale: [{scaleFactor, size, png}]. */
function iconPngs(summary, opts) {
  const spec = iconSpec(summary, opts);
  return SIZES.map(([size, scaleFactor]) => ({ size, scaleFactor, png: encodePng(drawIcon(spec, size), size, size) }));
}

module.exports = { COLORS, SIZES, iconSpec, drawIcon, encodePng, iconPngs, crc32 };
