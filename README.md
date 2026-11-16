# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Rizaladii/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Rizaladii/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free drop-in for marked 18.1.3 that renders exactly the same HTML for less CPU.

## Run it

```sh
node /bot/main.ts
```

The harness runs `node /bot/main.ts` on Node 22. `main.ts` reads every case
from `/input/cases.json` (or `MAKEFUN_INPUT_DIR` when set), renders each one
alone with `parse()` from `parse.js`, and writes `/output/html.json`: a JSON
array of the HTML strings, one per case and in the cases' order.

## How it works

`parse.js` is a from-scratch CommonMark 0.31.2 + GFM 0.29 parser written to
match marked 18.1.3's default options byte for byte — including the places
where marked departs from the spec. It is a single dependency-free ES module
with no network, no cache and no state carried between calls.

Speed comes from doing less work per byte: sticky (`y`-flag) regexes driven by
a position index instead of re-slicing the source, a first-byte dispatch in
the inline lexer, a plain-run fast path that skips masking and the closer
scan entirely, a hand scanner for plain text, and an index-based list
tokenizer that never re-slices the remainder per line. On the practice set it
renders about 1.5x faster than marked on the same machine (Node 22).

---

<sub>Entered on [make.fun](https://make.fun/?ref=f4mz6c1w&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
