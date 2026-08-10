/* Drives docs/index.html in a real browser: asserts the page renders, the live
 * demo completes, the charts draw, and nothing errors in the console.
 *
 *   node tests/browser_check.mjs [baseURL]
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8765/';
const SHOTS = process.env.SHOT_DIR ?? 'tests/screenshots';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle' });

check('page title', (await page.title()).includes('Wikipedia Summarizer'));

// --- live demo (fires automatically on load) -------------------------------
try {
  await page.waitForSelector('#live-panel .summary-out', { timeout: 45000 });
  const summary = await page.textContent('#live-panel .summary-out');
  check('live demo produced a summary', summary.split(/\s+/).length > 40,
        `${summary.split(/\s+/).length} words`);

  const stats = await page.$$eval('#live-panel .stat .v', (n) => n.map((x) => x.textContent.trim()));
  check('live stat tiles rendered', stats.length === 5, stats.join(' | '));

  const scores = await page.$$eval('#live-panel .cmp-scores b', (n) => n.map((x) => x.textContent));
  check('live ROUGE computed', scores.length >= 3 && scores.every((s) => Number(s) > 0),
        scores.join(' / '));
} catch (error) {
  const notice = await page.textContent('#live-panel').catch(() => '');
  check('live demo produced a summary', false, notice.slice(0, 120) || error.message);
}

// --- benchmark rendering ---------------------------------------------------
check('headline stats', (await page.$$('#headline-stats .stat')).length === 4);

const bars = await page.$$('#rouge-chart svg path[tabindex]');
check('ROUGE chart bars', bars.length === 12, `${bars.length} bars (4 methods x 3 metrics)`);

// Labelled selectively: the leader in each of the three metric groups. Exact
// values for the rest come from the tooltip and the table view (the relief
// path for the low-contrast palette slots).
const capLabels = await page.$$eval('#rouge-chart svg text.val', (n) => n.length);
check('leader labelled in each group', capLabels === 3, `${capLabels} labels`);

const collide = await page.$$eval('#rouge-chart svg text.val', (nodes) => {
  const boxes = nodes.map((n) => n.getBoundingClientRect()).sort((a, b) => a.left - b.left);
  return boxes.some((b, i) => i && b.left < boxes[i - 1].right + 2);
});
check('no colliding value labels', !collide);

check('legend', (await page.$$('#rouge-legend .item')).length === 4);

const rows = await page.$$('#results-table tbody tr');
check('results table rows', rows.length === 4);
const headers = await page.$$eval('#results-table thead th', (n) => n.map((x) => x.textContent));
check('table has ROUGE + cost columns',
      ['ROUGE-1', 'ROUGE-2', 'ROUGE-L', 'Body read', 'Time'].every((h) => headers.includes(h)),
      headers.join(', '));
check('best-in-column emphasis', (await page.$$('#results-table td.best')).length > 0);

// --- explorer --------------------------------------------------------------
check('explorer cards', (await page.$$('#compare .cmp-card')).length === 5, '1 reference + 4 methods');
const options = await page.$$('#article-select option');
check('article picker populated', options.length > 1, `${options.length} articles`);

if (options.length > 1) {
  // Compare the meta line rather than the summary text: placeholder benchmark
  // data repeats the same body across articles, which would false-negative here.
  const before = await page.textContent('#article-meta');
  await page.selectOption('#article-select', '1');
  await page.waitForTimeout(150);
  check('switching article updates cards', (await page.textContent('#article-meta')) !== before);
  await page.selectOption('#article-select', '0');
}

// --- chart/table toggle ----------------------------------------------------
await page.click('#chart-toggle button[data-view="table"]');
await page.waitForTimeout(120);
check('table view toggle', (await page.$$('#rouge-chart table tbody tr')).length === 4);
await page.click('#chart-toggle button[data-view="chart"]');
await page.waitForTimeout(120);
check('chart view restored', (await page.$$('#rouge-chart svg path[tabindex]')).length === 12);

// --- tooltip ---------------------------------------------------------------
await page.hover('#rouge-chart svg path[tabindex]');
await page.waitForTimeout(150);
check('hover tooltip', await page.$eval('.viz-tip', (n) => getComputedStyle(n).opacity === '1'));

// --- layout ----------------------------------------------------------------
const overflow = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no horizontal page overflow (desktop)', overflow <= 1, `${overflow}px`);

mkdirSync(SHOTS, { recursive: true });
await page.screenshot({ path: `${SHOTS}/light-full.png`, fullPage: true });
await page.screenshot({ path: `${SHOTS}/light-hero.png` });

// --- dark mode -------------------------------------------------------------
await page.click('#theme-toggle');
await page.waitForTimeout(250);
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
check('dark theme applies', bg === 'rgb(16, 16, 19)', bg);
check('charts survive theme switch', (await page.$$('#rouge-chart svg path[tabindex]')).length === 12);
await page.screenshot({ path: `${SHOTS}/dark-full.png`, fullPage: true });

// --- mobile ----------------------------------------------------------------
await page.click('#theme-toggle');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(250);
const mobileOverflow = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no horizontal page overflow (mobile 390px)', mobileOverflow <= 1, `${mobileOverflow}px`);
await page.screenshot({ path: `${SHOTS}/mobile.png`, fullPage: true });

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
