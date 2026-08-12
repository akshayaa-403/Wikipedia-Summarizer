/* Four extractive summarizers, all running in the browser.
 *
 * Each picks sentences from the article rather than generating new text, so all
 * four read the document end to end -- there is no context window to overflow
 * and nothing is silently discarded.
 *
 * They are deliberately chosen to fail differently:
 *
 *   TextRank   graph centrality      -- what the article keeps returning to
 *   LSA        topic decomposition   -- one sentence per latent topic
 *   Luhn       term frequency        -- where significant words cluster densely
 *   MMR        relevance - redundancy -- the only one that avoids repeating itself
 *
 * The first three all reward a sentence for being typical, which means they can
 * each return five sentences that say nearly the same thing. MMR is included
 * because it is the one that explicitly penalises that.
 *
 * All four share the tokenizing and TF-IDF weighting below, so differences in
 * their output come from the selection strategy alone and not from preprocessing.
 */

import { sentenceSplit, stem } from './wiki.js';

/* Words carrying no topical signal. Left in, they dominate every similarity
 * computation and the rankings degenerate toward "longest sentence wins". */
const STOPWORDS = new Set(`a about above after again against all am an and any are aren't as at be
because been before being below between both but by can can't cannot could couldn't did didn't do
does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't
having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've
if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on
once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should
shouldn't so some such than that that's the their theirs them themselves then there there's these
they they'd they'll they're they've this those through to too under until up very was wasn't we we'd
we'll we're we've were weren't what what's when when's where where's which while who who's whom why
why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves also
many one two first new used using include including been such may often however within later
according known well make made part number since another among during three second
end great similar called around word way time year years day days back much long still even
large small high low good best better common early late old new found use uses come came
give given take taken see seen say said know knows think show shown find finds place places
thing things case cases group groups form forms type types kind area areas result results
example examples different various several certain particular general specific main major
important possible able likely near far away close open close begin began start started
end ended continue continued remain remained become became appear appeared seem seemed
whether although though despite unless upon toward towards across along behind beyond
order orders ordered live lives lived living give gives goes going gone done does
per via etc approximately roughly nearly almost about around over under between
will shall must might could would should can may need needs let lets thus hence therefore
also just only even both each either neither every any some all none itself oneself`.split(/\s+/));

