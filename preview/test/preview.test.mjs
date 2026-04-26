import { chromium } from '@playwright/test';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PDF_PATH = resolve(__dirname, '..', '..', 'test/fixtures/pdf/full/1.pdf');
const SCREENSHOT_DIR = resolve(__dirname, '..');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setViewportSize({ width: 1400, height: 900 });

const errors = [];
const failedRequests = [];

page.on('pageerror', err => errors.push(err.message));
page.on('requestfailed', req => {
  const url = req.url();
  if (!url.includes('favicon')) failedRequests.push(url);
});

console.log('1. Loading page...');
await page.goto('http://localhost:5173/preview/', { waitUntil: 'networkidle0', timeout: 30000 });
console.log('   Page loaded');

// Upload PDF
console.log('2. Uploading PDF...');
await page.locator('#file-input').setInputFiles(PDF_PATH);

// Wait for processing
await page.waitForFunction(
  () => {
    const s = document.getElementById('status').textContent;
    return s.includes('pages') || s.includes('Error');
  },
  { timeout: 120000 }
);

const finalStatus = await page.locator('#status').evaluate(el => el.textContent);
console.log(`   Status: "${finalStatus}"`);

// ── Verify rendering ──
const pageCount = await page.locator('.pdf-page').count();
const blockCount = await page.locator('#html-panel [data-block-id]').count();
const regionCount = await page.locator('.block-region').count();
console.log(`3. Pages: ${pageCount}, HTML blocks: ${blockCount}, PDF overlays: ${regionCount}`);

// Scroll first page into view to trigger render, wait for canvas content
await page.waitForFunction(() => {
  const canvas = document.querySelector('.pdf-page canvas');
  if (!canvas) return false;
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(100, 100, 1, 1).data;
  return data[3] > 0; // has visible content
}, { timeout: 10000 });
console.log('4. First page canvas has content');

// Take initial screenshot
await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'screenshot-initial.png') });
console.log('   -> screenshot-initial.png');

// ── Test hover HTML → PDF highlight ──
console.log('5. Testing hover: HTML block → PDF highlight...');
const firstBlock = await page.$('#html-panel [data-block-id]');
await firstBlock.hover();
await page.waitForTimeout(200);
const activeRegionsCount = await page.locator('.block-region.active').count();
const htmlBlockActive = await page.locator('#html-panel [data-block-id]').first().evaluate(el => el.classList.contains('active'));
console.log(`   Active PDF regions: ${activeRegionsCount}, HTML block highlighted: ${htmlBlockActive}`);
await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'screenshot-hover-html.png') });
console.log('   -> screenshot-hover-html.png');

// ── Test hover PDF region → HTML highlight ──
console.log('6. Testing hover: PDF region → HTML highlight...');
// Move mouse away first to clear
await page.mouse.move(0, 0);
await page.waitForTimeout(200);

const firstRegion = await page.$('.block-region');
if (firstRegion) {
  await firstRegion.hover();
  await page.waitForTimeout(200);
  const activeHtml = await page.locator('#html-panel [data-block-id].active').count();
  const activeRegs = await page.locator('.block-region.active').count();
  console.log(`   Active HTML blocks: ${activeHtml}, Active PDF regions: ${activeRegs}`);
  await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'screenshot-hover-pdf.png') });
  console.log('   -> screenshot-hover-pdf.png');
}

// ── Test click HTML → scroll PDF ──
console.log('7. Testing click: HTML block → scroll PDF...');
// Find a block further down (e.g., 20th block) and click it
const targetBlock = await page.$('#html-panel [data-block-id="20"]');
if (targetBlock) {
  // Get its block ID info
  const blockInfo = await page.locator('#html-panel [data-block-id="20"]').evaluate(el => ({
    tag: el.tagName, text: el.textContent.slice(0, 50)
  }));
  console.log(`   Clicking block 20: <${blockInfo.tag}> "${blockInfo.text}"`);

  await targetBlock.click();
  await page.waitForTimeout(800); // wait for smooth scroll
  await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'screenshot-click-html.png') });
  console.log('   -> screenshot-click-html.png');
}

// ── Test click PDF region → scroll HTML ──
console.log('8. Testing click: PDF region → scroll HTML...');
// First scroll the PDF panel to the top
await page.evaluate(() => document.getElementById('pdf-panel').scrollTop = 0);
await page.waitForTimeout(300);

// Click a region that corresponds to a block further in the document
const regions = await page.$$('.block-region');
if (regions.length > 5) {
  await regions[5].click();
  await page.waitForTimeout(800); // wait for smooth scroll
  await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'screenshot-click-pdf.png') });
  console.log('   -> screenshot-click-pdf.png');
}

// ── Test divider resize ──
console.log('9. Testing divider resize...');
const divider = await page.$('#divider');
const divBox = await divider.boundingBox();
await page.mouse.move(divBox.x + 2, divBox.y + divBox.height / 2);
await page.mouse.down();
await page.mouse.move(divBox.x + 200, divBox.y + divBox.height / 2, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);
await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'screenshot-resized.png') });
console.log('   -> screenshot-resized.png');

// ── Summary ──
console.log('\n═══ Summary ═══');
if (errors.length) {
  console.log('Page errors:');
  for (const e of errors) console.log('  ✗', e);
}
if (failedRequests.length) {
  console.log('Failed requests (non-favicon):');
  for (const u of failedRequests) console.log('  ✗', u);
}
if (!errors.length && !failedRequests.length && finalStatus.includes('pages')) {
  console.log('✅ All tests passed!');
} else if (finalStatus.includes('pages')) {
  console.log('⚠️  Works but with warnings');
} else {
  console.log('❌ Issues detected');
}

await browser.close();
