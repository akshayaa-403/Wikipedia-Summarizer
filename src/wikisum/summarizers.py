"""The four summarization methods the benchmark compares.

Extractive (``lexrank``, ``lsa``) select existing sentences and have no context
limit -- they see the whole article. Abstractive (``bart_truncated``,
``bart_mapreduce``) generate new text through a 1024-token window, and the two
differ only in how they handle an article that does not fit.
"""

from __future__ import annotations

import functools
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import partial
from typing import NamedTuple

from wikisum.chunking import chunk_by_tokens, coverage

log = logging.getLogger(__name__)

BART_MODEL = "facebook/bart-large-cnn"
BART_MAX_TOKENS = 1024

# Every method is held to the same output budget.
#
# This matters more than it looks. ROUGE F-measure is computed against a
# reference several times longer than any summary here, so recall -- and with
# it F -- climbs with length almost regardless of quality. An early run had LSA
# emitting 205 words and LexRank 76; LSA "won" ROUGE-1 by 60%, which measured
# verbosity, not quality. Comparing methods at a fixed length is what makes the
# ROUGE column mean anything.
TARGET_WORDS = 150
_TOKENS_PER_WORD = 1.3


@dataclass
class Summary:
    """A summary plus the diagnostics the site displays alongside it."""

    method: str
    text: str
    chunks_processed: int = 1
    passes: int = 1
    input_coverage: float = 1.0
    seconds: float = 0.0
    meta: dict = field(default_factory=dict)

    @property
    def word_count(self) -> int:
        return len(self.text.split())


# --------------------------------------------------------------------------
# Extractive
# --------------------------------------------------------------------------


def _sumy_summary(text: str, algorithm: str, target_words: int) -> tuple[str, int]:
    """Extract the top-ranked sentences up to ``target_words``.

    Sumy takes a sentence count, not a word budget, so we ask for a generous
    number and then fill to the budget in document order -- stopping at the
    sentence that would overshoot by more than it undershoots, so the result
    lands as close to the target as whole sentences allow.
    """
    from sumy.nlp.stemmers import Stemmer
    from sumy.nlp.tokenizers import Tokenizer
    from sumy.parsers.plaintext import PlaintextParser
    from sumy.summarizers.lex_rank import LexRankSummarizer
    from sumy.summarizers.lsa import LsaSummarizer
    from sumy.utils import get_stop_words

    stemmer = Stemmer("english")
    summarizer = {"lexrank": LexRankSummarizer, "lsa": LsaSummarizer}[algorithm](stemmer)
    summarizer.stop_words = get_stop_words("english")

    parser = PlaintextParser.from_string(text, Tokenizer("english"))
    ranked = [str(s) for s in summarizer(parser.document, 25)]

    chosen: list[str] = []
    words = 0
    for sentence in ranked:
        length = len(sentence.split())
        if chosen and words + length > target_words:
            # Take it only if stopping here would miss the target by more.
            if (words + length) - target_words >= target_words - words:
                break
            chosen.append(sentence)
            words += length
            break
        chosen.append(sentence)
        words += length

    return " ".join(chosen), len(chosen)


def _extractive(
    algorithm: str, text: str, *, target_words: int = TARGET_WORDS, **_
) -> Summary:
    """``lexrank`` ranks by eigenvector centrality, ``lsa`` by SVD over the
    term-sentence matrix. Everything downstream of the ranking is identical."""
    summary, sentences = _sumy_summary(text, algorithm, target_words)
    return Summary(
        method=algorithm,
        text=summary,
        input_coverage=1.0,
        meta={"sentences": sentences, "target_words": target_words},
    )


# --------------------------------------------------------------------------
# Abstractive
# --------------------------------------------------------------------------


@functools.lru_cache(maxsize=1)
def _load_bart():
    """Load BART once per process; it is ~1.6 GB and slow to initialize."""
    from transformers import BartForConditionalGeneration, BartTokenizer

    log.info("loading %s", BART_MODEL)
    tokenizer = BartTokenizer.from_pretrained(BART_MODEL)
    model = BartForConditionalGeneration.from_pretrained(BART_MODEL)
    model.eval()
    return tokenizer, model


def _generate(text: str, *, min_length: int, max_length: int, num_beams: int = 4) -> str:
    """Run one BART forward pass over a single window."""
    import torch

    tokenizer, model = _load_bart()
    inputs = tokenizer(
        text,
        return_tensors="pt",
        truncation=True,
        max_length=BART_MAX_TOKENS,
    )
    with torch.no_grad():
        ids = model.generate(
            inputs["input_ids"],
            attention_mask=inputs["attention_mask"],
            num_beams=num_beams,
            length_penalty=2.0,
            min_length=min_length,
            max_length=max_length,
            no_repeat_ngram_size=3,
            early_stopping=True,
        )
    return tokenizer.decode(ids[0], skip_special_tokens=True).strip()