const tokenize = (sentence) =>
  sentence.toLowerCase().match(/[a-z][a-z'-]+/g)?.filter(
    (w) => w.length > 2 && !STOPWORDS.has(w)) ?? [];

/**
 * Shared preprocessing: sentences, their tokens, IDF weights, and L2-normalised
 * TF-IDF vectors. Computed once per article and handed to every method.
 */
function analyse(text) {
  const sentences = sentenceSplit(text);
  const tokens = sentences.map(tokenize);

  const docFreq = new Map();
  for (const words of tokens) {
    for (const w of new Set(words)) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
  }

  const n = sentences.length || 1;
  const idf = new Map();
  for (const [w, df] of docFreq) idf.set(w, Math.log(n / (1 + df)) + 1);

  // Raw term frequency across the whole document -- Luhn needs this, the others
  // work from the per-sentence vectors.
  const termFreq = new Map();
  for (const words of tokens) {
    for (const w of words) termFreq.set(w, (termFreq.get(w) ?? 0) + 1);
  }

  const vectors = tokens.map((words) => {
    const v = new Map();
    for (const w of words) v.set(w, (v.get(w) ?? 0) + 1);
    let norm = 0;
    for (const [w, tf] of v) {
      const weight = tf * (idf.get(w) ?? 0);
      v.set(w, weight);
      norm += weight * weight;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [w, weight] of v) v.set(w, weight / norm);
    return v;
  });

  return { sentences, tokens, idf, termFreq, vectors };
}

/* Word-overlap similarity on the raw sentences (Jaccard over lowercased word
 * types). TF-IDF cosine can rate two sentences as different because their
 * *weighted* terms differ, while a reader sees near-identical prose -- on India
 * that let MMR and TextRank return summaries sharing their opening and closing
 * sentences. This second, blunter measure catches that case. */
function surfaceSimilarity(a, b) {
  const A = new Set(a.toLowerCase().match(/[a-z]+/g) ?? []);
  const B = new Set(b.toLowerCase().match(/[a-z]+/g) ?? []);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/* Cosine similarity of two already-normalised sparse vectors. */
function cosine(a, b) {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [w, weight] of small) {
    const other = large.get(w);
    if (other) dot += weight * other;
  }
  return dot;
}

/* Openers that point at something the summary never introduced. A sentence
 * beginning "The sultanate was to control much of North India" is fine in the
 * article, where the sultanate was named two paragraphs earlier, and useless as
 * the first line of a standalone summary. */
const DANGLING_OPENER =
  /^(the|this|these|those|that|it|its|they|their|them|he|she|his|her|such|both|another|other|later|meanwhile|however|therefore|thus|hence|then|also|but|and|so|there)\b/i;

/** A sentence that can stand on its own as an opening line. */
function selfContained(sentence) {
  return !DANGLING_OPENER.test(sentence.trim());
}

/* Take top-ranked sentences up to a word budget, then restore document order so
 * the result reads as prose rather than as a ranked list. Shared by all four so
 * the summaries are length-comparable and ROUGE measures method, not verbosity.
 *
 * One extra constraint: whichever selected sentence ends up FIRST must stand on
 * its own. Ranking alone opened the India summary with "The sultanate was to
 * control much of North India" -- correct in the article, where the sultanate
 * was named earlier, meaningless as a summary's first line. 11 of 20 summaries
 * opened that way.
 *
 * Note this has to be enforced against document order, not selection order:
 * picking a self-contained sentence first and then re-sorting simply puts the
 * lowest-index sentence back at the front. So any dangling sentence that would
 * land in the opening slot is dropped, and the next-ranked candidate takes its
 * place. Later positions keep dangling sentences happily -- by then the
 * referent has been introduced. */
function assemble(sentences, order, targetWords) {
  const picked = [];
  let words = 0;

  for (const i of order) {
    const len = sentences[i].split(/\s+/).length;
    if (picked.length && words + len > targetWords) break;

    // Would this sentence become the opening line? If so it must be
    // self-contained, otherwise skip it and try the next-ranked one.
    const wouldLead = picked.every((j) => i < j);
    if (wouldLead && !selfContained(sentences[i])) continue;

    picked.push(i);
    words += len;
  }

  // Nothing self-contained anywhere in range: fall back to plain ranking rather
  // than return an empty summary.
  if (!picked.length) {
    for (const i of order) {
      const len = sentences[i].split(/\s+/).length;
      if (picked.length && words + len > targetWords) break;
      picked.push(i);
      words += len;
    }
  }

  picked.sort((a, b) => a - b);
  return {
    indices: picked,
    text: picked.map((i) => sentences[i]).join(' '),
  };
}

/* ------------------------------------------------------------- TextRank --- */

/**
 * PageRank over a sentence-similarity graph. A sentence ranks highly when it is
 * similar to many other high-ranking sentences, i.e. when it restates the
 * article's recurring material.
 */
function textrank(a, { targetWords = 150, damping = 0.85, iters = 60 } = {}) {
  const n = a.sentences.length;
  if (!n) return { indices: [], text: '' };

  const sim = Array.from({ length: n }, () => new Float64Array(n));
  const rowSum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosine(a.vectors[i], a.vectors[j]);
      sim[i][j] = sim[j][i] = s;
      rowSum[i] += s;
      rowSum[j] += s;
    }
  }

  let rank = new Float64Array(n).fill(1 / n);
  for (let it = 0; it < iters; it++) {
    const next = new Float64Array(n).fill((1 - damping) / n);
    for (let i = 0; i < n; i++) {
      if (rowSum[i] === 0) {
        // A sentence similar to nothing would otherwise trap its rank; spread
        // it evenly instead so the mass stays in the graph.
        const share = (damping * rank[i]) / n;
        for (let j = 0; j < n; j++) next[j] += share;
        continue;
      }
      for (let j = 0; j < n; j++) {
        if (sim[i][j] > 0) next[j] += (damping * rank[i] * sim[i][j]) / rowSum[i];
      }
    }
    let delta = 0;
    for (let i = 0; i < n; i++) delta += Math.abs(next[i] - rank[i]);
    rank = next;
    if (delta < 1e-7) break;
  }

  const order = [...rank.keys()].sort((x, y) => rank[y] - rank[x]);
  return { ...assemble(a.sentences, order, targetWords), scores: rank };
}

