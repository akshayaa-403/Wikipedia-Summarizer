/* Live Wikipedia fetch + a TextRank summarizer that runs in the browser.
 *
 * GitHub Pages serves static files only, so the Python pipeline (BART, ROUGE)
 * cannot run here. What CAN run live is the extractive half: Wikipedia's API is
 * CORS-enabled with `origin=*`, and TextRank is a few hundred lines of array
 * maths. So the demo summarizes any article the visitor names, using the same
 * lead/body split and the same sentence-boundary chunking as the Python
 * package. The abstractive results are precomputed and shown in section 3.
 */

const API = 'https://en.wikipedia.org/w/api.php';

const BOILERPLATE = new Set([
  'see also', 'references', 'further reading', 'external links', 'notes',
  'citations', 'bibliography', 'sources', 'footnotes',
]);

const HEADING = /^={2,}\s*(.+?)\s*={2,}$/gm;

/* Words carrying no topical signal. Left in, they dominate every sentence-pair
 * similarity and TextRank degenerates to ranking by sentence length. */
const STOPWORDS = new Set(`a about above after again against all am an and any are aren't as at be
because been before being below between both but by can't cannot could couldn't did didn't do does
doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having
he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in
into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only
or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't
so some such than that that's the their theirs them themselves then there there's these they they'd
they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're
we've were weren't what what's when when's where where's which while who who's whom why why's with
won't would wouldn't you you'd you'll you're you've your yours yourself yourselves also many one two
first new used using include including its been more`.split(/\s+/));

/* ------------------------------------------------------------------ fetch */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Wikipedia rate-limits by client IP and answers 429 when a visitor (or a
 * shared campus/office address) runs several summaries in quick succession.
 * Retry with exponential backoff, then surface something a human can act on
 * rather than a bare status code. */
async function apiGet(params, { retries = 3 } = {}) {
  const url = `${API}?${new URLSearchParams({ ...params, format: 'json', origin: '*' })}`;

  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url);
    } catch (cause) {
      if (attempt >= retries - 1) throw new Error('Could not reach Wikipedia. Check your connection and try again.');
      await sleep(2 ** attempt * 500);
      continue;
    }

    if (response.ok) return response.json();

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= retries - 1) {
      throw new Error(response.status === 429
        ? 'Wikipedia is rate-limiting this connection. Wait a few seconds and try again.'
        : `Wikipedia returned HTTP ${response.status}.`);
    }

    const after = Number(response.headers.get('retry-after'));
    await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2 ** attempt * 800);
  }
}

export async function fetchArticle(title) {
  const data = await apiGet({
    action: 'query',
    prop: 'extracts|info',
    explaintext: '1',
    redirects: '1',
    inprop: 'url',
    titles: title,
  });

  const pages = data?.query?.pages ?? {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined || !page.extract) {
    throw new Error(`No Wikipedia article found for "${title}".`);
  }
  return splitArticle(page.extract, page.title, page.fullurl);
}

/* Lead section = the human-written summary of the article. Body = the rest,
 * minus link-list sections. Mirrors wikisum/fetch.py exactly. */
function splitArticle(text, title, url) {
  HEADING.lastIndex = 0;
  const first = HEADING.exec(text);
  const lead = (first ? text.slice(0, first.index) : text).trim();
  const rest = first ? text.slice(first.index) : '';

  const parts = rest.split(/^={2,}\s*(.+?)\s*={2,}$/gm);
  let body = '';
  for (let i = 1; i < parts.length; i += 2) {
    if (BOILERPLATE.has(parts[i].trim().toLowerCase())) continue;
    body += `${parts[i]}\n${parts[i + 1] ?? ''}\n\n`;
  }

  const clean = (s) => s.replace(/={2,}.*?={2,}/g, ' ')
                        .replace(/\n{2,}/g, '\n\n')
                        .replace(/[ \t]{2,}/g, ' ')
                        .trim();

  HEADING.lastIndex = 0;
  const sections = [...text.matchAll(HEADING)].map((m) => m[1]);

  return {
    title, url,
    lead: clean(lead),
    body: clean(body) || clean(lead),
    sections,
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

/* --------------------------------------------------------------- sentences */

const ABBREV = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs',
  'etc', 'e.g', 'i.e', 'cf', 'al', 'inc', 'ltd', 'co', 'corp', 'no', 'vol',
  'fig', 'approx', 'ca', 'c', 'ad', 'bc', 'u.s', 'u.k']);

