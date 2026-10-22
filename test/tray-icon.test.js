'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const t = require('../tray-icon');

const sum = (counts) => {
  const order = ['needs', 'error', 'done', 'working', 'idle'];
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, total, top: order.find((s) => counts[s]) || null, badge: (counts.needs || 0) + (counts.error || 0) + (counts.done || 0) };
};

/** Reads back the RGBA pixels of a PNG written by encodePng (filter 0 only). */
function decode(png) {
  assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  let off = 8;
  let width; let height; const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    assert.strictEqual(png.readUInt32BE(off + 8 + len), t.crc32(png.subarray(off + 4, off + 8 + len)), `${type} crc`);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.strictEqual(data[9], 6); }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) raw.copy(px, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  return { width, height, px };
}

test('crc32 matches the standard check value', () => {
  assert.strictEqual(t.crc32(Buffer.from('123456789')), 0xCBF43926);
});

test('the icon picks its shape, colour and text from the summary', () => {
  assert.deepStrictEqual(t.iconSpec(sum({ needs: 1, done: 2, working: 3 })), { shape: 'square', color: t.COLORS.needs, text: '3' });
  assert.deepStrictEqual(t.iconSpec(sum({ error: 1, done: 1 })), { shape: 'square', color: t.COLORS.error, text: '2' });
  assert.strictEqual(t.iconSpec(sum({ done: 14 })).text, '9+');
  assert.deepStrictEqual(t.iconSpec(sum({ working: 1, idle: 4 })), { shape: 'dot', color: t.COLORS.working });
  assert.deepStrictEqual(t.iconSpec(sum({ idle: 2 })), { shape: 'dot', color: t.COLORS.idle });
  assert.deepStrictEqual(t.iconSpec(sum({})), { shape: 'ring', color: t.COLORS.idle });
  assert.deepStrictEqual(t.iconSpec(null), { shape: 'ring', color: t.COLORS.idle });
  assert.deepStrictEqual(t.iconSpec(sum({ needs: 1 }), { hooksInstalled: false }), { shape: 'square', color: t.COLORS.idle, text: '!' });
});

test('every display scale gets a PNG that decodes to the drawn pixels', () => {
  const s = sum({ needs: 2 });
  const pngs = t.iconPngs(s);
  assert.deepStrictEqual(pngs.map((p) => [p.size, p.scaleFactor]), t.SIZES);
  for (const { size, png } of pngs) {
    const { width, height, px } = decode(png);
    assert.strictEqual(width, size);
    assert.strictEqual(height, size);
    assert.ok(px.equals(t.drawIcon(t.iconSpec(s), size)), `${size}px round trip`);
  }
});

test('squares have clear corners, an amber body and white digits; rings are hollow', () => {
  const size = 16;
  const sq = t.drawIcon(t.iconSpec(sum({ needs: 8 })), size);
  const at = (px, x, y) => [...px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
  assert.strictEqual(at(sq, 0, 0)[3], 0, 'corner transparent');
  assert.deepStrictEqual(at(sq, 1, 8), [...t.COLORS.needs, 255], 'left edge is amber');
  const white = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (at(sq, x, y).slice(0, 3).join() === '255,255,255') white.push(x);
  assert.ok(white.length >= 15, '"8" is drawn');

  const ring = t.drawIcon(t.iconSpec(sum({})), size);
  assert.strictEqual(at(ring, 8, 8)[3], 0, 'ring centre is empty');
  assert.ok(at(ring, 8, 3)[3] > 128, 'ring edge is drawn');
  const dot = t.drawIcon(t.iconSpec(sum({ idle: 1 })), size);
  assert.strictEqual(at(dot, 8, 8)[3], 255, 'dot centre is filled');
});