/* ------------------------------------------------------------------ LSA -- */

/**
 * Latent Semantic Analysis.
 *
 * Decompose the term-sentence matrix with a truncated SVD and treat each of the
 * leading singular vectors as a latent topic. A sentence is scored by how
 * strongly it loads on those topics, weighted by each topic's singular value --
 * the Gong & Liu / Steinberger formulation.
 *
 * This replaced a TF-IDF centroid method, which measured cosine similarity to
 * the document mean. That turned out to be near-indistinguishable from
 * TextRank: measured across three articles the two score vectors correlated at
 * r = 0.993 to 0.999, and on Penguin they returned byte-identical summaries.
 * Both were ultimately ranking sentences by closeness to the document
 * aggregate. LSA asks a different question -- which sentences best represent
 * the article's distinct *topics* -- so it decorrelates and the four methods
 * now span four families: graph, topic model, frequency, diversity.
 */
function lsa(a, { targetWords = 150, topics = 4, iters = 60 } = {}) {
  const n = a.sentences.length;
  if (!n) return { indices: [], text: '' };

  // Vocabulary restricted to terms appearing in more than one sentence: a term
  // unique to a single sentence contributes a topic of its own and drags the
  // decomposition toward outliers.
  const df = new Map();
  for (const words of a.tokens) {
    for (const w of new Set(words)) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const vocab = [...df.entries()].filter(([, c]) => c > 1).map(([w]) => w);
  if (!vocab.length) return { indices: [], text: '' };

  const index = new Map(vocab.map((w, i) => [w, i]));
  const m = vocab.length;

  // Dense sentence x term matrix of the already-normalised TF-IDF weights.
  const A = Array.from({ length: n }, () => new Float64Array(m));
  a.vectors.forEach((v, i) => {
    for (const [w, weight] of v) {
      const j = index.get(w);
      if (j !== undefined) A[i][j] = weight;
    }
  });

  // Truncated SVD by power iteration with deflation. Full SVD is O(n*m^2) and
  // needless here: only the first few singular triplets are ever read.
  const scores = new Float64Array(n);
  const residual = A.map((row) => Float64Array.from(row));

  for (let k = 0; k < Math.min(topics, n, m); k++) {
    // Right singular vector via power iteration on the residual's normal matrix.
    let v = new Float64Array(m);
    for (let j = 0; j < m; j++) v[j] = Math.sin((j + 1) * (k + 1) * 0.7);  // deterministic seed
    let norm = Math.hypot(...v) || 1;
    for (let j = 0; j < m; j++) v[j] /= norm;

    let u = new Float64Array(n);
    for (let it = 0; it < iters; it++) {
      // u = A v
      for (let i = 0; i < n; i++) {
        let sum = 0;
        const row = residual[i];
        for (let j = 0; j < m; j++) sum += row[j] * v[j];
        u[i] = sum;
      }
      const un = Math.hypot(...u) || 1;
      for (let i = 0; i < n; i++) u[i] /= un;

      // v = A^T u
      const next = new Float64Array(m);
      for (let i = 0; i < n; i++) {
        const row = residual[i];
        const ui = u[i];
        if (!ui) continue;
        for (let j = 0; j < m; j++) next[j] += row[j] * ui;
      }
      const vn = Math.hypot(...next) || 1;
      let delta = 0;
      for (let j = 0; j < m; j++) {
        next[j] /= vn;
        delta += Math.abs(next[j] - v[j]);
      }
      v = next;
      if (delta < 1e-8) break;
    }

    // Singular value sigma = ||A v||.
    let sigma = 0;
    const Av = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const row = residual[i];
      for (let j = 0; j < m; j++) sum += row[j] * v[j];
      Av[i] = sum;
      sigma += sum * sum;
    }
    sigma = Math.sqrt(sigma);
    if (sigma < 1e-9) break;

    // Steinberger scoring: accumulate squared topic loading weighted by sigma^2,
    // so a dominant topic counts for more than a marginal one.
    for (let i = 0; i < n; i++) scores[i] += sigma * sigma * (Av[i] / sigma) ** 2;

    // Deflate: subtract this rank-1 component so the next pass finds a new topic.
    for (let i = 0; i < n; i++) {
      const coef = Av[i];
      const row = residual[i];
      for (let j = 0; j < m; j++) row[j] -= coef * v[j];
    }
  }

  const order = [...scores.keys()].sort((x, y) => scores[y] - scores[x]);
  return { ...assemble(a.sentences, order, targetWords), scores };
}

