// 由 icon.svg 生成各尺寸 PNG 图标（只在图标改动时需要重新运行）
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svg = await readFile(path.join(pub, 'icon.svg'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad] of [['icon-192.png', 192, 0], ['icon-512.png', 512, 0], ['icon-maskable-512.png', 512, 0.12]]) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * (1 - pad * 2));
  await page.setContent(
    `<body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${pad ? '#3a6ff0' : 'transparent'}"><div style="width:${inner}px;height:${inner}px">${svg}</div></body>`,
  );
  await page.screenshot({ path: path.join(pub, name), omitBackground: !pad });
}
await browser.close();
