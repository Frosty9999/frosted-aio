// Renders build/icon.svg to every icon file the app uses. Run with: npm run icon
//   build/icon.ico           installer + exe (16-256 px, PNG-compressed entries)
//   src/assets/icon.ico      desktop shortcut for the development copy
//   src/assets/tray.png      tray icon (16 px) and tray@2x.png (32 px) for high-DPI screens
//   src/assets/icon-64.png   title bar logo
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
const assets = path.join(__dirname, '..', 'src', 'assets');

// One .ico holding a PNG per size (supported since Windows Vista).
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,<html><body></body></html>');
  // Rasterise in the page with a canvas (keeps transparency), one size at a time.
  const render = (size) =>
    w.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = ${size};
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, ${size}, ${size});
        resolve(c.toDataURL('image/png').split(',')[1]);
      };
      img.onerror = reject;
      img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
    })`);
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const pngs = [];
  for (const size of sizes) pngs.push({ size, data: Buffer.from(await render(size), 'base64') });
  const byte = (s) => pngs.find((p) => p.size === s).data;

  fs.mkdirSync(assets, { recursive: true });
  const icon = ico(pngs);
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), icon);
  fs.writeFileSync(path.join(assets, 'icon.ico'), icon);
  fs.writeFileSync(path.join(assets, 'tray.png'), byte(16));
  fs.writeFileSync(path.join(assets, 'tray@2x.png'), byte(32));
  fs.writeFileSync(path.join(assets, 'icon-64.png'), byte(64));
  fs.writeFileSync(path.join(assets, 'icon-256.png'), byte(256));
  console.log('wrote build/icon.ico and src/assets (' + sizes.join(', ') + ' px)');
  app.quit();
});
