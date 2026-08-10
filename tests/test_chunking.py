"""Tests for the long-context handling -- the part that is easy to get subtly wrong."""

import pytest

from wikisum.chunking import chunk_by_tokens, coverage, sentence_split


def make_text(sentences: int, words: int = 20) -> str:
    return " ".join(
        " ".join(f"word{i}{j}" for j in range(words)) + "." for i in range(sentences)
    )


class TestSentenceSplit:
    def test_splits_on_terminators(self):
        assert len(sentence_split("One thing. Two things! Three things?")) == 3

    def test_keeps_abbreviations_intact(self):
        text = "Dr. Smith joined in 1997. She led the team."
        assert len(sentence_split(text)) == 2

    def test_empty(self):
        assert sentence_split("   ") == []


class TestChunking:
    def test_short_text_is_one_chunk(self):
        assert len(chunk_by_tokens(make_text(3), max_tokens=900)) == 1

    def test_long_text_splits(self):
        chunks = chunk_by_tokens(make_text(200), max_tokens=900)
        assert len(chunks) > 1

    def test_no_chunk_exceeds_the_window(self):
        for chunk in chunk_by_tokens(make_text(300), max_tokens=900):
            assert chunk.token_count <= 900 * 1.15, "chunk overflowed the window"

    def test_every_sentence_survives(self):
        """The whole point: nothing is dropped, unlike truncation."""
        text = make_text(120)
        chunks = chunk_by_tokens(text, max_tokens=400, overlap_sentences=0)
        rebuilt = " ".join(c.text for c in chunks)
        for sentence in sentence_split(text):
            assert sentence in rebuilt

    def test_overlap_carries_context_forward(self):
        chunks = chunk_by_tokens(make_text(120), max_tokens=400, overlap_sentences=2)
        assert len(chunks) > 1
        for previous, following in zip(chunks, chunks[1:]):
            tail = sentence_split(previous.text)[-2:]
            head = sentence_split(following.text)[:2]
            assert tail == head, "overlap did not carry the trailing sentences"

    def test_zero_overlap_means_no_repeats(self):
        chunks = chunk_by_tokens(make_text(120), max_tokens=400, overlap_sentences=0)
        seen = [s for c in chunks for s in sentence_split(c.text)]
        assert len(seen) == len(set(seen))

    def test_chunks_break_on_sentence_boundaries(self):
        for chunk in chunk_by_tokens(make_text(120), max_tokens=400):
            assert chunk.text.rstrip().endswith(".")

    def test_rejects_bad_arguments(self):
        with pytest.raises(ValueError):
            chunk_by_tokens("text", max_tokens=0)
        with pytest.raises(ValueError):
            chunk_by_tokens("text", overlap_sentences=-1)

    def test_empty_text(self):
        assert chunk_by_tokens("") == []


class TestCoverage:
    def test_short_text_fully_covered(self):
        assert coverage("a short sentence.", max_tokens=900) == 1.0

    def test_long_text_is_mostly_lost(self):
        assert coverage(make_text(500), max_tokens=900) < 0.15
