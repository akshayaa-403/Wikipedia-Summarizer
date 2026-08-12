/* Page controller.
 *
 * Everything on this page is computed in the browser from whatever article is
 * typed in: four summaries, their ROUGE scores against Wikipedia's own lead,
 * and every chart. There is no backend and no precomputed data file, so an
 * article nobody anticipated behaves exactly like one that was.
 */

import { fetchArticle, rouge } from './wiki.js';
import { METHODS, summarizeAll, humanCeiling, describe, keyTerms, redundancy } from './summarizers.js';
import {
  groupedColumns, overlapMatrix, slopegraph, quadrant,
  termCoverage, positionDensity,
} from './charts.js';

const $ = (sel, root = document) => root.querySelector(sel);

/* Fixed slot order: a method keeps its colour in every chart, table and panel. */
const COLORS = {
  textrank: 'var(--series-1)',
  lsa:      'var(--series-2)',
  luhn:     'var(--series-3)',
  mmr:      'var(--series-4)',
};

const ROUGE_KEYS = [['rouge1', 'ROUGE-1'], ['rouge2', 'ROUGE-2'], ['rougeL', 'ROUGE-L']];

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const commas = (n) => n.toLocaleString('en-US');
const pct = (v) => `${Math.round(v * 100)}%`;

const SUGGESTIONS = ['Penguin', 'Black hole', 'Roman Empire', 'Photosynthesis', 'Jazz'];

/* ------------------------------------------------------------------ theme */

const stored = localStorage.getItem('wikisum-theme');
if (stored) document.documentElement.dataset.theme = stored;

$('#theme-toggle').addEventListener('click', () => {
  const isDark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = isDark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('wikisum-theme', next);
  // Charts fill with var(--series-N) and var() resolves in SVG presentation
  // attributes, so marks retheme themselves with no redraw.
});

/* ------------------------------------------------------------------ input */

const form = $('#demo-form');
const input = $('#q');
const runButton = $('#run');

$('#suggests').innerHTML = 'Try ' + SUGGESTIONS
  .map((t) => `<button type="button" data-title="${escapeHtml(t)}">${escapeHtml(t)}</button>`)
  .join(' ');

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-title]');
  if (!button) return;
  input.value = button.dataset.title;
  form.requestSubmit();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = input.value.trim();
  if (!title) return;

  runButton.disabled = true;
  $('#status').innerHTML =
    `<p class="notice"><span class="spinner"></span>Fetching “${escapeHtml(title)}” …</p>`;

  // Clear the previous article's output before awaiting. Otherwise the old
  // cards and charts stay on screen for the whole fetch, which reads as though
  // the new results are already in.
  delete document.body.dataset.loaded;
  $('#summaries').innerHTML = '';
  $('#results-table').innerHTML = '';
  for (const id of ['#rouge-chart', '#slope-chart', '#quadrant-chart',
                    '#overlap-chart', '#terms-chart',
                    '#density-chart']) {
    $(id).innerHTML = '';
  }

  try {
    const article = await fetchArticle(title);
    render(article);
    $('#status').innerHTML = '';
    document.body.dataset.loaded = 'true';
  } catch (error) {
    $('#status').innerHTML =
      `<p class="notice bad"><strong>Couldn't summarize that.</strong> ${escapeHtml(error.message)}</p>`;
  } finally {
    runButton.disabled = false;
  }
});

/* ----------------------------------------------------------------- render */

function render(article) {
  const { analysis, results } = summarizeAll(article.body);
  const ceilingText = humanCeiling(article.lead);

  const terms = keyTerms(analysis, 20);

  // Every row scored the same way, against the article's full lead section.
  const rows = METHODS.map((m) => {
    const r = results[m.key];
    const lower = r.text.toLowerCase();
    const hit = terms.filter((t) => lower.includes(t));
    return {
      ...m,
      color: COLORS[m.key],
      text: r.text,
      indices: r.indices,
      ms: r.ms,
      stats: describe(r.text),
      scores: rouge(r.text, article.lead),
      redundancy: redundancy(analysis, r.indices),
      termHit: hit.length,
      termMissed: terms.filter((t) => !lower.includes(t)),
    };
  });

  const ceiling = {
    key: 'human',
    label: 'Wikipedia (human)',
    text: ceilingText,
    stats: describe(ceilingText),
    scores: rouge(ceilingText, article.lead),
  };

  renderHeader(article, analysis);
  renderSummaries(article, rows, ceiling);
  renderMetrics(rows, ceiling, analysis, article, terms);
}