export function sentenceSplit(text) {
  const out = [];
  let buffer = '';
  for (const piece of text.split(/(?<=[.!?])["')\]]*\s+/)) {
    buffer = buffer ? `${buffer} ${piece}` : piece;
    const lastWord = buffer.split(/\s+/).pop().replace(/["')\].!?]+$/, '').toLowerCase();
    if (ABBREV.has(lastWord)) continue;
    if (buffer.trim()) { out.push(buffer.trim()); buffer = ''; }
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out.filter((s) => s.split(/\s+/).length >= 5);
}

/* Same estimator as chunking.py: ~1.4 BPE tokens per whitespace word. */
export const estimateTokens = (text) => Math.round(text.split(/\s+/).filter(Boolean).length * 1.4) + 2;

/* Sentence-aligned, overlapping windows — the browser mirror of chunk_by_tokens. */
export function chunkByTokens(text, { maxTokens = 900, overlapSentences = 1 } = {}) {
  const sentences = sentenceSplit(text);
  const chunks = [];
  let current = [];
  let tokens = 0;

  for (const sentence of sentences) {
    const cost = estimateTokens(sentence);
    if (current.length && tokens + cost > maxTokens) {
      chunks.push({ text: current.join(' '), tokens, sentences: current.length });
      current = overlapSentences ? current.slice(-overlapSentences) : [];
      tokens = current.reduce((sum, s) => sum + estimateTokens(s), 0);
    }
    current.push(sentence);
    tokens += cost;
  }
  if (current.length) chunks.push({ text: current.join(' '), tokens, sentences: current.length });
  return chunks;
}

/* --------------------------------------------------------------- TextRank */

function tokenize(sentence) {
  return sentence.toLowerCase().match(/[a-z][a-z'-]+/g)?.filter(
    (w) => w.length > 2 && !STOPWORDS.has(w)) ?? [];
}

/* Cosine similarity over IDF-weighted term counts. IDF stops a term that
 * appears in every sentence (the article's own subject) from making all
 * sentences look alike. */
function similarityMatrix(tokenized, idf) {
  const vectors = tokenized.map((words) => {
    const vector = new Map();
    for (const word of words) vector.set(word, (vector.get(word) ?? 0) + 1);
    let norm = 0;
    for (const [word, count] of vector) {
      const weight = count * (idf.get(word) ?? 0);
      vector.set(word, weight);
      norm += weight * weight;
    }
    return { vector, norm: Math.sqrt(norm) || 1 };
  });

  const n = vectors.length;
  const matrix = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const [small, large] = vectors[i].vector.size < vectors[j].vector.size
        ? [vectors[i], vectors[j]] : [vectors[j], vectors[i]];
      let dot = 0;
      for (const [word, weight] of small.vector) {
        const other = large.vector.get(word);
        if (other) dot += weight * other;
      }
      const sim = dot / (vectors[i].norm * vectors[j].norm);
      matrix[i][j] = matrix[j][i] = sim;
    }
  }
  return matrix;
}

/**
 * TextRank: PageRank over a graph whose nodes are sentences and whose edge
 * weights are sentence similarity. A sentence scores highly when it is similar
 * to many other high-scoring sentences — i.e. when it restates what the article
 * keeps coming back to.
 *
 * Unlike BART this has no context window: the whole article is one graph, so
 * length is never a reason to discard text.
 */
export function textrank(text, { count = 5, damping = 0.85, iterations = 40 } = {}) {
  const sentences = sentenceSplit(text);
  if (sentences.length <= count) return { sentences, scores: sentences.map(() => 1), total: sentences.length };

  const tokenized = sentences.map(tokenize);

  const documentFrequency = new Map();
  for (const words of tokenized) {
    for (const word of new Set(words)) {
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
  }
  const n = sentences.length;
  const idf = new Map();
  for (const [word, frequency] of documentFrequency) {
    idf.set(word, Math.log(n / (1 + frequency)) + 1);
  }

  const matrix = similarityMatrix(tokenized, idf);

  // Row-normalise into a transition matrix; a sentence similar to nothing gets
  // a uniform row so its rank leaks back into the graph rather than vanishing.
  const rowSums = matrix.map((row) => row.reduce((a, b) => a + b, 0));
  let ranks = new Float64Array(n).fill(1 / n);

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Float64Array(n).fill((1 - damping) / n);
    for (let i = 0; i < n; i++) {
      if (rowSums[i] === 0) {
        const share = damping * ranks[i] / n;
        for (let j = 0; j < n; j++) next[j] += share;
        continue;
      }
      for (let j = 0; j < n; j++) {
        if (matrix[i][j] > 0) next[j] += damping * ranks[i] * matrix[i][j] / rowSums[i];
      }
    }
    let delta = 0;
    for (let i = 0; i < n; i++) delta += Math.abs(next[i] - ranks[i]);
    ranks = next;
    if (delta < 1e-6) break;
  }

  // Take the top-ranked sentences, then restore document order so the summary
  // reads as prose instead of as a ranked list.
  const chosen = [...ranks.keys()]
    .sort((a, b) => ranks[b] - ranks[a])
    .slice(0, count)
    .sort((a, b) => a - b);

  return {
    sentences: chosen.map((i) => sentences[i]),
    scores: chosen.map((i) => ranks[i]),
    total: n,
  };
}

/* ------------------------------------------------------------------ ROUGE */

const stem = (word) => word
  .replace(/(ational|tional|ization|iveness|fulness|ousness)$/, '')
  .replace(/(ing|edly|ed|ly|es|s)$/, '')
  .replace(/(.)\1$/, '$1');

const rougeTokens = (text) =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem);

function ngramF(prediction, reference, n) {
  const grams = (tokens) => {
    const counts = new Map();
    for (let i = 0; i + n <= tokens.length; i++) {
      const key = tokens.slice(i, i + n).join(' ');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };

  const predicted = grams(rougeTokens(prediction));
  const referenced = grams(rougeTokens(reference));
  let overlap = 0;
  for (const [gram, count] of predicted) {
    overlap += Math.min(count, referenced.get(gram) ?? 0);
  }

  const predictedTotal = [...predicted.values()].reduce((a, b) => a + b, 0);
  const referenceTotal = [...referenced.values()].reduce((a, b) => a + b, 0);
  if (!overlap) return 0;

  const precision = overlap / predictedTotal;
  const recall = overlap / referenceTotal;
  return (2 * precision * recall) / (precision + recall);
}

/* LCS length via the rolling-row DP — full matrix is O(n*m) memory and these
 * texts run to a few thousand tokens. */
function lcsF(prediction, reference) {
  const a = rougeTokens(prediction);
  const b = rougeTokens(reference);
  if (!a.length || !b.length) return 0;

  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }

  const lcs = previous[b.length];
  if (!lcs) return 0;
  const precision = lcs / a.length;
  const recall = lcs / b.length;
  return (2 * precision * recall) / (precision + recall);
}

/** Browser ROUGE. Close to rouge_score's numbers but not bit-identical — the
 *  stemmer here is a light approximation of Porter, so treat live figures as
 *  indicative and the benchmark table as authoritative. */
export function rouge(prediction, reference) {
  return {
    rouge1: ngramF(prediction, reference, 1),
    rouge2: ngramF(prediction, reference, 2),
    rougeL: lcsF(prediction, reference),
  };
}