/* ------------------------------------------------------------------ Luhn -- */

/**
 * Luhn (1958). Mark the document's most frequent content words as
 * "significant", then score each sentence by the densest window of significant
 * words it contains: (significant in window)^2 / (window length).
 *
 * The squared numerator is the whole idea -- it rewards significant words
 * appearing *close together* rather than merely appearing. A sentence that
 * mentions three key terms in a row beats one that scatters four across a
 * clause, which is a different notion of importance from either vector method.
 */
function luhn(a, { targetWords = 150, topTerms = 0.12 } = {}) {
  if (!a.sentences.length) return { indices: [], text: '' };

  const ranked = [...a.termFreq.entries()].sort((x, y) => y[1] - x[1]);
  const cutoff = Math.max(5, Math.round(ranked.length * topTerms));
  const significant = new Set(ranked.slice(0, cutoff).map(([w]) => w));

  const scores = a.tokens.map((words) => {
    const hits = [];
    words.forEach((w, i) => { if (significant.has(w)) hits.push(i); });
    if (!hits.length) return 0;

    // Best window: the densest run of significant words, allowing up to four
    // insignificant words between them (Luhn's original tolerance).
    let best = 0;
    for (let s = 0; s < hits.length; s++) {
      for (let e = s; e < hits.length; e++) {
        if (hits[e] - hits[s] > (e - s + 1) + 4 * (e - s)) break;
        const span = hits[e] - hits[s] + 1;
        const count = e - s + 1;
        best = Math.max(best, (count * count) / span);
      }
    }
    return best;
  });

  const order = [...scores.keys()].sort((x, y) => scores[y] - scores[x]);
  return { ...assemble(a.sentences, order, targetWords), scores };
}

/* ------------------------------------------------------------------- MMR -- */

/**
 * Maximal Marginal Relevance (Carbonell & Goldstein, 1998).
 *
 *   MMR = argmax [ lambda * sim(s, document) - (1 - lambda) * max sim(s, already chosen) ]
 *
 * The only one of the four that looks at what it has *already selected*. The
 * other three score every sentence independently, so all three can return five
 * sentences that restate the same fact. MMR subtracts a redundancy penalty at
 * each step, which is why its summaries cover more distinct ground and usually
 * read less repetitively -- at the cost of sometimes picking a slightly less
 * central sentence to gain coverage.
 *
 * lambda balances the two terms: at 1.0 the penalty vanishes and MMR degenerates
 * into the centroid method. 0.5 is the default because higher values are too
 * weak to bite -- measured on Roman Empire, lambda 0.7 and 0.9 both returned
 * exactly TextRank's selection (Jaccard 1.00), which would put two identical
 * summaries on the page under different names. At 0.5 the overlap drops to 0.33
 * and the redundancy penalty actually changes what gets picked.
 */
