# TMP Browser Demo

Interactive demo of the Trusted Match Protocol running entirely in the browser. Content classification (embeddings, keyword matching) runs locally — no text leaves the page.

## What it does

- **AI Chat**: Simulated AI assistant conversation where sponsored content changes based on what you're talking about
- **Web Page**: Paste article text, see which ad packages match
- **Custom Text**: Test any text against the sponsor package set

## How it works

1. Loads [bge-small-en-v1.5](https://huggingface.co/Xenova/bge-small-en-v1.5) (34MB, int8 quantized) via Transformers.js
2. Detects connection quality — skips model download on slow connections, falls back to keyword matching
3. Embeds conversation/page content locally in the browser
4. Matches against 13 pre-embedded sponsor packages by cosine similarity
5. Displays ranked results with scores and sponsored content card

## Running it

```bash
cd examples/tmp-browser-demo
python3 -m http.server 8765
# Open http://localhost:8765
```

Or any static file server — it's a single HTML file with no build step.

## Embedding Benchmark

`embedding-bench.mjs` tests the all-MiniLM-L6-v2 model in Node.js:

```bash
node embedding-bench.mjs
```

Tests 19 conversations against 21 ad packages. Results: 100% accuracy at 384 dimensions (int8 quantized = 384 bytes on the wire).

## Connection-aware model loading

The demo uses the Network Information API to detect connection quality:

| Connection | Behavior |
|------------|----------|
| WiFi / 5G (>2 Mbps) | Download model, use embeddings |
| 3G / slow | Skip model, use keyword matching |
| Data saver enabled | Skip model, use keyword matching |

Keyword matching runs in <1ms with zero bandwidth. Embedding matching runs in ~50-100ms after the one-time 34MB model download.
