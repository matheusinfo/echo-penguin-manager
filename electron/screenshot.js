// Dev-only: when ECHO_SCREENSHOT_DIR is set, visit every page and save a PNG of each, then quit.
// Usage: ECHO_SCREENSHOT_DIR=/tmp/shots xvfb-run -s "-screen 0 1440x920x24" npx electron .
'use strict';
const fs = require('fs');
const path = require('path');

const PAGES = ['Visão geral', 'Sistema', 'Docker', 'Logs', 'Alarme & Tela', 'Configurações', 'Terminal SSH'];

module.exports = function screenshotTour(app, win, dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const errors = [];
  win.webContents.on('console-message', (e) => {
    if (e.level === 'warning' || e.level === 'error') errors.push(`[${e.level}] ${e.message}`);
  });
  win.webContents.once('did-finish-load', async () => {
    fs.mkdirSync(dir, { recursive: true });
    await wait(Number(process.env.ECHO_SCREENSHOT_WAIT || 6000));
    for (let i = 0; i < PAGES.length; i++) {
      const label = PAGES[i];
      await win.webContents.executeJavaScript(`(() => {
        const b = [...document.querySelectorAll('.nav-item')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (b) b.click();
      })()`);
      await wait(Number(process.env.ECHO_SCREENSHOT_PAGE_WAIT || 5000));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `${i + 1}-${label.replace(/[^a-z0-9]+/gi, '_')}.png`), img.toPNG());
    }
    fs.writeFileSync(path.join(dir, 'console-errors.txt'), errors.join('\n'));
    app.quit();
  });
};
