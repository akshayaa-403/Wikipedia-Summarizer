"""Command-line entry point.

    python -m wikisum "Photosynthesis"
    python -m wikisum "Roman Empire" --method bart_mapreduce --evaluate
"""

from __future__ import annotations

import argparse
import logging
import sys

from wikisum.chunking import chunk_by_tokens, coverage
from wikisum.evaluate import rouge_scores
from wikisum.fetch import ArticleNotFound, fetch_article
from wikisum.summarizers import (
    METHOD_LABELS,
    SUMMARIZERS,
    TARGET_WORDS,
    get_summarizer,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="wikisum", description="Summarize a Wikipedia article."
    )
    parser.add_argument("title", help="Wikipedia article title")
    parser.add_argument(
        "--method",
        action="append",
        choices=sorted(SUMMARIZERS),
        help="repeatable; defaults to every method",
    )
    parser.add_argument(
        "--words",
        type=int,
        default=TARGET_WORDS,
        help="target summary length; applied to every method so ROUGE stays comparable",
    )
    parser.add_argument(
        "--evaluate",
        action="store_true",
        help="score each summary with ROUGE against the article's lead section",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(message)s",
    )

    try:
        article = fetch_article(args.title)
    except ArticleNotFound as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    methods = args.method or list(SUMMARIZERS)
    chunks = chunk_by_tokens(article.body)

    print(f"\n{article.title}")
    print(f"{article.url}")
    print(
        f"{article.word_count:,} words | {len(article.sections)} sections | "
        f"body splits into {len(chunks)} chunks | "
        f"a single 1024-token window covers {coverage(article.body):.1%} of the body"
    )

    for method in methods:
        summary = get_summarizer(method)(article.body, target_words=args.words)
        print(f"\n{'=' * 68}")
        header = METHOD_LABELS[method]
        if summary.chunks_processed > 1:
            header += (
                f"  [{summary.chunks_processed} chunks, {summary.passes} passes]"
            )
        print(header)
        print("=" * 68)
        print(summary.text)

        if args.evaluate:
            scores = rouge_scores(summary.text, article.lead)
            print(
                f"\nROUGE-1 {scores.rouge1:.3f} | ROUGE-2 {scores.rouge2:.3f} | "
                f"ROUGE-L {scores.rougeL:.3f}  ({summary.word_count} words)"
            )

    if args.evaluate:
        print(f"\nReference: article lead section ({len(article.lead.split())} words)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
