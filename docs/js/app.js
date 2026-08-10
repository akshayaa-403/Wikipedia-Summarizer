/* Page controller: live demo, benchmark rendering, explorer. */

import { fetchArticle, textrank, chunkByTokens, estimateTokens, rouge } from './wiki.js';
import { groupedColumns } from './charts.js';

const $ = (selector, root = document) => root.querySelector(selector);
const BART_WINDOW = 1024;

/* Fixed slot order — a method keeps its colour everywhere on the page, in the
 * charts, the table, the explorer and the method cards alike. */
const METHODS = [
  { key: 'lexrank',        label: 'LexRank',          color: 'var(--series-1)', kind: 'extractive' },
  { key: 'lsa',            label: 'LSA',              color: 'var(--series-2)', kind: 'extractive' },
  { key: 'bart_truncated', label: 'BART (truncated)', color: 'var(--series-3)', kind: 'abstractive' },
  { key: 'bart_mapreduce', label: 'BART (map-reduce)', color: 'var(--series-4)', kind: 'abstractive' },
];

const ROUGE_KEYS = [
  ['rouge1', 'ROUGE-1'],
  ['rouge2', 'ROUGE-2'],
  ['rougeL', 'ROUGE-L'],
];

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const commas = (n) => n.toLocaleString('en-US');

/* ------------------------------------------------------------------ theme */

const toggle = $('#theme-toggle');
const stored = localStorage.getItem('wikisum-theme');
if (stored) document.documentElement.dataset.theme = stored;

toggle.addEventListener('click', () => {
  const isDark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = isDark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('wikisum-theme', next);
  // No chart redraw: marks are filled with var(--series-N), and var() resolves
  // in SVG presentation attributes, so they retheme themselves.
});

/* ------------------------------------------------------- section 1 figures */

function drawChunkFigures() {
  const total = 12;
  $('#fig-trunc').innerHTML =
    Array.from({ length: total }, (_, i) =>
      `<i class="${i === 0 ? '' : 'dropped'}"></i>`).join('');
  $('#fig-mr').innerHTML = '<i></i>'.repeat(total);
}

/* --------------------------------------------------------------- live demo */

const form = $('#demo-form');
const input = $('#q');
const runButton = $('#run');
const panel = $('#live-panel');

