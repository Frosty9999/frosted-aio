// Writes build/icon.ico (the installer and exe icon) from the same drawing the app uses.
// Run with: npm run icon
const { app } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const { writeIco } = require('../src/system');
  const out = path.join(__dirname, 'icon.ico');
  writeIco(out);
  console.log('wrote', out);
  app.quit();
});
