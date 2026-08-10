# Wikipedia Summarizer

Condenses long Wikipedia articles into short summaries, and measures with ROUGE
whether the condensing actually worked.

**→ [Live site](https://akshayaa-403.github.io/Wikipedia-Summarizer/)**

The site runs an extractive summarizer live in your browser against any article
you name, explains the long-context problem, and presents the full benchmark:
four methods, three ROUGE metrics, side-by-side summaries per article.

---

## The problem this solves

`facebook/bart-large-cnn` accepts **1024 tokens**. The articles in the benchmark
average **~9,700 words** of body text (up to 16,600). The standard approach —

```python
inputs = tokenizer(article, truncation=True, max_length=1024)
```

— never fails and never warns. It quietly discards everything past the cut and
returns a fluent summary of the article's opening. For *Photosynthesis* that is
about **10% of the body**: the light reactions make it in, the Calvin cycle and
the C4/CAM pathways do not.

**The fix is hierarchical map-reduce summarization:**

1. **Chunk** the body into ~900-token windows that break on **sentence
   boundaries** — a chunk cut mid-clause leaves an abstractive model to invent
   an ending, which is how hallucinated facts get in.
2. **Overlap** consecutive chunks by one sentence, so a fact introduced at the
   end of chunk *n* and referenced by a pronoun at the start of chunk *n+1*
   still has its antecedent. This is the piece that actually preserves context
   across a boundary.
3. **Map** — summarize every chunk independently. Nothing is discarded.
4. **Reduce** — concatenate the chunk summaries, re-chunk, and summarize again,
   repeating until the intermediate text fits one window. The final pass sees
   material drawn from the whole article.

Implementation: [`wikisum/chunking.py`](wikisum/chunking.py) and
[`summarize_bart_mapreduce`](wikisum/summarizers.py).

## Evaluation

Every method summarizes the article **body**; the summary is scored against the
article's **lead section**, which Wikipedia editors write specifically to
summarize the rest. That gives a human-written reference for any article without
manual labelling — the same construction behind WikiSum-style datasets.

Reported: **ROUGE-1** (unigram overlap), **ROUGE-2** (bigram overlap — the
strictest, since it is sensitive to word order) and **ROUGE-L** (longest common
subsequence), all as F-measure with Porter stemming.

**Every method is held to the same ~150-word output budget.** This is not
cosmetic. ROUGE F-measure is computed against a reference several times longer
than any summary here, so recall — and with it F — rises with length almost
regardless of quality. An early run left the methods at their natural lengths:
LSA emitted 205 words, LexRank 76, and LSA "won" ROUGE-1 by 60%. That gap was
measuring verbosity. Fixing the budget is what makes the ROUGE column a
comparison of methods rather than of lengths.

## Results

10 articles, ~150-word budget per method, scored against each article's lead.

| Method | ROUGE-1 | ROUGE-2 | ROUGE-L | Body read | Avg time |
|---|---|---|---|---|---|
| **LexRank** | **0.302** | **0.098** | **0.159** | 100% | 4.0 s |
| LSA | 0.259 | 0.063 | 0.132 | 100% | 1.6 s |
| BART (truncated) | 0.253 | 0.073 | 0.141 | 8.5% | 29 s |
| BART (map-reduce) | 0.246 | 0.074 | 0.139 | 100% | 189 s |

**Map-reduce does not beat truncation on ROUGE.** It reads 100% of the body
against the baseline's 8.5%, costs 6.5× the wall-clock time, and lands level —
marginally behind on ROUGE-1 and ROUGE-L, marginally ahead on ROUGE-2, winning
4 of 10 articles. Reading twelve times more text bought no measured gain on
this metric. That is the finding.

Three things explain it, and they are worth more than a win would have been:

1. **The reference favours the baseline.** A lead section introduces the
   subject, so it is topically closest to the article's *opening* — precisely
   the region truncation reads. A summary that faithfully covers late sections
   is penalised for spending words on material the lead never mentions.
2. **ROUGE rewards copying.** Extractive methods reuse Wikipedia's own
   sentences and therefore its vocabulary; abstractive models paraphrase and
   are marked down for it. That is most of why LexRank tops every column.
   ROUGE measures lexical overlap, not correctness — it cannot tell whether a
   summary is true.
3. **What map-reduce buys is coverage**, not ROUGE: the guarantee that no
   section was silently dropped. Whether that is worth 6.5× the compute depends
   on the task. The benchmark sizes the trade-off; it does not make the choice.

The honest one-line version: *the long-context fix works as engineering —
nothing is discarded — and this evaluation does not show it improving summary
quality as ROUGE-against-the-lead measures it.*

## Methods compared

| Method | Type | Context limit | Notes |
|---|---|---|---|
| LexRank | extractive | none | Graph centrality over TF-IDF sentence similarity |
| LSA | extractive | none | SVD over the term–sentence matrix |
| BART (truncated) | abstractive | 1024 tokens | Baseline — reads only what fits |
| BART (map-reduce) | abstractive | none | This project — reads the whole body |

Current scores are on the [live site](https://akshayaa-403.github.io/Wikipedia-Summarizer/#results),
generated from [`docs/data/results.json`](docs/data/results.json).

## Install

```bash
git clone https://github.com/akshayaa-403/Wikipedia-Summarizer
cd Wikipedia-Summarizer
pip install -r requirements.txt
python -c "import nltk; nltk.download('punkt'); nltk.download('punkt_tab')"
```

BART is downloaded from Hugging Face on first use (~1.6 GB) and runs on CPU.

## Usage

```bash
# every method, scored against the article's lead section
python -m wikisum "Photosynthesis" --evaluate

# one method only
python -m wikisum "Roman Empire" --method bart_mapreduce
```

```
Photosynthesis
https://en.wikipedia.org/wiki/Photosynthesis
7,217 words | 32 sections | body splits into 12 chunks |
a single 1024-token window covers 9.7% of the body
```

As a library:

```python
from wikisum import fetch_article, rouge_scores
from wikisum.summarizers import summarize_bart_mapreduce

article = fetch_article("Black hole")
summary = summarize_bart_mapreduce(article.body)

print(summary.text)
print(f"{summary.chunks_processed} chunks over {summary.passes} passes")
print(rouge_scores(summary.text, article.lead).as_dict())
```

## Regenerating the benchmark

```bash
python -m wikisum.benchmark --out docs/data/results.json
```

Add `--articles "Title A" "Title B"` to change the article set, or
`--methods lexrank bart_mapreduce` to run a subset. The site reads this file
directly, so regenerating it updates the published page.

## Tests

```bash
pytest tests/ -q
```

Covers chunk-boundary behaviour, the overlap guarantee, the "no sentence is
dropped" property that distinguishes this from truncation, and ROUGE edge cases.

## Project layout

```
wikisum/
  fetch.py        MediaWiki API client; lead/body split, boilerplate removal
  chunking.py     sentence-boundary packing with overlap  ← the long-context fix
  summarizers.py  the four methods, incl. the map-reduce pipeline
  evaluate.py     ROUGE scoring and aggregation
  benchmark.py    runs everything, writes docs/data/results.json
  cli.py          command-line entry point
docs/             the GitHub Pages site (static; reads results.json)
tests/            pytest suite
```

## About the live site

GitHub Pages serves static files and cannot run Python, so the site splits the
difference honestly:

- **Live, for any article you type** — TextRank runs in the browser
  (`docs/js/wiki.js`), using the same lead/body split, the same sentence-aligned
  chunking and a JavaScript ROUGE implementation. Wikipedia's API is CORS-enabled,
  so there is no backend and nothing to keep awake.
- **Precomputed** — the BART rows, which need the 1.6 GB model, come from
  `results.json` generated by the Python benchmark.

The browser ROUGE uses a light approximation of the Porter stemmer, so live
figures are indicative; the benchmark table is authoritative.

## Deploying the site

Settings → Pages → Source: *Deploy from a branch* → `main` / `/docs`.

## Limitations

- Map-reduce costs one model call per chunk plus the reduce passes — roughly
  12× the wall-clock time of truncation on a 12-chunk article.
- ROUGE rewards lexical overlap, so it under-credits accurate paraphrase; see
  the caveat above.
- Benchmarked on English Wikipedia only.
- The reduce step summarizes summaries, so a fact dropped in the map pass cannot
  be recovered later.

## Acknowledgments

Wikipedia and the MediaWiki API · [sumy](https://github.com/miso-belica/sumy) ·
[Hugging Face Transformers](https://github.com/huggingface/transformers) ·
[rouge-score](https://github.com/google-research/google-research/tree/master/rouge) · NLTK

## License

MIT — see [LICENSE](LICENSE).
