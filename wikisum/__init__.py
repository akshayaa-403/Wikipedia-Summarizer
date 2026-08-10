"""Wikipedia article summarization with long-context handling and ROUGE evaluation."""

from wikisum.fetch import Article, fetch_article
from wikisum.chunking import chunk_by_tokens, sentence_split
from wikisum.summarizers import SUMMARIZERS, get_summarizer
from wikisum.evaluate import rouge_scores

__version__ = "1.0.0"

__all__ = [
    "Article",
    "fetch_article",
    "chunk_by_tokens",
    "sentence_split",
    "SUMMARIZERS",
    "get_summarizer",
    "rouge_scores",
]
