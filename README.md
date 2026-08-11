<h1 align="center">Wikipedia Summarizer</h1>

<p align="center">
  <em>Four summarization algorithms. One article. Scored against the humans who wrote it.</em>
</p>

<p align="center">
  <a href="https://akshayaa-403.github.io/Wikipedia-Summarizer/"><img src="https://img.shields.io/badge/live%20demo-open-111111?style=flat-square" alt="Live demo"></a>
  <a href="https://github.com/akshayaa-403/Wikipedia-Summarizer/actions/workflows/tests.yml"><img src="https://img.shields.io/github/actions/workflow/status/akshayaa-403/Wikipedia-Summarizer/tests.yml?style=flat-square&color=111111&label=tests" alt="Tests"></a>
  <img src="https://img.shields.io/badge/dependencies-0-111111?style=flat-square" alt="Zero runtime dependencies">
  <img src="https://img.shields.io/badge/backend-none-111111?style=flat-square" alt="No backend">
  <img src="https://img.shields.io/github/license/akshayaa-403/Wikipedia-Summarizer?style=flat-square&color=111111" alt="MIT license">
</p>

<p align="center">
  <strong>4 algorithms &middot; 6 live charts &middot; ~44 ms for a 4,400-word article &middot; runs entirely in your browser</strong>
</p>

---

Type any Wikipedia article. Four classical extractive summarizers run in your
browser, each scored with ROUGE against the article's own lead section — the
summary Wikipedia's editors wrote themselves.

**[→ Try it](https://akshayaa-403.github.io/Wikipedia-Summarizer/)**

Nothing is precomputed. Type `Kākāpō` and every summary, score, and chart is
calculated from scratch for that article.

## The methods

Four families, chosen to fail differently:

| Method | Idea | Family |
|---|---|---|
| **TextRank** | PageRank over a sentence-similarity graph | graph centrality |
| **LSA** | Truncated SVD; one sentence per latent topic | topic model |
| **Luhn** (1958) | Densest window of high-frequency terms | frequency |
| **MMR** | Relevance − λ·redundancy against what it already picked | diversity |

The first three score every sentence independently, so all three can return
four sentences that say the same thing. MMR is the only one that looks at what
it has already selected.

All four share one preprocessing pass and one word budget, so differences come
from the selection strategy alone — not from tokenizing or length.

## How they do

ROUGE-1 against the article's lead, and against the **human ceiling**: that same
lead trimmed to the word budget the methods get.

| Article | Human ceiling | TextRank | LSA | Luhn | MMR |
|---|--:|--:|--:|--:|--:|
| Penguin | 0.709 | **0.395** | 0.319 | 0.263 | 0.318 |
| Black hole | 0.474 | **0.323** | 0.272 | 0.194 | 0.310 |
| Roman Empire | 0.380 | 0.220 | **0.246** | 0.209 | 0.223 |

No method wins everywhere — TextRank leads on two, LSA on the third. That
instability is the point of the rank chart.

**Scoring the lead against itself would return 1.000 every time**, which teaches
nothing. Trimming it to the same budget turns it into a real upper bound: what a
human achieves writing to this brief. The best method reaches 56–68% of it.

## Reading the charts

Six charts, all recomputed per article:

1. **ROUGE F-measure** — three metrics, four methods, human ceiling as a dashed rule
2. **Rank stability** — plotted by rank, since scores cluster within a thousandth
3. **Coverage vs self-repetition** — the chart that justifies MMR existing
4. **Sentence overlap** — Jaccard between every pair; a dark row means redundancy
5. **Key terms captured** — top-20 TF-IDF terms, a signal independent of ROUGE
6. **Positional density** — kernel density of where each method looks

Chart 6 is the most diagnostic: a curve humped at the left means the method is
lead-biased, effectively paraphrasing the introduction rather than reading the
article.

## Run it

No build step, no dependencies, no backend.

```bash
git clone https://github.com/akshayaa-403/Wikipedia-Summarizer
cd Wikipedia-Summarizer
python3 -m http.server 8765 --directory docs
```

Open <http://127.0.0.1:8765>.

## Tests

```bash
npm install
npx playwright install chromium
npm test
```

27 checks driving the real page in Chromium: the four summaries render and are
distinct, ROUGE recomputes for a new article, every chart draws, labels don't
overlap, both themes hold, and no console errors. It fetches from the live
Wikipedia API, so it exercises the same path a visitor does.

## Layout

```
docs/
  index.html
  css/style.css
  js/
    wiki.js          MediaWiki client, lead/body split, ROUGE
    summarizers.js   the four algorithms + shared TF-IDF preprocessing
    charts.js        hand-rolled SVG; no charting library
    app.js           page controller
tests/e2e/           Playwright suite
```

## Notes

**Why extractive only.** Abstractive models (BART and friends) need a 1.6 GB
checkpoint and a server. This page is static files with nothing behind it, so
every method has to run in the visitor's browser. That constraint is also why
the charts can be live for *any* article rather than precomputed for a fixed set.

**ROUGE measures overlap, not correctness.** It rewards reusing the reference's
vocabulary and cannot tell whether a summary is true. That is why the page also
reports key-term coverage, self-repetition, and positional spread — none of
which ROUGE sees.

**Colours are validated, not chosen by eye.** Both palettes clear a
colourblind-separation check against the exact surfaces they render on.

## License

[MIT](LICENSE). Article text from Wikipedia, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
