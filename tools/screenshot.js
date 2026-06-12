const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'https://gv-test.lngnckr.tech';
const OUT = path.join(__dirname, '..', 'wwwroot', 'img');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });

  const pages = [
    { url: BASE, name: 'screenshot-home', desc: 'Home page' },
    { url: `${BASE}/Games`, name: 'screenshot-games', desc: 'Games library' },
  ];

  for (const { url, name } of pages) {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1000);

    const clip = await page.evaluate(() => {
      const scrollHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      );
      return { x: 0, y: 0, width: 1280, height: Math.min(scrollHeight, 2000) };
    });

    await page.screenshot({
      path: path.join(OUT, `${name}.png`),
      fullPage: true,
    });
    console.log(`✓ ${name}.png`);
    await page.close();
  }

  await browser.close();
  console.log('Done.');
})().catch(e => { console.error(e); process.exit(1); });
