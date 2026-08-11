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
from wikisum.summarizers import METHODS, TARGET_WORDS

log = logging.getLogger("wikisum.benchmark")

# Long-form articles across science, history and biography. Every entry is well
# past BART's 1024-token window -- the comparison only means anything when the
# article does not fit. Weighted toward topics a visitor is likely to type, so
# the site can show real BART output rather than a placeholder.
DEFAULT_ARTICLES = [
    # science
    "Photosynthesis",
    "Black hole",
    "Plate tectonics",
    "Immune system",
    "Evolution",
    "DNA",
    "Climate change",
    "Vaccine",
    "Antibiotic",
    "Quantum mechanics",
    # history
    "Roman Empire",
    "Industrial Revolution",
    "Silk Road",
    "World War II",
    "French Revolution",
    "Ancient Egypt",
    "Cold War",
    "Renaissance",
    # biography
    "Marie Curie",
    "Albert Einstein",
    "Isaac Newton",
    "Leonardo da Vinci",
    # other
    "Apollo 11",
    "Great Barrier Reef",
    "Python (programming language)",
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
            summary = METHODS[method].fn(article.body)
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
            "label": METHODS[method].label,
            "kind": METHODS[method].kind,
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


# Series colours, matched to the site's categorical palette. Hard-coded rather
# than themed: GitHub strips <style> from README images, so the SVG has to carry
# literal fills and mid-tone text that reads on both light and dark backgrounds.
_CHART_COLORS = {
    "lexrank": "#9c2f1f",
    "lsa": "#1c5cab",
    "bart_truncated": "#c98500",
    "bart_mapreduce": "#00794d",
}


def write_chart(payload: dict, path: Path) -> None:
    """Emit the ROUGE comparison as a standalone SVG for the README.

    Generated from the same payload as the JSON so the README figure can never
    drift from the published numbers.
    """
    methods = [m for m in DEFAULT_METHODS if m in payload["methods"]]
    groups = [("rouge1", "ROUGE-1"), ("rouge2", "ROUGE-2"), ("rougeL", "ROUGE-L")]

    width, height = 720, 300
    left, right, top, bottom = 46, 12, 30, 54
    plot_w = width - left - right
    plot_h = height - top - bottom

    peak = max(
        payload["methods"][m]["rouge"][t] for m in methods for t, _ in groups
    )
    step = 0.05 if peak <= 0.25 else 0.1
    ticks = int(peak / step) + 1
    top_value = step * ticks

    def y(value: float) -> float:
        return top + plot_h - (value / top_value) * plot_h

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" font-family="system-ui,sans-serif" '
        f'role="img" aria-label="Mean ROUGE F-measure by method">',
        '<rect width="100%" height="100%" fill="none"/>',
    ]

    for i in range(ticks + 1):
        value = step * i
        parts.append(
            f'<line x1="{left}" x2="{width - right}" y1="{y(value):.1f}" '
            f'y2="{y(value):.1f}" stroke="#8a8781" stroke-opacity=".28"/>'
        )
        parts.append(
            f'<text x="{left - 8}" y="{y(value) + 4:.1f}" text-anchor="end" '
            f'font-size="11" fill="#8a8781">{value:.2f}</text>'
        )

    band = plot_w / len(groups)
    bar_w = min(22.0, (band * 0.62) / len(methods))
    span = bar_w * len(methods) + 2 * (len(methods) - 1)

    for gi, (key, label) in enumerate(groups):
        start = left + band * gi + (band - span) / 2
        best = max(payload["methods"][m]["rouge"][key] for m in methods)

        for mi, method in enumerate(methods):
            value = payload["methods"][method]["rouge"][key]
            x = start + mi * (bar_w + 2)
            bar_top = y(value)
            parts.append(
                f'<rect x="{x:.1f}" y="{bar_top:.1f}" width="{bar_w:.1f}" '
                f'height="{y(0) - bar_top:.1f}" rx="3" '
                f'fill="{_CHART_COLORS[method]}"/>'
            )
            if value == best:  # label the leader only, as on the site
                parts.append(
                    f'<text x="{x + bar_w / 2:.1f}" y="{bar_top - 6:.1f}" '
                    f'text-anchor="middle" font-size="11" font-weight="600" '
                    f'fill="#8a8781">{value:.3f}</text>'
                )

        parts.append(
            f'<text x="{left + band * gi + band / 2:.1f}" y="{height - 30}" '
            f'text-anchor="middle" font-size="12" font-weight="600" '
            f'fill="#8a8781">{label}</text>'
        )

    # Legend along the bottom.
    legend_x = left
    for method in methods:
        label = METHODS[method].label
        parts.append(
            f'<rect x="{legend_x}" y="{height - 15}" width="9" height="9" rx="2" '
            f'fill="{_CHART_COLORS[method]}"/>'
        )
        parts.append(
            f'<text x="{legend_x + 14}" y="{height - 7}" font-size="11" '
            f'fill="#8a8781">{label}</text>'
        )
        legend_x += 22 + len(label) * 6.2

    parts.append("</svg>")
    path.write_text("\n".join(parts), encoding="utf-8")


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

    unknown = set(args.methods) - set(METHODS)
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

    chart = out.with_name("rouge-chart.svg")
    write_chart(payload, chart)

    log.info(
        "wrote %s and %s (%d articles, %.0fs)",
        out, chart, len(articles), payload["runtime_seconds"],
    )


if __name__ == "__main__":
    main()
