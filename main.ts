// Driver for the markdown-render-speed-02 entry.
// The harness runs `node /bot/main.ts` on Node 22 (type stripping).
// It reads /input/cases.json (an array of {id, markdown}), renders every
// case on its own with parse() from parse.js, and writes the HTML strings,
// in the cases' order, to /output/html.json. Outside a container the
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR environment variables stand in
// for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(
  readFileSync(join(inputDir, 'cases.json'), 'utf8'),
) as Array<{ id: string; markdown: string }>;

const out: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) out[i] = parse(cases[i]!.markdown);

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