/* --------------------------------------------------------------- header -- */

function renderHeader(article, analysis) {
  const bodyWords = article.body.split(/\s+/).filter(Boolean).length;

  $('#article-head').innerHTML = `
    <h2 class="article-title">${escapeHtml(article.title)}</h2>
    <p class="article-meta">
      ${commas(bodyWords)} words · ${commas(analysis.sentences.length)} sentences ·
      ${article.sections.length} sections ·
      <a href="${article.url}" target="_blank" rel="noopener">Wikipedia ↗</a>
    </p>`;
}

/* ------------------------------------------------------------ summaries -- */

function statLine(s) {
  const mins = s.readingSeconds >= 60
    ? `${Math.floor(s.readingSeconds / 60)}m ${s.readingSeconds % 60}s`
    : `${s.readingSeconds}s`;
  return `
    <dl class="sumstats">
      <div><dt>words</dt><dd>${s.words}</dd></div>
      <div><dt>sentences</dt><dd>${s.sentences}</dd></div>
      <div><dt>read</dt><dd>${mins}</dd></div>
      <div><dt>avg sent.</dt><dd>${s.avgSentence}w</dd></div>
      <div><dt>reading ease</dt><dd>${s.flesch}</dd></div>
      <div><dt>unique words</dt><dd>${pct(s.uniqueRatio)}</dd></div>
    </dl>`;
}

function renderSummaries(article, rows, ceiling) {
  const leadWords = article.lead.split(/\s+/).length;

  const reference = `
    <article class="card reference">
      <header>
        <span class="tag">Wikipedia's own summary</span>
        <span class="meta">${leadWords} words · the reference every score is measured against</span>
      </header>
      <p class="summary-text">${escapeHtml(article.lead)}</p>
      ${statLine(describe(article.lead))}
    </article>`;

  const cards = rows.map((r) => `
    <article class="card">
      <header>
        <span class="dot" style="background:${r.color}"></span>
        <span class="tag">${r.label}</span>
        <span class="meta">${r.blurb} · ${r.ms.toFixed(0)} ms</span>
      </header>
      <p class="summary-text">${escapeHtml(r.text)}</p>
      ${statLine(r.stats)}
      <div class="cardscores">
        ${ROUGE_KEYS.map(([k, l]) =>
          `<span><i>${l}</i> <b>${r.scores[k].toFixed(3)}</b></span>`).join('')}
        <span class="reach"><i>of human</i> <b>${
          ceiling.scores.rouge1 ? pct(r.scores.rouge1 / ceiling.scores.rouge1) : '—'}</b></span>
      </div>
    </article>`).join('');

  $('#summaries').innerHTML = reference + cards;
}

/* -------------------------------------------------------------- metrics -- */

