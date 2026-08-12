/* Live Wikipedia fetch, the lead/body split, sentence splitting, and ROUGE.
 *
 * GitHub Pages serves static files only, so nothing here needs a backend:
 * Wikipedia's API is CORS-enabled with `origin=*` and ROUGE is array maths.
 * The summarizers themselves live in summarizers.js.
 */

const API = 'https://en.wikipedia.org/w/api.php';

const BOILERPLATE = new Set([
  'see also', 'references', 'further reading', 'external links', 'notes',
  'citations', 'bibliography', 'sources', 'footnotes',
]);

const HEADING = /^={2,}\s*(.+?)\s*={2,}$/gm;

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
 * minus link-list sections. */
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
                        // Plaintext extracts embed every formula as
                        // "{\displaystyle ...}". Left in, the markup leaks into
                        // summaries and 'displaystyle' ranks as a key term on
                        // any maths-heavy article.
                        .replace(/\{\\displaystyle[^}]*\}/g, ' ')
                        .replace(/\{\\[a-z]+[^}]*\}/g, ' ')
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

/* ------------------------------------------------------------------ ROUGE */

/* Light Porter approximation. Exported because key-term extraction needs the
 * same notion of "same word" that ROUGE uses -- two different stemmers would
 * have the two features disagree about whether 'penguin' and 'penguins' match.
 *
 * 'es' only strips after a sibilant ('boxes' -> 'box'), never blindly: a bare
 * 'es' rule turns 'holes' into 'hol' while 'hole' stays whole, so the pair
 * never matches and both can occupy a slot in the key-term list. 'ies' -> 'y'
 * for the same reason ('galaxies' / 'galaxy'). The double-letter collapse is
 * restricted to consonants that actually double in English inflection. */
export const stem = (word) => word
  .replace(/(ational|tional|ization|iveness|fulness|ousness)$/, '')
  .replace(/ies$/, 'y')
  .replace(/([sxz]|ch|sh)es$/, '$1')
  .replace(/(ing|edly|ed|ly)$/, '')
  .replace(/([bdfgmnprt])\1$/, '$1')
  .replace(/s$/, '');

const rougeTokens = (text) =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem);

const EMPTY = { precision: 0, recall: 0, f: 0 };

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
  if (!overlap) return EMPTY;

  const predictedTotal = [...predicted.values()].reduce((a, b) => a + b, 0);
  const referenceTotal = [...referenced.values()].reduce((a, b) => a + b, 0);
  const precision = overlap / predictedTotal;
  const recall = overlap / referenceTotal;
  return { precision, recall, f: (2 * precision * recall) / (precision + recall) };
}

/* LCS length via the rolling-row DP — the full matrix is O(n*m) memory and
 * these texts run to a few thousand tokens. */
function lcsF(prediction, reference) {
  const a = rougeTokens(prediction);
  const b = rougeTokens(reference);
  if (!a.length || !b.length) return EMPTY;

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
  if (!lcs) return EMPTY;
  const precision = lcs / a.length;
  const recall = lcs / b.length;
  return { precision, recall, f: (2 * precision * recall) / (precision + recall) };
}

/** Browser ROUGE. Close to rouge_score's numbers but not bit-identical — the
 *  stemmer here is a light approximation of Porter, so treat live figures as
 *  indicative and the Python benchmark as authoritative. */
export function rouge(prediction, reference) {
  return {
    rouge1: ngramF(prediction, reference, 1).f,
    rouge2: ngramF(prediction, reference, 2).f,
    rougeL: lcsF(prediction, reference).f,
  };
}
