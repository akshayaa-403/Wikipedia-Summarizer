"""Run every method over a set of articles and emit the JSON the site reads.

Usage::

    python -m wikisum.benchmark --out docs/data/results.json

The article set is deliberately long-form: every entry is well past BART's
1024-token window, because the whole point of the comparison is what happens
when the article does not fit.
"""

from __future__ import annotations

import argparse
import json
import logging
import time
from pathlib import Path

from wikisum.chunking import chunk_by_tokens, coverage
from wikisum.evaluate import ROUGE_TYPES, aggregate, rouge_scores
from wikisum.fetch import fetch_article
from wikisum.summarizers import (
    METHOD_KINDS,
    METHOD_LABELS,
    SUMMARIZERS,
    TARGET_WORDS,
    get_summarizer,
)

log = logging.getLogger("wikisum.benchmark")

DEFAULT_ARTICLES = [
    "Photosynthesis",
    "Roman Empire",
    "Black hole",
    "Great Barrier Reef",
    "Marie Curie",
    "Industrial Revolution",
    "Immune system",
    "Apollo 11",
    "Plate tectonics",
    "Silk Road",
]

DEFAULT_METHODS = ["lexrank", "lsa", "bart_truncated", "bart_mapreduce"]


def run_article(title: str, methods: list[str]) -> dict | None:
    """Summarize one article with every method and score each against the lead."""
    try:
        article = fetch_article(title)
    except Exception as exc:
        log.warning("skipping %s: %s", title, exc)
        return None

    if not article.body.strip():
        log.warning("skipping %s: no body sections", title)
        return None

    chunks = chunk_by_tokens(article.body)
    log.info(
        "%s -- %d words body, %d chunks, truncation sees %.0f%%",
        article.title,
        article.body_word_count,
        len(chunks),
        coverage(article.body) * 100,
    )

    record = {
        "title": article.title,
        "url": article.url,
        "word_count": article.word_count,
        "body_word_count": article.body_word_count,
        "lead_word_count": len(article.lead.split()),
        "section_count": len(article.sections),
        "chunk_count": len(chunks),
        "truncation_coverage": round(coverage(article.body), 4),
        "reference": article.lead,
        "summaries": {},
    }

    for method in methods:
        started = time.perf_counter()
        try:
            summary = get_summarizer(method)(article.body)
        except Exception as exc:
            log.error("%s / %s failed: %s", article.title, method, exc)
            continue
        summary.seconds = round(time.perf_counter() - started, 2)

        scores = rouge_scores(summary.text, article.lead)
        record["summaries"][method] = {
            "text": summary.text,
            "word_count": summary.word_count,
            "seconds": summary.seconds,
            "chunks_processed": summary.chunks_processed,
            "passes": summary.passes,
            "input_coverage": round(summary.input_coverage, 4),
            "meta": summary.meta,
            "rouge": scores.as_dict(),
        }
        log.info(
            "  %-18s R1=%.3f R2=%.3f RL=%.3f  %5.1fs",
            method,
            scores.rouge1,
            scores.rouge2,
            scores.rougeL,
            summary.seconds,
        )

    return record


def summarize_run(articles: list[dict], methods: list[str]) -> dict:
    """Aggregate per-method statistics across all articles."""
    per_method = {}
    for method in methods:
        rows = [a["summaries"][method] for a in articles if method in a["summaries"]]
        if not rows:
            continue

        scores = aggregate([r["rouge"] for r in rows])
        per_method[method] = {
            "label": METHOD_LABELS[method],
            "kind": METHOD_KINDS[method],
            "articles_scored": len(rows),
            "rouge": {t: scores[t]["mean"] for t in ROUGE_TYPES},
            "rouge_stdev": {t: scores[t]["stdev"] for t in ROUGE_TYPES},
            "avg_seconds": round(sum(r["seconds"] for r in rows) / len(rows), 2),
            "avg_words": round(sum(r["word_count"] for r in rows) / len(rows), 1),
            "avg_input_coverage": round(
                sum(r["input_coverage"] for r in rows) / len(rows), 4
            ),
            "avg_chunks": round(
                sum(r["chunks_processed"] for r in rows) / len(rows), 1
            ),
        }
    return per_method


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--articles", nargs="*", default=DEFAULT_ARTICLES)
    parser.add_argument("--methods", nargs="*", default=DEFAULT_METHODS)
    parser.add_argument("--out", default="docs/data/results.json")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(message)s",
        datefmt="%H:%M:%S",
    )
    # transformers/huggingface_hub log every HTTP HEAD at INFO, which buries
    # the per-article scores this run exists to print.
    for noisy in ("httpx", "urllib3", "filelock", "huggingface_hub", "transformers"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    unknown = set(args.methods) - set(SUMMARIZERS)
    if unknown:
        parser.error(f"unknown methods: {sorted(unknown)}")

    started = time.perf_counter()
    articles = []
    for i, title in enumerate(args.articles, 1):
        log.info("[%d/%d] %s", i, len(args.articles), title)
        record = run_article(title, args.methods)
        if record:
            articles.append(record)

    payload = {
        "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "runtime_seconds": round(time.perf_counter() - started, 1),
        "config": {
            "model": "facebook/bart-large-cnn",
            "context_window_tokens": 1024,
            "chunk_tokens": 900,
            "overlap_sentences": 1,
            "reference": "article lead section",
            "metric": "ROUGE F-measure, Porter-stemmed",
            "target_words": TARGET_WORDS,
        },
        "methods": summarize_run(articles, args.methods),
        "articles": articles,
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    log.info("wrote %s (%d articles, %.0fs)", out, len(articles), payload["runtime_seconds"])


if __name__ == "__main__":
    main()
