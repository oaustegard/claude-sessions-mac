// The Claude Sessions mark: a dark tile with three popup rows, each a status
// dot and a bar. One geometry feeds both the SVG and the pixel renderer, so the
// installer icon and docs/brand/mark.svg cannot drift apart.
'use strict';
const { COLORS } = require('../tray-icon');

const VIEW = 120;
const TILE = [0x1c, 0x1f, 0x26];
const EDGE = [0x3a, 0x40, 0x4c]; // keeps the tile visible on a dark taskbar
const BAR = [0xec, 0xec, 0xf0];

/** Shapes in paint order, in a 120-unit box. */
function shapes() {
  const rows = [
    { y: 36, dot: COLORS.needs, bar: 46, alpha: 1 },
    { y: 60, dot: COLORS.done, bar: 34, alpha: 0.5 },
    { y: 84, dot: COLORS.working, bar: 40, alpha: 0.5 },
  ];
  const out = [
    { kind: 'rrect', x: 6, y: 6, w: 108, h: 108, r: 26, color: EDGE, alpha: 1 },
    { kind: 'rrect', x: 9, y: 9, w: 102, h: 102, r: 23, color: TILE, alpha: 1 },
    { kind: 'circle', cx: 35, cy: rows[0].y, r: 15, color: rows[0].dot, alpha: 0.28 }, // the needs-you glow from the popup
  ];
  for (const row of rows) {
    out.push({ kind: 'circle', cx: 35, cy: row.y, r: 9.5, color: row.dot, alpha: 1 });
    out.push({ kind: 'rrect', x: 54, y: row.y - 6.5, w: row.bar, h: 13, r: 6.5, color: BAR, alpha: row.alpha });
  }
  return out;
}

const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

function svg() {
  const parts = shapes().map((s) => {
    const op = s.alpha < 1 ? ` opacity="${s.alpha}"` : '';
    if (s.kind === 'circle') return `  <circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${hex(s.color)}"${op}/>`;
    return `  <rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}" fill="${hex(s.color)}"${op}/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}" role="img" aria-label="Claude Sessions">\n${parts.join('\n')}\n</svg>\n`;
}

function inside(s, x, y) {
  if (s.kind === 'circle') return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r * s.r;
  const dx = Math.max(s.x + s.r - x, 0, x - (s.x + s.w - s.r));
  const dy = Math.max(s.y + s.r - y, 0, y - (s.y + s.h - s.r));
  return x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h && dx * dx + dy * dy <= s.r * s.r;
}

/** Straight-alpha RGBA at `size` px, 4x4 samples per pixel. */
function render(size, n = 4) {
  const list = shapes();
  const px = Buffer.alloc(size * size * 4);
  const unit = VIEW / size;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = (pxl + (sx + 0.5) / n) * unit;
          const y = (py + (sy + 0.5) / n) * unit;
          let cr = 0, cg = 0, cb = 0, ca = 0; // premultiplied, painted back to front
          for (const s of list) {
            if (!inside(s, x, y)) continue;
            const k = s.alpha;
            cr = s.color[0] * k + cr * (1 - k);
            cg = s.color[1] * k + cg * (1 - k);
            cb = s.color[2] * k + cb * (1 - k);
            ca = k + ca * (1 - k);
          }
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const o = (py * size + pxl) * 4;
      if (a > 0) {
        px[o] = Math.round(r / a);
        px[o + 1] = Math.round(g / a);
        px[o + 2] = Math.round(b / a);
      }
      px[o + 3] = Math.round((a / (n * n)) * 255);
    }
  }
  return px;
}

module.exports = { VIEW, TILE, EDGE, BAR, shapes, svg, render };
