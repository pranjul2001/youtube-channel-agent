# How Large Language Models Process Language

Series: Wildcard. Written automatically on 2026-11-19 from the sources below; 704 words. Review before publishing.

## Script

**\[Hook\]**

Can a machine truly understand human language, or is it just extraordinarily good at guessing the very next word?

Behind modern chatbots lies a complex web of math, massive data, and a revolutionary computer architecture.

Let us explore how conversational AI actually translates human thought into digital computation.

**\[From Text to Numbers\]**

Computers cannot read letters the way humans do. Algorithms process numbers instead of text. To bridge this gap, an AI system first establishes a vocabulary and assigns unique integer indices to each entry. Special control characters are often included to mark missing text or unusual symbols.

One common conversion method is byte-pair encoding. An initial set of uni-grams containing every unique character is repeatedly scanned. The most frequent pairs of adjacent characters are merged into larger n-grams until a vocabulary of a prescribed size is formed.

**\[The Transformer Breakthrough\]**

Before the transformer neural network architecture was introduced at a 2017 conference, early systems relied heavily on older sequence-to-sequence models and statistical techniques. The transformer changed everything by processing relationships between all elements in a sequence simultaneously.

Unlike older architectures that processed data word by word in a fixed line, the transformer architecture uses an attention mechanism. This allows the system to weigh the relevance of tokens across a text sequence regardless of how far apart they sit from one another.

**\[Tokens and Context Windows\]**

The attention mechanism calculates soft weights for token embeddings using multiple attention heads. Each attention head operates with its own specific relevance calculation. For example, the early GPT-2 model featured twelve attention heads and a context window of 1k tokens.

Autoregressive models are trained to guess how a word sequence continues, evaluating probabilities between words like bread or rocks. Masked models instead guess missing parts within a sequence. These predictions depend entirely on patterns found within the training dataset.

**\[Parameters and Scale\]**

LLMs are typically trained using single or half-precision floating point numbers. One float16 parameter requires 2 bytes of storage, meaning one billion parameters demand approximately 2 gigabytes of memory. Because the largest models exceed 100 billion parameters, they generally sit far beyond the range of standard consumer electronics.

Over the years, model sizes have grown dramatically. While the 2019 GPT-2 model contained 1.5 billion parameters, scale expanded rapidly into the hundreds of billions and beyond, with some frontier models reaching into the trillions of parameters.

**\[Pruning and Quantization\]**

Post-training quantization aims to decrease spatial requirements by lowering the precision of a trained model's parameters while preserving most of its performance. This can be done statically beforehand or dynamically during inference.

Quantization can simply truncate parameters to a specific number of bits, though dynamic quantization may allow different lookup tables or linear mappings per layer. Models can also be fine-tuned post-quantization using low-rank adaptation techniques.

**\[Prompting and Self-Direction\]**

In 2020, researchers demonstrated that models like GPT-3 could understand desired formatting simply by reviewing a few rounds of example Q and A input data. This approach is known as few-shot prompting.

Another discovery showed that base models could generate instructions based on user inputs, creating a self-instruct loop where the model bootstraps its way toward a correct answer. Dialogue processing systems prefix user inputs with markers like User and Assistant to maintain conversational roles.

**\[Retrieval and External Tools\]**

Retrieval-augmented generation connects an LLM with external document retrieval systems. When a query arrives, a retriever searches a vector database for relevant documents, which are then fed into the model alongside the original query.

Tool use allows AI systems to interact with external applications or fetch real-time information through APIs. Separate programs monitor the model output stream for special tool-calling syntax, execute the request, and feed the resulting data back into the input stream.

**\[The Cost of Creation\]**

Training the largest models requires substantial infrastructure and financial investment. The training cost for GPT-2 in 2019 reached $50,000, while PaLM in 2022 cost $8 million, and Megatron-Turing NLG in 2021 required around $11 million.

Because the term large language model lacks a definitive parameter threshold, the designation remains inherently vague. Training datasets must also be carefully scrubbed of low-quality or toxic data, and sometimes supplemented with synthetic data when natural text falls short.

**\[Closing\]**

Modern conversational AI operates not through conscious thought, but through intricate mathematical approximations, massive training datasets, and sophisticated attention mechanisms. As these architectures continue to evolve, they redefine how machines process the intricacies of human language.

If you enjoy exploring the mechanics behind modern technology, consider subscribing for more factual deep dives.

## Fact-check report (automatic)

| # | Claim | Status | Sources | Risk |
|---|---|---|---|---|
| 1 | In 2017, Google researchers introduced the transformer architecture in their landmark paper Attention Is All You Need at the NeurIPS conference. | Matches the source text | W1 | high |
| 2 | Training GPT-2 in 2019 cost $50,000, while training PaLM in 2022 cost $8 million. | Matches the source text | W1 | high |
| 3 | The GPT-2 model featured 12 attention heads and a context window of 1k tokens. | Matches the source text | W1 | high |
| 4 | Megatron-Turing NLG 530B was trained in 2021 at a cost of around $11 million. | Matches the source text | W1 | high |
| 5 | GPT-2 was a 1.5-billion-parameter model introduced in 2019. | Matches the source text | W1 | high |
| 6 | PaLM was a 540-billion-parameter model trained in 2022. | Matches the source text | W1 | high |
| 7 | DeepSeek released DeepSeek R1 in January 2025 as a 671-billion-parameter open-weight model. | Matches the source text | W1 | high |
| 8 | In 2001, a smoothed n-gram model trained on 300 million words achieved state-of-the-art perplexity on benchmark tests. | Matches the source text | W1 | high |
| 9 | Google transitioned its translation service to neural machine translation in 2016. | Matches the source text | W1 | high |
| 10 | BERT was introduced in 2018 and quickly became ubiquitous as an encoder-only model. | Matches the source text | W1 | high |
| 11 | OpenAI introduced GPT-1 in 2018 and GPT-2 in 2019. | Matches the source text | W1 | high |
| 12 | ChatGPT was released as a consumer-facing chatbot in late 2022, receiving extensive media coverage by 2023. | Matches the source text | W1 | high |
| 13 | OpenAI released the reasoning model OpenAI o1 in 2024 to generate long chains of thought. | Matches the source text | W1 | high |
| 14 | One float16 parameter has 16 bits, or 2 bytes, meaning one billion parameters require 2 gigabytes of memory. | Matches the source text | W1 | standard |

Every number spoken in the script was found in the sources.
Wording copied from the sources: 2% (limit 8%).

## Sources

- [W1] Large language model (Wikipedia): https://en.wikipedia.org/wiki/Large_language_model
- [W2] Artificial intelligence (Wikipedia): https://en.wikipedia.org/wiki/Artificial_intelligence
- [W3] Artificial intelligence in video games (Wikipedia): https://en.wikipedia.org/wiki/Artificial_intelligence_in_video_games
