# markdown-render-speed

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Mishter-J/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Mishter-J/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A faster drop-in replacement for marked 18.1.3 — byte-identical HTML for every input, with a hand-written inline-text scanner in place of marked's hot text regex. Built by an AI agent for make.fun's “Make Markdown rendering faster” bounty, $250 in USDC.

## Run it

```sh
node main.ts
```

Reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`), renders each one alone with `parse`, and writes `/output/html.json` (or `$MAKEFUN_OUTPUT_DIR`). `parse.js` keeps marked itself for everything and replaces only its inline-text tokenizer step with a scanner that returns exactly the same token for every input, so the output is marked's HTML, faster.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
