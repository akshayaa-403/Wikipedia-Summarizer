"""Fetch Wikipedia articles and split them into lead section and body.

The lead section (everything before the first ``==`` heading) is written by
humans to summarize the rest of the article. That makes it a natural reference
summary: we summarize the *body* and score the result against the *lead*.
This is the same construction used to build the WikiSum-style datasets.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

import requests

API = "https://en.wikipedia.org/w/api.php"

# Wikipedia's API policy requires a descriptive User-Agent. The `wikipedia` PyPI
# package does not send one and gets intermittently rejected, which is why this
# module talks to the API directly.
USER_AGENT = (
    "wikisum/1.0 (https://github.com/akshayaa-403/Wikipedia-Summarizer) "
    "python-requests"
)

# Sections that are lists of links rather than prose. Keeping them would pad the
# body with citation fragments that no summarizer can do anything useful with.
BOILERPLATE_SECTIONS = {
    "see also",
    "references",
    "further reading",
    "external links",
    "notes",
    "citations",
    "bibliography",
    "sources",
    "footnotes",
}

_HEADING = re.compile(r"^={2,}\s*(.+?)\s*={2,}$", re.MULTILINE)
# Same headings, but capturing the leading '=' run so nesting depth is known.
_LEVELLED_HEADING = re.compile(r"^(={2,})\s*(.+?)\s*=+$", re.MULTILINE)


@dataclass
class Article:
    """A Wikipedia article split into the parts the pipeline needs."""

    title: str
    url: str
    lead: str
    body: str
    full: str
    sections: list[str] = field(default_factory=list)
    section_leads: str = ""

    @property
    def word_count(self) -> int:
        return len(self.full.split())

    @property
    def body_word_count(self) -> int:
        return len(self.body.split())


def _strip_boilerplate(text: str) -> str:
    """Drop reference/see-also style sections and everything nested under them.

    Depth matters. "Further reading" routinely carries ``=== Nonfiction ===``
    and ``=== Fiction ===`` subsections; a flat filter drops only the parent
    heading and leaves the citation lists behind, which then dominate the
    extractive summaries ("Curie, Marie (1921). The Discovery of Radium.").
    So a boilerplate heading suppresses every following heading deeper than
    itself, until one at the same level or shallower.
    """
    parts = _LEVELLED_HEADING.split(text)
    # parts == [before_first_heading, equals1, title1, body1, equals2, ...]
    kept = [parts[0]]
    suppressed_at: int | None = None

    for equals, title, content in zip(parts[1::3], parts[2::3], parts[3::3]):
        level = len(equals)

        if suppressed_at is not None:
            if level > suppressed_at:
                continue  # a subsection of the dropped section
            suppressed_at = None

        if title.strip().lower() in BOILERPLATE_SECTIONS:
            suppressed_at = level
            continue

        kept.append(f"{title}\n{content}")

    return "\n\n".join(kept)


def _section_leads(body: str, max_words: int = 400) -> str:
    """A reference sampled from the whole article, not just its opening.

    Scoring against the lead section quietly favours any method that reads only
    the article's opening -- which is exactly what the truncation baseline does,
    so the metric rewards the handicap it is supposed to expose. This builds the
    control: the first sentence of each section, which Wikipedia convention
    makes a topic sentence, spread across the entire document by construction.

    Capped at ``max_words`` so it stays the same order of length as the lead;
    an unbounded reference would move recall for every method at once.
    """
    from wikisum.chunking import sentence_split

    # One topic sentence per section, in document order.
    candidates: list[str] = []
    for block in body.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        # _strip_boilerplate emits "Title\nprose"; take the prose. Splitting on
        # the newline is required -- by the time _clean has run the newline is
        # gone and the title fuses onto the first sentence ("Overview In plants,
        # algae, ...").
        _, _, prose = block.partition("\n")
        sentences = sentence_split(prose.strip())
        if sentences and len(sentences[0].split()) >= 6:
            candidates.append(sentences[0])

    if not candidates:
        return ""

    # Subsample evenly rather than filling from the front. Taking sections in
    # order until the budget runs out would draw the whole reference from the
    # article's opening -- reintroducing exactly the positional bias this
    # reference exists to remove (Roman Empire covered only 10-19% of the body).
    keep = len(candidates)
    while keep > 1 and len(" ".join(candidates[:keep]).split()) > max_words:
        keep -= 1
    if keep < len(candidates):
        step = len(candidates) / keep
        candidates = [candidates[int(i * step)] for i in range(keep)]

    return " ".join(candidates)


def _clean(text: str) -> str:
    text = re.sub(r"={2,}.*?={2,}", " ", text)  # leftover heading markers
    text = re.sub(r"\n{2,}", "\n\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


class ArticleNotFound(Exception):
    """Raised when Wikipedia has no article under the requested title."""


def _api_get(params: dict, *, retries: int = 3, timeout: int = 30) -> dict:
    """GET the MediaWiki API with a descriptive UA and backoff on failure."""
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    last: Exception | None = None

    for attempt in range(retries):
        try:
            response = session.get(
                API, params={**params, "format": "json"}, timeout=timeout
            )
            response.raise_for_status()
            return response.json()
        except Exception as exc:  # network blip, rate limit, HTML error page
            last = exc
            if attempt < retries - 1:
                time.sleep(2**attempt)

    raise RuntimeError(f"Wikipedia API request failed: {last}") from last


def fetch_article(title: str) -> Article:
    """Fetch ``title`` from Wikipedia and split it into lead / body.

    Redirects are followed, but no fuzzy "did you mean" suggestion is applied:
    the suggester will happily resolve a precise title to an unrelated article,
    which silently corrupts a benchmark run.
    """
    data = _api_get(
        {
            "action": "query",
            "prop": "extracts|info",
            "explaintext": 1,
            "redirects": 1,
            "inprop": "url",
            "titles": title,
        }
    )

    pages = data.get("query", {}).get("pages", {})
    page = next(iter(pages.values()), {})
    if "missing" in page or not page.get("extract"):
        raise ArticleNotFound(f"no Wikipedia article for {title!r}")

    content = page["extract"]

    match = _HEADING.search(content)
    if match:
        lead = content[: match.start()]
        rest = content[match.start() :]
    else:  # stub article with no sections
        lead = content
        rest = ""

    body = _clean(_strip_boilerplate(rest))
    return Article(
        title=page.get("title", title),
        url=page.get("fullurl", f"https://en.wikipedia.org/wiki/{title}"),
        lead=_clean(lead),
        body=body,
        full=_clean(_strip_boilerplate(content)),
        sections=[m.group(1) for m in _HEADING.finditer(content)],
        section_leads=_section_leads(_strip_boilerplate(rest)),
    )
