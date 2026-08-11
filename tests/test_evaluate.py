"""Tests for ROUGE scoring and the lead/body split."""

from wikisum.evaluate import ROUGE_TYPES, aggregate, rouge_scores
from wikisum.fetch import _clean, _strip_boilerplate


class TestRouge:
    def test_identical_text_scores_one(self):
        text = "The mitochondrion is the powerhouse of the cell."
        scores = rouge_scores(text, text)
        assert scores.rouge1 == 1.0
        assert scores.rouge2 == 1.0
        assert scores.rougeL == 1.0

    def test_disjoint_text_scores_zero(self):
        scores = rouge_scores("alpha beta gamma", "delta epsilon zeta")
        assert scores.rouge1 == 0.0

    def test_partial_overlap_is_between(self):
        scores = rouge_scores(
            "The cat sat on the mat.", "The cat sat on the warm mat by the fire."
        )
        assert 0.0 < scores.rouge1 < 1.0
        assert scores.rouge2 > 0.0

    def test_bigrams_punish_reordering(self):
        reference = "alpha beta gamma delta"
        ordered = rouge_scores("alpha beta gamma delta", reference)
        shuffled = rouge_scores("delta gamma beta alpha", reference)
        assert ordered.rouge2 > shuffled.rouge2
        # unigram overlap is identical -- which is exactly why we report both
        assert ordered.rouge1 == shuffled.rouge1

    def test_empty_input_is_zero_not_an_error(self):
        assert rouge_scores("", "something").rouge1 == 0.0
        assert rouge_scores("something", "").rouge1 == 0.0

    def test_stemming_matches_inflections(self):
        assert rouge_scores("computing systems", "computed system").rouge1 > 0.0


class TestAggregate:
    def test_empty(self):
        result = aggregate([])
        assert result["rouge1"]["mean"] == 0.0

    def test_mean_and_stdev(self):
        scored = [rouge_scores("alpha beta", "alpha gamma").as_dict()] * 2
        assert aggregate(scored)["rouge1"]["stdev"] == 0.0

        result = aggregate([{k: v for k in ROUGE_TYPES} for v in (0.2, 0.4)])
        assert result["rouge1"]["mean"] == 0.3
        assert result["rouge1"]["stdev"] > 0


class TestBoilerplate:
    def test_reference_sections_are_dropped(self):
        text = (
            "Lead text here.\n\n"
            "== History ==\nIt began in 1900.\n\n"
            "== References ==\n[1] Some citation.\n\n"
            "== External links ==\nhttps://example.com\n"
        )
        stripped = _clean(_strip_boilerplate(text))
        assert "It began in 1900" in stripped
        assert "Some citation" not in stripped
        assert "example.com" not in stripped

    def test_subsections_of_boilerplate_are_dropped(self):
        """Regression: "Further reading" nests === Nonfiction === under itself.

        A flat filter drops only the parent heading, leaving the citation list
        in the body where it goes on to dominate the extractive summaries.
        """
        text = (
            "Lead.\n\n"
            "== Legacy ==\nShe is widely commemorated.\n\n"
            "== Further reading ==\n\n"
            "=== Nonfiction ===\nCurie, Eve (2001). Madame Curie: A Biography.\n\n"
            "=== Fiction ===\nQuinn, Susan. Marie Curie: A Life, 1996.\n\n"
            "== Death ==\nShe died in 1934.\n"
        )
        stripped = _clean(_strip_boilerplate(text))
        assert "widely commemorated" in stripped
        assert "She died in 1934" in stripped, "a section after the boilerplate was lost"
        assert "Madame Curie" not in stripped
        assert "Marie Curie: A Life" not in stripped

    def test_prose_subsections_survive(self):
        text = (
            "Lead.\n\n== Life ==\nOverview.\n\n"
            "=== Early years ===\nBorn in Warsaw.\n\n"
            "== References ==\n[1] Citation.\n"
        )
        stripped = _clean(_strip_boilerplate(text))
        assert "Born in Warsaw" in stripped
        assert "Citation" not in stripped

    def test_prose_sections_survive(self):
        text = "Lead.\n\n== Biology ==\nCells divide.\n\n== Chemistry ==\nBonds form.\n"
        stripped = _clean(_strip_boilerplate(text))
        assert "Cells divide" in stripped
        assert "Bonds form" in stripped
