'use strict';

// Rasterizes the Ember logo (scripts/fire.svg — Microsoft Fluent emoji "Fire",
// MIT licensed) into:
//   build/icon.ico          multi-size app icon for the installer/shortcuts
//   build/icon-preview.png  256px preview
//   src/assets/tray.png     32px tray icon loaded at runtime
// Runs under Electron (offscreen render): electron scripts/render-icon.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = [256, 64, 48, 32, 16];

function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(SIZES.length, 4);
  const dirs = [];
  let offset = 6 + 16 * SIZES.length;
  SIZES.forEach((s, i) => {
    const d = Buffer.alloc(16);
    d[0] = s === 256 ? 0 : s; // width (0 means 256)
    d[1] = s === 256 ? 0 : s; // height
    d.writeUInt16LE(1, 4);    // planes
    d.writeUInt16LE(32, 6);   // bpp
    d.writeUInt32LE(pngs[i].length, 8);
    d.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    dirs.push(d);
  });
  return Buffer.concat([header, ...dirs, ...pngs]);
}

app.whenReady().then(async () => {
  try {
    const svg = fs
      .readFileSync(path.join(__dirname, 'fire.svg'), 'utf8')
      .replace('width="32" height="32"', 'width="256" height="256"');
    const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`;

    const win = new BrowserWindow({
      width: 256,
      height: 256,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: { offscreen: true },
    });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 600)); // let the offscreen frame paint

    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
    if (img.isEmpty()) throw new Error('capture came back empty');

    const pngs = SIZES.map((s) =>
      (s === 256 ? img : img.resize({ width: s, height: s, quality: 'best' })).toPNG()
    );

    const buildDir = path.join(__dirname, '..', 'build');
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildIco(pngs));
    fs.writeFileSync(path.join(buildDir, 'icon-preview.png'), pngs[0]);

    const assetsDir = path.join(__dirname, '..', 'src', 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'tray.png'), img.resize({ width: 32, height: 32, quality: 'best' }).toPNG());

    console.log(`wrote build/icon.ico (${SIZES.join(', ')} px), build/icon-preview.png, src/assets/tray.png`);
    app.exit(0);
  } catch (err) {
    console.error('icon render failed:', err);
    app.exit(1);
  }
});