function mmr(a, { targetWords = 150, lambda = 0.5 } = {}) {
  if (!a.sentences.length) return { indices: [], text: '' };

  const c = new Map();
  for (const v of a.vectors) {
    for (const [w, weight] of v) c.set(w, (c.get(w) ?? 0) + weight);
  }
  let norm = 0;
  for (const weight of c.values()) norm += weight * weight;
  norm = Math.sqrt(norm) || 1;
  for (const [w, weight] of c) c.set(w, weight / norm);

  const relevance = a.vectors.map((v) => cosine(v, c));
  const chosen = [];
  const remaining = new Set(a.sentences.keys());
  const maxSimToChosen = new Float64Array(a.sentences.length);

  // Greedy selection, stopping once the budget is spent.
  let words = 0;
  while (remaining.size) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (const i of remaining) {
      const score = lambda * relevance[i] - (1 - lambda) * maxSimToChosen[i];
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    if (bestIdx < 0) break;

    const len = a.sentences[bestIdx].split(/\s+/).length;
    if (chosen.length && words + len > targetWords) break;

    chosen.push(bestIdx);
    words += len;
    remaining.delete(bestIdx);

    // Update each candidate's similarity to the nearest already-chosen
    // sentence, taking the harsher of the two measures: TF-IDF cosine catches
    // topical repetition, surface overlap catches near-identical wording that
    // the weighted vectors miss.
    for (const i of remaining) {
      maxSimToChosen[i] = Math.max(
        maxSimToChosen[i],
        cosine(a.vectors[i], a.vectors[bestIdx]),
        surfaceSimilarity(a.sentences[i], a.sentences[bestIdx]),
      );
    }
  }

  // MMR runs its own greedy loop rather than assemble(), so the
  // self-contained-opener rule has to be applied here too: drop leading
  // sentences that would open the summary on a bare "The sultanate ..." until
  // one stands on its own. Only ever trims from the front, and never empties
  // the selection.
  let indices = [...chosen].sort((x, y) => x - y);
  while (indices.length > 1 && !selfContained(a.sentences[indices[0]])) {
    indices = indices.slice(1);
  }

  return {
    indices,
    text: indices.map((i) => a.sentences[i]).join(' '),
    scores: relevance,
  };
}

/* Fixed order -- a method keeps its colour and position everywhere on the page. */
export const METHODS = [
  { key: 'textrank', label: 'TextRank', fn: textrank,
    blurb: 'PageRank over a sentence-similarity graph' },
  { key: 'lsa', label: 'LSA', fn: lsa,
    blurb: 'SVD over the term-sentence matrix; top sentence per latent topic' },
  { key: 'luhn', label: 'Luhn', fn: luhn,
    blurb: 'Densest window of high-frequency terms (1958)' },
  { key: 'mmr', label: 'MMR', fn: mmr,
    blurb: 'Relevance minus redundancy against what it already picked' },
];

/**
 * The human ceiling: Wikipedia's own lead, trimmed to the same word budget the
 * methods are held to.
 *
 * Scoring the full lead against itself is meaningless -- it is the reference, so
 * it returns exactly 1.000 for every article and every metric. Trimming it to
 * the shared budget turns it into a real upper bound: what a human editor
 * achieves writing to the same length. On Penguin that is 0.709 ROUGE-1 and on
 * Roman Empire 0.380, so it moves per article and shows how much of the
 * achievable score each method actually reaches.
 */