def _length_budget(target_words: int) -> tuple[int, int]:
    """Generation bounds in tokens for a target output length in words."""
    centre = int(target_words * _TOKENS_PER_WORD)
    return int(centre * 0.75), int(centre * 1.25)


def summarize_bart_truncated(text: str, *, target_words: int = TARGET_WORDS, **_) -> Summary:
    """Baseline: hand BART the article and let the tokenizer cut it off.

    This is what the original script did. Included precisely so the benchmark
    can quantify what the truncation costs.
    """
    low, high = _length_budget(target_words)
    return Summary(
        method="bart_truncated",
        text=_generate(text, min_length=low, max_length=high),
        chunks_processed=1,
        passes=1,
        input_coverage=coverage(text, BART_MAX_TOKENS),
        meta={"note": "everything past the first ~1024 tokens is discarded"},
    )


def summarize_bart_mapreduce(
    text: str,
    *,
    target_words: int = TARGET_WORDS,
    chunk_tokens: int = 900,
    overlap_sentences: int = 1,
    max_passes: int = 3,
    map_beams: int = 2,
    **_,
) -> Summary:
    """Hierarchical summarization: summarize every chunk, then summarize those.

    *Map*: each overlapping window is summarized independently, so no part of
    the article is discarded. *Reduce*: the concatenated chunk summaries are
    themselves chunked and summarized again, repeating until the intermediate
    text fits in one window. The final pass therefore sees material drawn from
    the whole article rather than only its opening -- which is what keeps
    context across a document longer than the model.

    Passes are capped at ``max_passes``; a 10,000-word article converges in two.

    The map pass decodes with ``map_beams`` (2) rather than the final pass's 4:
    chunk summaries are intermediate text that gets summarized again, so the
    extra beam search is largely wasted there, and it is the pass that runs
    once per chunk.
    """
    low, high = _length_budget(target_words)
    tokenizer, _ = _load_bart()

    chunks = chunk_by_tokens(
        text,
        max_tokens=chunk_tokens,
        overlap_sentences=overlap_sentences,
        tokenizer=tokenizer,
    )
    if not chunks:
        return Summary(method="bart_mapreduce", text="", chunks_processed=0)

    # Short article: one window is enough, no reduce step needed.
    if len(chunks) == 1:
        return Summary(
            method="bart_mapreduce",
            text=_generate(chunks[0].text, min_length=low, max_length=high),
            chunks_processed=1,
            passes=1,
            input_coverage=1.0,
        )

    total_calls = 0
    passes = 0
    current = chunks

    while passes < max_passes:
        passes += 1
        # Budget each chunk summary so the concatenation shrinks toward the
        # window instead of plateauing just above it.
        per_chunk = max(45, min(130, int(chunk_tokens / max(len(current), 1)) + 40))

        pieces = []
        for chunk in current:
            pieces.append(
                _generate(
                    chunk.text,
                    min_length=25,
                    max_length=per_chunk,
                    num_beams=map_beams,
                )
            )
            total_calls += 1

        merged = " ".join(pieces)
        current = chunk_by_tokens(
            merged,
            max_tokens=chunk_tokens,
            overlap_sentences=0,  # summaries are self-contained; no carry needed
            tokenizer=tokenizer,
        )
        if len(current) <= 1:
            break

    # Final pass: one clean summary over the condensed material.
    final_input = " ".join(c.text for c in current) if current else merged
    final = _generate(final_input, min_length=low, max_length=high)
    total_calls += 1

    return Summary(
        method="bart_mapreduce",
        text=final,
        chunks_processed=len(chunks),
        passes=passes + 1,
        input_coverage=1.0,
        meta={
            "model_calls": total_calls,
            "first_pass_chunks": len(chunks),
            "overlap_sentences": overlap_sentences,
        },
    )


class Method(NamedTuple):
    fn: Callable[..., Summary]
    label: str
    kind: str


METHODS = {
    "lexrank": Method(partial(_extractive, "lexrank"), "LexRank", "extractive"),
    "lsa": Method(partial(_extractive, "lsa"), "LSA", "extractive"),
    "bart_truncated": Method(
        summarize_bart_truncated, "BART (truncated)", "abstractive"
    ),
    "bart_mapreduce": Method(
        summarize_bart_mapreduce, "BART (map-reduce)", "abstractive"
    ),
}