for (const button of document.querySelectorAll('.suggests button')) {
  button.addEventListener('click', () => {
    input.value = button.dataset.title;
    form.requestSubmit();
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = input.value.trim();
  if (!title) return;

  runButton.disabled = true;
  panel.hidden = false;
  panel.innerHTML = `<div class="notice"><span class="spinner"></span>Fetching “${escapeHtml(title)}” from Wikipedia…</div>`;

  try {
    const article = await fetchArticle(title);
    renderLive(article);
  } catch (error) {
    panel.innerHTML = `<div class="notice bad"><strong>Couldn't summarize that.</strong><br>${escapeHtml(error.message)}</div>`;
  } finally {
    runButton.disabled = false;
  }
});

function renderLive(article) {
  const bodyTokens = estimateTokens(article.body);
  const chunks = chunkByTokens(article.body);
  const coverage = Math.min(1, BART_WINDOW / bodyTokens);
  const bodyWords = article.body.split(/\s+/).filter(Boolean).length;

  const started = performance.now();
  const { sentences, total } = textrank(article.body, { count: 5 });
  const elapsed = Math.round(performance.now() - started);

  const summary = sentences.join(' ');
  const scores = rouge(summary, article.lead);

  const stat = (k, v, sub = '', warn = false) => `
    <div class="stat">
      <div class="k">${k}</div>
      <div class="v${warn ? ' warn' : ''}">${v}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ''}
    </div>`;

  panel.innerHTML = `
    <div class="statbar">
      ${stat('Article', commas(article.wordCount), 'words total')}
      ${stat('Body', commas(bodyWords), `${article.sections.length} sections`)}
      ${stat('Chunks needed', chunks.length, `at ~900 tokens each`)}
      ${stat('One BART window sees', `${Math.round(coverage * 100)}%`, 'of the body', coverage < 0.5)}
      ${stat('Sentences ranked', commas(total), `in ${elapsed} ms`)}
    </div>

    <div class="card">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <span class="swatch" style="width:10px;height:10px;border-radius:3px;background:var(--series-1);display:inline-block"></span>
        <strong style="font-size:14.5px">TextRank summary</strong>
        <span class="kind">extractive · live in your browser</span>
        <a style="margin-left:auto;font-size:13.5px" href="${article.url}" target="_blank" rel="noopener">${escapeHtml(article.title)} on Wikipedia ↗</a>
      </div>

      <p class="summary-out">${escapeHtml(summary)}</p>

      <div class="cmp-scores" style="margin:16px -24px -24px;border-radius:0 0 13px 13px">
        ${ROUGE_KEYS.map(([key, label]) =>
          `<div><span>${label}</span> <b>${scores[key].toFixed(3)}</b></div>`).join('')}
        <div style="margin-left:auto;color:var(--muted)">scored against the article's ${article.lead.split(/\s+/).length}-word lead section</div>
      </div>
    </div>

    <p style="font-size:13.5px;color:var(--muted);margin-top:14px">
      This ran entirely client-side: TextRank over all ${commas(total)} sentences, with no
      context window to truncate. Summarizing the same article with BART would mean
      ${chunks.length} model calls against a 1.6&nbsp;GB checkpoint — minutes of CPU time and
      a backend GitHub Pages doesn't have, so those results are
      <a href="#results">precomputed below</a>.
    </p>`;
}

/* --------------------------------------------------------------- benchmark */

let benchmark = null;
let chartView = 'chart';

async function loadBenchmark() {
  try {
    const response = await fetch('data/results.json');
    if (!response.ok) throw new Error(String(response.status));
    benchmark = await response.json();
  } catch {
    for (const id of ['#results', '#explorer']) {
      $(`${id} .wrap`).insertAdjacentHTML('beforeend',
        `<div class="notice bad" style="margin-top:20px">
           Benchmark data not found. Run
           <code>python -m wikisum.benchmark --out docs/data/results.json</code>
           to generate it.
         </div>`);
    }
    return;
  }

  renderHeadline();
  renderRougeChart();
  renderTable();
  renderExplorer();

  $('#generated-stamp').textContent =
    `Benchmark generated ${benchmark.generated_utc.replace('T', ' ').replace('Z', ' UTC')}`;

  const n = benchmark.articles.length;
  const words = Math.round(
    benchmark.articles.reduce((sum, a) => sum + a.body_word_count, 0) / n);
  const coverage = benchmark.articles.reduce(
    (sum, a) => sum + a.truncation_coverage, 0) / n;

  $('#results-intro').insertAdjacentHTML('beforeend',
    ` <strong>${n} articles, averaging ${commas(words)} words of body text each.</strong>
      Every method is held to the same ~${benchmark.config?.target_words ?? 150}-word
      output budget, so the ROUGE column compares summaries of comparable length
      rather than rewarding whichever method happens to be the most verbose.`);

  // Keep the hero's figures tied to the data rather than hand-maintained.
  $('#hero-words').textContent = `${commas(words)} words`;
  $('#hero-lost').textContent = `${Math.round((1 - coverage) * 100)}%`;
}

const present = () => METHODS.filter((m) => benchmark.methods[m.key]);

function renderHeadline() {
  const truncated = benchmark.methods.bart_truncated;
  const mapreduce = benchmark.methods.bart_mapreduce;
  const box = $('#headline-stats');
  if (!truncated || !mapreduce) { box.remove(); return; }

  const lift = (key) =>
    ((mapreduce.rouge[key] - truncated.rouge[key]) / truncated.rouge[key]) * 100;

  const signed = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`;
  const good = (v) => v >= 0 ? 'style="color:var(--good)"' : 'style="color:var(--critical)"';

  box.innerHTML = `
    <div class="stat">
      <div class="k">Coverage gained</div>
      <div class="v">${Math.round((1 - truncated.avg_input_coverage) * 100)} pts</div>
      <div class="sub">${Math.round(truncated.avg_input_coverage * 100)}% → 100% of the body</div>
    </div>
    <div class="stat">
      <div class="k">ROUGE-1 change</div>
      <div class="v" ${good(lift('rouge1'))}>${signed(lift('rouge1'))}</div>
      <div class="sub">map-reduce vs. truncated</div>
    </div>
    <div class="stat">
      <div class="k">ROUGE-2 change</div>
      <div class="v" ${good(lift('rouge2'))}>${signed(lift('rouge2'))}</div>
      <div class="sub">map-reduce vs. truncated</div>
    </div>
    <div class="stat">
      <div class="k">Cost of the fix</div>
      <div class="v">${(mapreduce.avg_seconds / truncated.avg_seconds).toFixed(1)}×</div>
      <div class="sub">${mapreduce.avg_chunks} model calls vs. 1</div>
    </div>`;
}

function renderRougeChart() {
  const box = $('#rouge-chart');
  const methods = present();

  $('#rouge-legend').innerHTML = methods.map((m) => `
    <span class="item"><span class="swatch" style="background:${m.color}"></span>${m.label}</span>`).join('');

  box.innerHTML = '';
  if (chartView === 'table') { box.appendChild(rougeMiniTable()); return; }

  box.appendChild(groupedColumns({
    groups: ROUGE_KEYS.map(([, label]) => label),
    series: methods,
    value: (key, gi) => benchmark.methods[key].rouge[ROUGE_KEYS[gi][0]],
    tip: (key, gi) => {
      const m = benchmark.methods[key];
      const type = ROUGE_KEYS[gi][0];
      return `<b>${m.label}</b><br>${ROUGE_KEYS[gi][1]}: ${m.rouge[type].toFixed(3)}
              <br>± ${m.rouge_stdev[type].toFixed(3)} across ${m.articles_scored} articles`;
    },
    yLabel: 'F-measure',
  }));
}

function rougeMiniTable() {
  const table = document.createElement('table');
  table.innerHTML = `
    <thead><tr><th>Method</th>${ROUGE_KEYS.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead>
    <tbody>${present().map((m) => {
      const row = benchmark.methods[m.key];
      return `<tr><td><div class="method"><span class="swatch" style="background:${m.color}"></span>${m.label}</div></td>
        ${ROUGE_KEYS.map(([k]) => `<td>${row.rouge[k].toFixed(3)}</td>`).join('')}</tr>`;
    }).join('')}</tbody>`;
  const scroll = document.createElement('div');
  scroll.className = 'table-scroll';
  scroll.appendChild(table);
  return scroll;
}

$('#chart-toggle').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  chartView = button.dataset.view;
  for (const b of $('#chart-toggle').children) {
    b.setAttribute('aria-pressed', String(b === button));
  }
  renderRougeChart();
});

function renderTable() {
  const table = $('#results-table');
  const methods = present();

  const columns = [
    ...ROUGE_KEYS.map(([key, label]) => ({
      label, get: (r) => r.rouge[key], format: (v) => v.toFixed(3), best: 'max',
    })),
    { label: 'Body read', get: (r) => r.avg_input_coverage,
      format: (v) => `${Math.round(v * 100)}%`, best: 'max' },
    { label: 'Chunks', get: (r) => r.avg_chunks, format: (v) => v.toFixed(1), best: null },
    { label: 'Length', get: (r) => r.avg_words, format: (v) => `${Math.round(v)}w`, best: null },
    { label: 'Time', get: (r) => r.avg_seconds,
      format: (v) => v < 1 ? `${(v * 1000).toFixed(0)} ms` : `${v.toFixed(1)} s`, best: 'min' },
  ];

  const bests = columns.map((column) => {
    if (!column.best) return null;
    const values = methods.map((m) => column.get(benchmark.methods[m.key]));
    return column.best === 'max' ? Math.max(...values) : Math.min(...values);
  });

  table.innerHTML = `
    <caption>Full comparison. Best value in each column is emphasised.</caption>
    <thead><tr>
      <th>Method</th><th>Type</th>
      ${columns.map((c) => `<th>${c.label}</th>`).join('')}
    </tr></thead>
    <tbody>
      ${methods.map((m) => {
        const row = benchmark.methods[m.key];
        return `<tr>
          <td><div class="method"><span class="swatch" style="background:${m.color}"></span>${m.label}</div></td>
          <td style="text-align:left"><span class="kind">${row.kind}</span></td>
          ${columns.map((c, i) => {
            const v = c.get(row);
            const isBest = bests[i] !== null && Math.abs(v - bests[i]) < 1e-9;
            return `<td class="${isBest ? 'best' : ''}">${c.format(v)}</td>`;
          }).join('')}
        </tr>`;
      }).join('')}
    </tbody>`;
}

/* --------------------------------------------------------------- explorer */

function renderExplorer() {
  const select = $('#article-select');
  select.innerHTML = benchmark.articles
    .map((a, i) => `<option value="${i}">${escapeHtml(a.title)}</option>`).join('');
  select.addEventListener('change', () => renderCompare(Number(select.value)));
  renderCompare(0);
}

function renderCompare(index) {
  const article = benchmark.articles[index];

  $('#article-meta').innerHTML =
    `${commas(article.word_count)} words · ${article.section_count} sections ·
     body splits into ${article.chunk_count} chunks ·
     one window covers ${Math.round(article.truncation_coverage * 100)}% ·
     <a href="${article.url}" target="_blank" rel="noopener">source ↗</a>`;

  const reference = `
    <article class="cmp-card ref-card" style="grid-column:1/-1">
      <header>
        <span class="name">Reference — the article's lead section</span>
        <span class="meta">${article.lead_word_count} words · human-written</span>
      </header>
      <div class="cmp-body">${escapeHtml(article.reference)}</div>
    </article>`;

  const cards = METHODS.filter((m) => article.summaries[m.key]).map((m) => {
    const row = article.summaries[m.key];
    const meta = row.chunks_processed > 1
      ? `${row.chunks_processed} chunks · ${row.passes} passes · ${row.seconds}s`
      : `${Math.round(row.input_coverage * 100)}% of body · ${row.seconds}s`;

    return `
      <article class="cmp-card">
        <header>
          <span class="swatch" style="background:${m.color}"></span>
          <span class="name">${m.label}</span>
          <span class="meta">${meta}</span>
        </header>
        <div class="cmp-body">${escapeHtml(row.text)}</div>
        <div class="cmp-scores">
          ${ROUGE_KEYS.map(([key, label]) =>
            `<div><span>${label}</span> <b>${row.rouge[key].toFixed(3)}</b></div>`).join('')}
          <div style="margin-left:auto"><span>Length</span> <b>${row.word_count}w</b></div>
        </div>
      </article>`;
  }).join('');

  $('#compare').innerHTML = reference + cards;
}

drawChunkFigures();
loadBenchmark();
form.requestSubmit();
