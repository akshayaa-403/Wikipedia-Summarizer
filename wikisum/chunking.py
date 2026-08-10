"""Splitting long articles into model-sized windows without losing context.

BART accepts 1024 tokens (~750 words). A typical Wikipedia article is 4,000-
10,000 words, so the naive approach -- ``truncation=True`` -- throws away 80-90%
of the article and summarizes only the opening. Everything here exists to avoid
that.

Two ideas do the work:

1. **Sentence-boundary packing.** Chunks are built by adding whole sentences
   until the next one would overflow the window. A chunk therefore never ends
   mid-clause, which matters because an abstractive model asked to continue a
   severed sentence tends to invent an ending for it.

2. **Overlap.** Consecutive chunks share the last ``overlap_sentences``
   sentences of the previous chunk. Without it, a fact introduced at the end of
   chunk *n* and referred to by a pronoun at the start of chunk *n+1* leaves the
   second chunk summarizing a dangling "it" with no antecedent.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g",
    "i.e", "cf", "al", "inc", "ltd", "co", "corp", "no", "vol", "fig",
    "approx", "ca", "c", "ad", "bc", "u.s", "u.k",
}

_SENTENCE_END = re.compile(r"(?<=[.!?])[\"')\]]*\s+")


def sentence_split(text: str) -> list[str]:
    """Split text into sentences.

    Uses NLTK's Punkt tokenizer when available and falls back to a regex that
    knows about common abbreviations. The fallback keeps the package importable
    (and the tests runnable) on a machine where the NLTK corpora were never
    downloaded.
    """
    try:
        import nltk

        return [s.strip() for s in nltk.sent_tokenize(text) if s.strip()]
    except Exception:
        pass

    sentences: list[str] = []
    buffer = ""
    for piece in _SENTENCE_END.split(text):
        buffer = f"{buffer} {piece}".strip() if buffer else piece
        # A trailing token like "Dr." means the split was spurious; keep going.
        last_word = buffer.rsplit(" ", 1)[-1].rstrip(".!?\"')]").lower()
        if last_word in _ABBREVIATIONS:
            continue
        if buffer:
            sentences.append(buffer.strip())
            buffer = ""
    if buffer.strip():
        sentences.append(buffer.strip())
    return sentences


@dataclass
class Chunk:
    """One model-sized window of the article."""

    text: str
    token_count: int


def _word_token_estimate(text: str) -> int:
    """Approximate BPE token count when no tokenizer is supplied.

    English prose runs about 1.3 subword tokens per whitespace word for BART's
    vocabulary; Wikipedia's proper nouns and numbers push it a little higher, so
    we use 1.4 to stay on the safe side of the window.
    """
    return int(len(text.split()) * 1.4) + 2


def chunk_by_tokens(
    text: str,
    *,
    max_tokens: int = 900,
    overlap_sentences: int = 1,
    tokenizer=None,
) -> list[Chunk]:
    """Pack ``text`` into overlapping, sentence-aligned chunks.

    ``max_tokens`` defaults to 900 rather than BART's full 1024 to leave room
    for the special tokens the tokenizer adds and for the estimator being
    approximate. A single sentence longer than the window is emitted on its own
    and truncated by the model -- rare enough in Wikipedia prose to accept.
    """
    if max_tokens <= 0:
        raise ValueError("max_tokens must be positive")
    if overlap_sentences < 0:
        raise ValueError("overlap_sentences must be non-negative")

    count = (
        (lambda s: len(tokenizer.encode(s, add_special_tokens=False)))
        if tokenizer is not None
        else _word_token_estimate
    )

    sentences = sentence_split(text)
    if not sentences:
        return []

    chunks: list[Chunk] = []
    current: list[str] = []
    current_tokens = 0

    for sentence in sentences:
        tokens = count(sentence)

        if current and current_tokens + tokens > max_tokens:
            chunks.append(Chunk(" ".join(current), current_tokens))
            # Carry the tail of this chunk into the next one so pronouns and
            # continuations at the boundary still have their antecedent.
            carry = current[-overlap_sentences:] if overlap_sentences else []
            current = list(carry)
            current_tokens = sum(count(s) for s in current)

        current.append(sentence)
        current_tokens += tokens

    if current:
        chunks.append(Chunk(" ".join(current), current_tokens))

    return chunks


def coverage(text: str, max_tokens: int = 900) -> float:
    """Fraction of ``text`` a single truncated window would actually see.

    Reported on the site to make the truncation baseline's handicap concrete.
    """
    total = _word_token_estimate(text)
    return min(1.0, max_tokens / total) if total else 1.0
