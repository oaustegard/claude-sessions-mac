// Writes build/icon.png, the 1024 px app icon electron-builder turns into the
// .icns, and docs/brand/mark.svg, both from the brand mark's geometry.
//   node scripts/make-icon.js
'use strict';
const fs = require('fs');
const path = require('path');
const { encodePng } = require('../tray-icon');
const mark = require('./brand-mark');

const SIZE = 1024;
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePng(mark.render(SIZE), SIZE, SIZE));
const svgOut = path.join(__dirname, '..', 'docs', 'brand', 'mark.svg');
fs.mkdirSync(path.dirname(svgOut), { recursive: true });
fs.writeFileSync(svgOut, mark.svg());
console.log(`wrote ${out} (${SIZE} px) and ${svgOut}`);
