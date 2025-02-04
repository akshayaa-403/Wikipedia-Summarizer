# Import required libraries
import wikipedia
from sumy.parsers.plaintext import PlaintextParser
from sumy.nlp.tokenizers import Tokenizer
from sumy.summarizers.lex_rank import LexRankSummarizer
from sumy.summarizers.lsa import LsaSummarizer
import nltk
from transformers import BartForConditionalGeneration, BartTokenizer

# Download required NLTK data
nltk.download('punkt')
nltk.download('punkt_tab')  # Additional component to fix the error

# Enter keyword to summarize
keyword = input("Enter the name of the Wikipedia page to summarize for: ")

# Fetch Wikipedia content
wikisearch = wikipedia.page(keyword)
wikicontent = wikisearch.content

# Summarization using Sumy (LexRank)
print("=== LexRank Summary ===")
parser = PlaintextParser.from_string(wikicontent, Tokenizer("english"))
lex_rank_summarizer = LexRankSummarizer()
lexrank_summary = lex_rank_summarizer(parser.document, sentences_count=5)
for sentence in lexrank_summary:
    print(sentence)

# Summarization using Sumy (LSA)
print("\n=== LSA Summary ===")
lsa_summarizer = LsaSummarizer()
lsa_summary = lsa_summarizer(parser.document, sentences_count=5)
for sentence in lsa_summary:
    print(sentence)

# Summarization using Hugging Face's transformers (BART)
print("\n=== BART Transformer Summary ===")
tokenizer = BartTokenizer.from_pretrained("facebook/bart-large-cnn")
model = BartForConditionalGeneration.from_pretrained("facebook/bart-large-cnn")
inputs = tokenizer.batch_encode_plus(
    [wikicontent],
    return_tensors="pt",
    truncation=True,
    max_length=1024  # BART has a max token limit of 1024
)
summary_ids = model.generate(inputs["input_ids"], early_stopping=True)
bart_summary = tokenizer.decode(summary_ids[0], skip_special_tokens=True)
print(bart_summary)
