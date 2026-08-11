"""ROUGE scoring.

ROUGE compares a generated summary against a human-written reference by n-gram
overlap. We report three variants:

* **ROUGE-1** -- unigram overlap; roughly "did it pick the right content words".
* **ROUGE-2** -- bigram overlap; sensitive to phrasing and word order, and the
  metric abstractive systems find hardest.
* **ROUGE-L** -- longest common subsequence; rewards material appearing in the
  same order as the reference without requiring it to be contiguous.

F-measure is reported throughout. Precision alone rewards terse summaries and
recall alone rewards long ones, so neither is comparable across methods that
produce different lengths.

Caveat worth stating plainly: ROUGE measures lexical overlap, not correctness.
An abstractive summary that paraphrases accurately is penalised for not reusing
the reference's words. That is exactly why the benchmark reports it next to
length and coverage rather than on its own.
"""

from __future__ import annotations

import functools
import statistics
from dataclasses import dataclass

ROUGE_TYPES = ("rouge1", "rouge2", "rougeL")


@dataclass
class RougeResult:
    rouge1: float
    rouge2: float
    rougeL: float

    def as_dict(self) -> dict[str, float]:
        return {
            "rouge1": round(self.rouge1, 4),
            "rouge2": round(self.rouge2, 4),
            "rougeL": round(self.rougeL, 4),
        }


@functools.cache
def _get_scorer():
    from rouge_score import rouge_scorer

    # Stemming lets "computed"/"computing" count as a match, which is standard
    # for ROUGE and avoids penalising harmless inflection.
    return rouge_scorer.RougeScorer(list(ROUGE_TYPES), use_stemmer=True)


def rouge_scores(prediction: str, reference: str) -> RougeResult:
    """Score one summary against one reference."""
    if not prediction.strip() or not reference.strip():
        return RougeResult(0.0, 0.0, 0.0)
    scores = _get_scorer().score(reference, prediction)
    return RougeResult(
        rouge1=scores["rouge1"].fmeasure,
        rouge2=scores["rouge2"].fmeasure,
        rougeL=scores["rougeL"].fmeasure,
    )


def aggregate(results: list[dict[str, float]]) -> dict[str, dict[str, float]]:
    """Mean and standard deviation per ROUGE type across a set of articles.

    Takes the ``{"rouge1": ...}`` dicts that ``RougeResult.as_dict`` produces --
    the form scores are already in once they have been through the benchmark's
    JSON.
    """
    if not results:
        return {t: {"mean": 0.0, "stdev": 0.0} for t in ROUGE_TYPES}

    out = {}
    for rouge_type in ROUGE_TYPES:
        values = [r[rouge_type] for r in results]
        out[rouge_type] = {
            "mean": round(statistics.mean(values), 4),
            "stdev": round(statistics.stdev(values), 4) if len(values) > 1 else 0.0,
        }
    return out