export function humanCeiling(lead, { targetWords = 150 } = {}) {
  const picked = [];
  let words = 0;
  for (const sentence of sentenceSplit(lead)) {
    const len = sentence.split(/\s+/).length;
    if (picked.length && words + len > targetWords) break;
    picked.push(sentence);
    words += len;
  }
  return picked.join(' ');
}

/** Readability and shape statistics shown beside each summary. */
export function describe(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const sentences = sentenceSplit(text);
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);

  // Flesch reading ease: 206.835 - 1.015*(words/sentence) - 84.6*(syllables/word).
  // Higher is easier; Wikipedia prose typically lands in the 20-50 band.
  const perSentence = sentences.length ? words.length / sentences.length : 0;
  const perWord = words.length ? syllables / words.length : 0;
  const flesch = 206.835 - 1.015 * perSentence - 84.6 * perWord;

  return {
    words: words.length,
    sentences: sentences.length,
    avgSentence: Math.round(perSentence),
    // Reading rate scaled by difficulty rather than fixed at the usual 238 wpm.
    // That figure is the mean for easy prose; these summaries score 20-55 on
    // Flesch (difficult to fairly difficult), where measured rates fall to
    // roughly 180 wpm. Interpolating between 180 and 260 across the Flesch
    // range keeps the estimate honest for both a plain and a dense summary.
    readingSeconds: Math.round(
      (words.length / (180 + (Math.max(0, Math.min(100, flesch)) / 100) * 80)) * 60),
    flesch: Math.max(0, Math.min(100, Math.round(flesch))),
    uniqueRatio: words.length
      ? new Set(words.map((w) => w.toLowerCase().replace(/[^a-z]/g, ''))).size / words.length
      : 0,
  };
}

/* Vowel-group syllable estimate. Not perfect, but consistent across methods,
 * which is all a comparative reading-ease figure needs. */
function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return w.length ? 1 : 0;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
                  .replace(/^y/, '')
                  .match(/[aeiouy]{1,2}/g);
  return groups ? groups.length : 1;
}

/**
 * The article's highest-TF-IDF content words -- what a faithful summary ought
 * to mention. Used as a quality signal independent of ROUGE, which only ever
 * compares against the lead and so inherits the lead's own priorities.
 */
export function keyTerms(a, count = 20) {
  const weight = new Map();
  for (const [term, tf] of a.termFreq) {
    weight.set(term, tf * (a.idf.get(term) ?? 0));
  }

  // Collapse inflections before taking the top N. Without this, 'penguin' and
  // 'penguins' both claim a slot and the list silently covers fewer distinct
  // concepts than it claims to. Uses the same stemmer as ROUGE so both features
  // agree on what counts as one word.
  const byStem = new Map();
  for (const [term, w] of weight) {
    const key = stem(term);
    const prev = byStem.get(key);
    if (!prev || w > prev.weight) byStem.set(key, { term, weight: w });
  }

  return [...byStem.values()]
    .sort((x, y) => y.weight - x.weight)
    .slice(0, count)
    .map((e) => e.term);
}

/**
 * How much a summary repeats itself: the mean pairwise cosine similarity of its
 * own selected sentences. Zero for a single sentence. This is the axis MMR is
 * built to minimise, and the number that shows whether it succeeded.
 */
export function redundancy(a, indices) {
  if (indices.length < 2) return 0;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < indices.length; i++) {
    for (let j = i + 1; j < indices.length; j++) {
      sum += cosine(a.vectors[indices[i]], a.vectors[indices[j]]);
      pairs++;
    }
  }
  return pairs ? sum / pairs : 0;
}

/** Run all four over one article. */
export function summarizeAll(text, { targetWords = 150 } = {}) {
  const a = analyse(text);
  const out = {};
  for (const m of METHODS) {
    const started = performance.now();
    const result = m.fn(a, { targetWords });
    out[m.key] = { ...result, ms: performance.now() - started };
  }
  return { analysis: a, results: out };
}
