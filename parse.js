// parse.js — a faster drop-in replacement for marked 18.1.3.
//
// marked's own inline-text regex (its GFM `text` rule) is the hot spot: a
// lazy `[\s\S]*?` scan with four lookahead alternatives tested at every
// position. This module keeps marked itself for everything and replaces
// only that one tokenizer step with a hand-written scanner that returns
// exactly the same token for every input.
//
// The scanner below is a transcription of marked 18.1.3's GFM text regex
// (vendor/marked/marked.esm.js):
//
//   ^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)
//      |(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[EMAIL]+@)
//      |[\s\S]*?(?:(?=[STOP]|\b_|HTTP|FTP:\/\/|www\.|$)
//      |[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)
//      |[^EMAIL](?=[EMAIL]+@))))
//
// where STOP is [\<!\[`*~_], HTTP is [hH][tT][tT][pP][sS]? (bare — the
// regex's alternation drops the :// after it, and the stop is unobservable
// anyway: a failed url() just lets the text scan re-consume the same run),
// FTP is [fF][tT][pP]:\/\/, www. is (?<![^\s*_~(])www\. (lowercase only,
// preceded by the start, whitespace, *, _, ~ or (), and EMAIL is
// [a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-].
//
// Three behaviours fall out of that regex and are easy to get wrong:
//   - a backtick run is consumed whole by the first group, so a run is
//     never split before the scan for stops starts;
//   - a scheme is case-insensitive (Https://, FTP:// are autolinks) while
//     www. and mailto:/xmpp: stay lowercase-only;
//   - an email local part is never split at its _ — the scan stops before
//     the address (at the char before it), never inside it.
//
// (MIT; marked itself is MIT, vendor/marked/LICENSE.)

import { marked } from './vendor/marked/marked.esm.js';

// Character tables: every set the regex uses is ASCII-only, so a 128-entry
// table answers each test with one indexed read.
const EMAIL = new Uint8Array(128); // [a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]
for (const s of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&\'*+/=?_`{|}~-') {
  EMAIL[s.charCodeAt(0)] = 1;
}

const ALNUM = new Uint8Array(128); // [a-zA-Z0-9]
for (const s of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
  ALNUM[s.charCodeAt(0)] = 1;
}

