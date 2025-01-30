# Wikipedia Text Summarizer

This Python application provides multiple approaches to summarize Wikipedia articles using different summarization techniques. It leverages both extractive (LexRank, LSA) and abstractive (BART) summarization methods to generate concise summaries of Wikipedia content.

## Features

- Wikipedia content extraction
- Three different summarization techniques:
  - LexRank (Extractive summarization)
  - LSA (Latent Semantic Analysis - Extractive summarization)
  - BART (Bidirectional and Auto-Regressive Transformers - Abstractive summarization)
- Interactive input for Wikipedia page selection
- Multiple summary outputs for comparison

## Prerequisites

- Python 3.6 or higher
- pip (Python package installer)

## Installation

1. Clone this repository or download the script
2. Install the required libraries using pip:

```bash
pip install wikipedia sumy transformers nltk
```

## Required Libraries

- `wikipedia`: For fetching Wikipedia content
- `sumy`: For LexRank and LSA summarization
- `transformers`: For BART-based summarization
- `nltk`: For natural language processing tasks

## Usage

1. Run the script:
```bash
python summarizer.py
```

2. When prompted, enter the name of the Wikipedia page you want to summarize
3. The script will generate three different summaries:
   - LexRank summary (5 sentences)
   - LSA summary (5 sentences)
   - BART transformer summary

## Example Output

```
Enter the name of the Wikipedia page to summarize for: Artificial Intelligence

=== LexRank Summary ===
[5 summarized sentences from LexRank]

=== LSA Summary ===
[5 summarized sentences from LSA]

=== BART Transformer Summary ===
[Generated summary from BART]
```

## Technical Details

### Summarization Methods

1. **LexRank**
   - An extractive summarization technique
   - Uses graph-based ranking algorithm
   - Selects most important sentences based on similarity

2. **LSA (Latent Semantic Analysis)**
   - Extractive summarization using topic modeling
   - Identifies key topics and related sentences
   - Uses singular value decomposition

3. **BART (Bidirectional and Auto-Regressive Transformers)**
   - Abstractive summarization technique
   - Pre-trained on large text corpora
   - Generates human-like summaries

## Limitations

- BART transformer has a maximum token limit of 1024
- Summarization quality depends on the Wikipedia article's structure
- May consume significant memory for large articles

## Acknowledgments

- Wikipedia API
- Sumy library
- Hugging Face's transformers
- NLTK (Natural Language Toolkit)
