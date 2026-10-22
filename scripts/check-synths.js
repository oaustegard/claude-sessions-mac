// Renders each built-in sound offline and prints its peak, loudness, audible
// length and zero-crossing rate, then exits non-zero if one is silent,
// clips, or runs well past the length it reports.
//   npx electron scripts/check-synths.js
'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const synthSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'synth.js'), 'utf8');

const probe = `(async () => {
  const out = [];
  for (const name of Object.keys(window.Synth)) {
    const rate = 44100;
    const ctx = new OfflineAudioContext(1, rate * 2.5, rate);
    const said = window.Synth[name](ctx, ctx.destination, 0.01);
    const data = (await ctx.startRendering()).getChannelData(0);
    let peak = 0, sum = 0, last = 0, zc = 0;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
      sum += data[i] * data[i];
      if (a > 0.001) last = i;
      if (i && (data[i - 1] < 0) !== (data[i] < 0)) zc++;
    }
    const heard = last / rate;
    out.push({ name, said: +said.toFixed(3), heard: +heard.toFixed(3), peak: +peak.toFixed(3),
      rms: +Math.sqrt(sum / Math.max(1, last)).toFixed(3), zcHz: Math.round(zc / 2 / Math.max(heard, 0.001)) });
  }
  return out;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<meta charset=utf-8>');
  await win.webContents.executeJavaScript(synthSource);
  const rows = await win.webContents.executeJavaScript(probe);
  let bad = 0;
  for (const r of rows) {
    const problems = [];
    if (r.peak < 0.05) problems.push('too quiet');
    if (r.peak >= 1) problems.push('clips');
    if (r.heard > r.said + 0.2) problems.push('rings past its length');
    if (problems.length) bad++;
    console.log(JSON.stringify(r), problems.join(', '));
  }
  app.exit(bad ? 1 : 0);
});