function renderMetrics(rows, ceiling, analysis, article, terms) {
  const series = rows.map((r) => ({ key: r.key, label: r.label, color: r.color }));

  // --- grouped bars, with the human ceiling as a dashed rule per group ----
  $('#rouge-legend').innerHTML = [...series, { label: 'Wikipedia (human)', color: 'transparent' }]
    .map((s, i) => `
      <span class="item">
        <span class="swatch${i === series.length ? ' ceiling' : ''}"
              style="${i === series.length ? '' : `background:${s.color}`}"></span>${s.label}
      </span>`).join('');

  const chartBox = $('#rouge-chart');
  chartBox.innerHTML = '';
  chartBox.appendChild(groupedColumns({
    groups: ROUGE_KEYS.map(([, l]) => l),
    series,
    value: (key, gi) => rows.find((r) => r.key === key).scores[ROUGE_KEYS[gi][0]],
    ceiling: ROUGE_KEYS.map(([k]) => ceiling.scores[k]),
    tip: (key, gi) => {
      const r = rows.find((x) => x.key === key);
      const k = ROUGE_KEYS[gi][0];
      const reach = ceiling.scores[k] ? pct(r.scores[k] / ceiling.scores[k]) : '—';
      return `<b>${r.label}</b><br>${ROUGE_KEYS[gi][1]}: ${r.scores[k].toFixed(3)}` +
             `<br>${reach} of the human ceiling`;
    },
  }));

  // --- table -------------------------------------------------------------
  const cols = [
    ...ROUGE_KEYS.map(([k, l]) => ({ label: l, get: (r) => r.scores[k], fmt: (v) => v.toFixed(3), best: 'max' })),
    { label: '% of human', get: (r) => ceiling.scores.rouge1 ? r.scores.rouge1 / ceiling.scores.rouge1 : 0,
      fmt: pct, best: 'max' },
    { label: 'Words', get: (r) => r.stats.words, fmt: (v) => v, best: null },
    { label: 'Sentences', get: (r) => r.stats.sentences, fmt: (v) => v, best: null },
    { label: 'Read', get: (r) => r.stats.readingSeconds, fmt: (v) => `${v}s`, best: null },
    { label: 'Ease', get: (r) => r.stats.flesch, fmt: (v) => v, best: 'max' },
    { label: 'Time', get: (r) => r.ms, fmt: (v) => `${v.toFixed(0)} ms`, best: 'min' },
  ];

  const bests = cols.map((c) => {
    if (!c.best) return null;
    const vals = rows.map((r) => c.get(r));
    return c.best === 'max' ? Math.max(...vals) : Math.min(...vals);
  });

  $('#results-table').innerHTML = `
    <caption>Every figure recomputed for this article. Best in each column emphasised.</caption>
    <thead><tr><th>Method</th>${cols.map((c) => `<th>${c.label}</th>`).join('')}</tr></thead>
    <tbody>
      <tr class="ceiling-row">
        <td><div class="method"><span class="dot ceiling"></span>Wikipedia (human)</div></td>
        ${ROUGE_KEYS.map(([k]) => `<td>${ceiling.scores[k].toFixed(3)}</td>`).join('')}
        <td>100%</td>
        <td>${ceiling.stats.words}</td>
        <td>${ceiling.stats.sentences}</td>
        <td>${ceiling.stats.readingSeconds}s</td>
        <td>${ceiling.stats.flesch}</td>
        <td>—</td>
      </tr>
      ${rows.map((r) => `
        <tr>
          <td><div class="method"><span class="dot" style="background:${r.color}"></span>${r.label}</div></td>
          ${cols.map((c, i) => {
            const v = c.get(r);
            const isBest = bests[i] !== null && Math.abs(v - bests[i]) < 1e-9;
            return `<td class="${isBest ? 'best' : ''}">${c.fmt(v)}</td>`;
          }).join('')}
        </tr>`).join('')}
    </tbody>`;

  // --- rank stability across the three metrics ---------------------------
  const slope = $('#slope-chart');
  slope.innerHTML = '';
  slope.appendChild(slopegraph({
    metrics: ROUGE_KEYS.map(([, l]) => l),
    methods: rows.map((r) => ({
      key: r.key, label: r.label, color: r.color,
      values: ROUGE_KEYS.map(([k]) => r.scores[k]),
    })),
  }));

  // --- coverage against redundancy ---------------------------------------
  const quad = $('#quadrant-chart');
  quad.innerHTML = '';
  quad.appendChild(quadrant({
    points: rows.map((r) => ({
      label: r.label, color: r.color,
      coverage: terms.length ? r.termHit / terms.length : 0,
      redundancy: r.redundancy,
    })),
  }));

  // --- overlap matrix ----------------------------------------------------
  const overlap = $('#overlap-chart');
  overlap.innerHTML = '';
  overlap.appendChild(overlapMatrix({
    methods: rows.map((r) => ({ label: r.label, indices: r.indices })),
  }));

  // --- key-term coverage -------------------------------------------------
  const cov = $('#terms-chart');
  cov.innerHTML = '';
  cov.appendChild(termCoverage({
    totalTerms: terms.length,
    rows: rows.map((r) => ({
      label: r.label, color: r.color, hit: r.termHit, missed: r.termMissed,
    })),
  }));

  // --- positional density -------------------------------------------------
  const densityBox = $('#density-chart');
  densityBox.innerHTML = '';
  densityBox.appendChild(positionDensity({
    methods: rows.map((r) => ({ label: r.label, color: r.color, indices: r.indices })),
    total: analysis.sentences.length,
  }));
}

/* Kick off with whatever is in the field. */
form.requestSubmit();
