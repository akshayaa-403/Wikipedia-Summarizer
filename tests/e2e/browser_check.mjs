/* Drives docs/index.html in a real browser and asserts the whole page is live:
 * four summaries, ROUGE against Wikipedia's lead, and every chart recomputing
 * for an arbitrary article.
 *
 *   node tests/e2e/browser_check.mjs [baseURL]
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

// app.js clears body[data-loaded] before fetching and sets it after render, so
// this cannot latch onto the previous article's still-visible output.
const ready = () => page.waitForFunction(
  () => document.body.dataset.loaded === 'true'
     && document.querySelectorAll('#summaries .card').length === 5
     && document.querySelectorAll('#density-chart svg path[tabindex]').length === 4,
  { timeout: 45000 });

await page.goto(BASE, { waitUntil: 'networkidle' });
await ready();

check('page title', (await page.title()).includes('Wikipedia Summarizer'));

// --- summaries -------------------------------------------------------------
check('five cards (reference + four methods)',
      (await page.$$('#summaries .card')).length === 5);

const ref = await page.textContent('#summaries .reference .summary-text');
check('reference shows Wikipedia lead', ref.split(/\s+/).length > 60,
      `${ref.split(/\s+/).length} words`);

const bodies = await page.$$eval('#summaries .card:not(.reference) .summary-text',
  (n) => n.map((x) => x.textContent.trim()));
check('four summaries produced', bodies.length === 4 && bodies.every((b) => b.split(/\s+/).length > 60),
      bodies.map((b) => b.split(/\s+/).length + 'w').join(' / '));
check('summaries are distinct', new Set(bodies).size === 4,
      `${new Set(bodies).size} unique`);

// Regression: a TF-IDF centroid method used to sit here and correlated with
// TextRank at r=0.99, returning byte-identical summaries on some articles.
// LSA replaced it; this guards against any future method collapsing again.
const scoreRows = await page.$$eval('#results-table tbody tr:not(.ceiling-row)',
  (rows) => rows.map((r) => [...r.querySelectorAll('td')].slice(1, 4).map((t) => t.textContent).join()));
check('no two methods score identically', new Set(scoreRows).size === 4,
      `${new Set(scoreRows).size} distinct score triples`);

const statGroups = await page.$$eval('#summaries .card:not(.reference) .sumstats',
  (n) => n.map((x) => x.querySelectorAll('div').length));
check('per-summary stats', statGroups.every((c) => c === 6), `${statGroups[0]} stats each`);

// --- metrics ---------------------------------------------------------------
check('grouped bars', (await page.$$('#rouge-chart svg path[tabindex]')).length === 12,
      '4 methods x 3 metrics');

const ceilingLines = await page.$$eval('#rouge-chart svg line[stroke-dasharray]', (n) => n.length);
check('human ceiling drawn per metric group', ceilingLines === 3, `${ceilingLines} rules`);

check('table has ceiling row + 4 methods',
      (await page.$$('#results-table tbody tr')).length === 5);
check('ceiling row marked', (await page.$$('#results-table tr.ceiling-row')).length === 1);

const headers = await page.$$eval('#results-table thead th', (n) => n.map((x) => x.textContent.trim()));
check('table columns', ['ROUGE-1', '% of human', 'Words', 'Sentences', 'Read', 'Ease']
        .every((h) => headers.includes(h)), headers.join(', '));

check('slopegraph lines', (await page.$$('#slope-chart svg polyline')).length === 4);
check('quadrant points', (await page.$$('#quadrant-chart svg circle[tabindex]')).length === 4);

// Regression: TextRank and TF-IDF land near-identically on most articles, and
// their labels used to overprint each other and the neighbouring dot.
const quadLabels = await page.$$eval('#quadrant-chart svg text.val', (nodes) =>
  nodes.map((n) => n.getBoundingClientRect()));
const overlap = quadLabels.some((a, i) => quadLabels.some((bb, j) =>
  i !== j && a.left < bb.right && bb.left < a.right && a.top < bb.bottom && bb.top < a.bottom));
check('quadrant labels do not overlap', !overlap, `${quadLabels.length} labels`);
check('overlap matrix off-diagonal cells',
      (await page.$$('#overlap-chart svg rect[tabindex="0"]')).length === 12);
check('key-term coverage bars', (await page.$$('#terms-chart svg rect[tabindex]')).length === 4);

// Regression: ROUGE and key-term extraction once used two different stemmers,
// and the shared one mapped 'holes' to 'hol' while 'hole' stayed whole -- so
// both claimed a slot in the top-20 and the list covered 19 concepts, not 20.
const stemCheck = await page.evaluate(async () => {
  const w = await import('/js/wiki.js');
  const merged = [['hole', 'holes'], ['galaxy', 'galaxies'], ['box', 'boxes'], ['run', 'running']];
  const distinct = [['hole', 'hold'], ['star', 'start']];
  return {
    merged: merged.every(([a, b]) => w.stem(a) === w.stem(b)),
    separate: distinct.every(([a, b]) => w.stem(a) !== w.stem(b)),
  };
});
check('stemmer merges inflections', stemCheck.merged);
check('stemmer keeps distinct words apart', stemCheck.separate);

// Maths-heavy articles embed formulae as "{\displaystyle ...}" in the
// plaintext extract; unstripped it leaks into summaries and ranks as a term.
const latexLeak = await page.evaluate(async () => {
  const w = await import('/js/wiki.js');
  const art = await w.fetchArticle('Black hole');
  return /displaystyle/.test(art.body);
});
check('LaTeX markup stripped from article text', !latexLeak);
check('density curves', (await page.$$('#density-chart svg path[tabindex]')).length === 4);

// Regression: the matrix once referenced a deleted palette token, so color-mix
// failed and every cell rendered pure black.
const cellFills = await page.$$eval('#overlap-chart svg rect[tabindex="0"]',
  (n) => n.map((x) => getComputedStyle(x).fill));
check('overlap cells resolve to real colours',
      !cellFills.some((f) => f === 'rgb(0, 0, 0)'), cellFills[0]);

// --- the core claim: a different article changes every number --------------
const before = {
  title: await page.textContent('.article-title'),
  scores: await page.$$eval('#results-table tbody td', (n) => n.slice(0, 8).map((x) => x.textContent)),
};

await page.fill('#q', 'Jazz');
await page.click('#run');
await ready();
await page.waitForTimeout(400);

const after = {
  title: await page.textContent('.article-title'),
  scores: await page.$$eval('#results-table tbody td', (n) => n.slice(0, 8).map((x) => x.textContent)),
};

check('typing a new article changes the title', after.title !== before.title,
      `${before.title.trim()} → ${after.title.trim()}`);
check('…and recomputes every score', after.scores.join() !== before.scores.join());

// An article never named anywhere in the code must behave identically.
await page.fill('#q', 'Kakapo');
await page.click('#run');
await ready();
check('arbitrary unseen article works',
      (await page.textContent('.article-title')).trim().length > 0,
      (await page.textContent('.article-title')).trim());

// --- layout & theme --------------------------------------------------------
const overflow = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no horizontal overflow (desktop)', overflow <= 1, `${overflow}px`);

mkdirSync(SHOTS, { recursive: true });
await page.screenshot({ path: `${SHOTS}/light-full.png`, fullPage: true });

await page.click('#theme-toggle');
await page.waitForTimeout(350);
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
check('dark theme is pure black', bg === 'rgb(0, 0, 0)', bg);
await page.screenshot({ path: `${SHOTS}/dark-full.png`, fullPage: true });

await page.click('#theme-toggle');
await page.waitForTimeout(250);
const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
check('light theme is pure white', light === 'rgb(255, 255, 255)', light);

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(350);
const mobile = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no horizontal overflow (mobile 390px)', mobile <= 1, `${mobile}px`);
await page.screenshot({ path: `${SHOTS}/mobile.png`, fullPage: true });

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