// The two searches the segment scan runs: the first stop-class char, and
// the first case-insensitive protocol. Both are single V8 regex scans, far
// cheaper than stepping through the string a character at a time in JS.
const STOP_RE = /[\\<!\[`*~_]/g;
const PROTO_RE = /http|ftp:\/\//i;

// Does [EMAIL]+@ start at j? (the (?=[EMAIL]+@) lookahead.)
function emailAhead(src, j) {
  const n = src.length;
  let k = j;
  while (k < n) {
    const c = src.charCodeAt(k);
    if (c >= 128 || EMAIL[c] === 0) break;
    k++;
  }
  return k > j && k < n && src.charCodeAt(k) === 64; // '@'
}

// Do 2+ spaces followed by \n start at j? (the (?= {2,}\n) lookahead.)
function twoSpacesNewline(src, j) {
  const n = src.length;
  let k = j;
  while (k < n && src.charCodeAt(k) === 32) k++;
  return k - j >= 2 && k < n && src.charCodeAt(k) === 10;
}

// Lowercase "www." whose preceding char is the start, whitespace, *, _, ~ or (.
function wwwAt(src, i) {
  if (src.charCodeAt(i) !== 119 || src.charCodeAt(i + 1) !== 119
    || src.charCodeAt(i + 2) !== 119 || src.charCodeAt(i + 3) !== 46) return false;
  if (i === 0) return true;
  return /[\s*_~(]/.test(src.charAt(i - 1));
}

// The token marked's GFM text regex matches at the start of src, or null
// when src is empty.
//
// The regex finds the smallest position where any of its stop alternatives
// fires; the token ends there (or one char past it, for the alternatives
// that consume a char). So instead of stepping through the string, this
// finds the earliest firing position of each alternative and takes the
// smallest resulting end. The first stop-class char bounds every other
// search: nothing past it can win, so the segment [p, s) is all any of
// them may scan.
function scanText(src) {
  const n = src.length;
  if (n === 0) return null;
  const c0 = src.charCodeAt(0);
  // [^a-zA-Z0-9](?=(?:mailto|xmpp):) — one non-alnum char before a scheme.
  if ((c0 >= 128 || ALNUM[c0] === 0)
    && (src.startsWith('mailto:', 1) || src.startsWith('xmpp:', 1))) {
    return src.slice(0, 1);
  }
  // (`+|~+|[^`~]) — a backtick run, a tilde run, or one other char.
  let p;
  if (c0 === 96) { p = 1; while (p < n && src.charCodeAt(p) === 96) p++; }
  else if (c0 === 126) { p = 1; while (p < n && src.charCodeAt(p) === 126) p++; }
  else p = 1;
  // The three zero-width alternatives right after the first group.
  if (p < n) {
    const cp = src.charCodeAt(p);
    if (cp === 96 || cp === 126) return src.slice(0, p); // (?=[`~])
    if (twoSpacesNewline(src, p)) return src.slice(0, p); // (?= {2,}\n)
    if (emailAhead(src, p)) return src.slice(0, p); // (?=[EMAIL]+@)
  }
  // The first stop-class char bounds the segment; without one the token
  // runs to the end unless an earlier alternative fires inside it.
  STOP_RE.lastIndex = p;
  const stopMatch = STOP_RE.exec(src);
  const s = stopMatch ? stopMatch.index : n;
  let end = s;
  const seg = src.slice(p, s);
  // (?=HTTP|FTP:\/\/) — the first case-insensitive protocol in the segment.
  const protoAt = seg.search(PROTO_RE);
  if (protoAt !== -1 && p + protoAt < end) end = p + protoAt;
  // (?=www\.) — the first www. with a valid preceding char.
  let w = seg.indexOf('www.');
  while (w !== -1) {
    if (wwwAt(src, p + w)) { if (p + w < end) end = p + w; break; }
    w = seg.indexOf('www.', w + 1);
  }
  // [^ ](?= {2,}\n) — the first 2+-spaces-plus-newline run whose run start
  // is past p (a run starting at or before p cannot fire: the char before
  // it sits inside the first group, or does not exist).
  let j = seg.indexOf('  \n');
  while (j !== -1) {
    let runStart = p + j;
    while (runStart > 0 && src.charCodeAt(runStart - 1) === 32) runStart--;
    if (runStart > p) { if (runStart < end) end = runStart; break; }
    j = seg.indexOf('  \n', j + 1);
  }
  // [^a-zA-Z0-9](?=(?:mailto|xmpp):) — the first scheme whose preceding
  // char is a non-alnum char at or past p.
  for (const scheme of ['mailto:', 'xmpp:']) {
    let m = seg.indexOf(scheme);
    while (m !== -1) {
      const before = p + m - 1;
      if (before >= p) {
        const c = src.charCodeAt(before);
        if (c >= 128 || ALNUM[c] === 0) { if (p + m < end) end = p + m; break; }
      }
      m = seg.indexOf(scheme, m + 1);
    }
  }
  // [^EMAIL](?=[EMAIL]+@) — the first @ whose email local part starts
  // past p; the token ends at the local part's start. The @ may sit past
  // the first stop char (the local part itself may hold _ * ` ~), so the
  // search is bounded two ways instead of scanning the rest of the
  // string: @s inside the segment, and — only if none of those is a real
  // address — the @ at the end of the email-char run containing the stop
  // position, which is the only @ past it whose local part can start
  // before the stop. A bare @ with no local part is not an address.
  let emailEnd = -1;
  let a = seg.indexOf('@');
  while (a !== -1) {
    const at = p + a;
    let e = at;
    while (e > 0) {
      const c = src.charCodeAt(e - 1);
      if (c >= 128 || EMAIL[c] === 0) break;
      e--;
    }
    if (e < at && e > p) { emailEnd = e; break; }
    a = seg.indexOf('@', a + 1);
  }
  if (emailEnd === -1 && s < n) {
    const cs = src.charCodeAt(s);
    if (cs < 128 && EMAIL[cs] === 1) {
      let at = s;
      while (at < n) {
        const c = src.charCodeAt(at);
        if (c >= 128 || EMAIL[c] === 0) break;
        at++;
      }
      if (at < n && src.charCodeAt(at) === 64) {
        let e = s;
        while (e > 0) {
          const c = src.charCodeAt(e - 1);
          if (c >= 128 || EMAIL[c] === 0) break;
          e--;
        }
        if (e < at && e > p) emailEnd = e;
      }
    }
  }
  if (emailEnd !== -1 && emailEnd < end) end = emailEnd;
  return src.slice(0, end);
}

// marked's numeric-entity decoding (its Ie helper): only numeric character
// references are decoded; a bare & that starts no valid reference becomes
// &amp;. The includes('&#') pre-check skips the regex test for the common
// case of text with no numeric reference at all.
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeEntities(text) {
  if (!text.includes('&#')) return text;
  return NUMERIC_REF.test(text)
    ? text.replace(NUMERIC_REF_OR_AMP, (whole, dec, hex) => {
      if (dec === undefined && hex === undefined) return '&amp;';
      const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
      if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return '\uFFFD';
      return code === 38 ? '&amp;' : String.fromCodePoint(code);
    })
    : text;
}

// The replacement inlineText: exactly the token marked's GFM text regex
// returns, computed by scanText instead. Any other rule set (breaks,
// pedantic, non-GFM) falls back to marked's own tokenizer by returning
// false, which the use() wrapper then runs.
function inlineText(src) {
  const options = this.lexer && this.lexer.options;
  if (!options || !options.gfm || options.breaks || options.pedantic) return false;
  const raw = scanText(src);
  if (raw === null) return false;
  const inRawBlock = this.lexer.state.inRawBlock;
  return {
    type: 'text',
    raw,
    text: inRawBlock ? raw : decodeEntities(raw),
    escaped: inRawBlock,
  };
}

marked.use({ tokenizer: { inlineText } });

/** The HTML marked renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  return marked.parse(markdown);
}
