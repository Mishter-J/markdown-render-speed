// parse.js — a faster drop-in for marked 18.1.3's marked.parse with its
// default options (GFM on, breaks off). parse(markdown) returns exactly
// the HTML marked renders, for every input.
//
// The rendering core is a fork of marked 18.1.3, vendored byte for byte in
// vendor/marked/marked.esm.js (MIT, see vendor/marked/LICENSE and
// vendor/marked/NOTICE). The speed comes from this module: marked's inline
// lexer spends most of its time in one giant `text` regex, which re-scans
// every plain-text run with a lazy pattern and a lookahead at each
// position. The scanner below finds the same run end with one simple
// pattern — a character class plus a few literals, which the regex engine
// scans natively — so a plain-text run is consumed without ever running
// that lazy regex, and the normal tokenizers still handle every construct
// the run stops at. Nothing about the output changes: the scanner stops
// at exactly the positions marked's text rule stops at.

import { marked, Tokenizer } from './vendor/marked/marked.esm.js';

// The characters of an email local part / domain, as marked's inline text
// rule spells them: [a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]
function isEmailChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
    c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 ||
    c === 96 || c === 95 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}

// If position j sits inside the local part of an email (a run of email
// characters ending at '@'), return the index where that local part
// starts; otherwise -1. This mirrors the text rule, which stops before
// an email address rather than in the middle of its local part: a
// trigger character that is also an email character (_ * ` ~ !) can sit
// inside a local part (a_b@c.d), and the text must end before the 'a',
// not at the '_'.
function emailLocalStart(s, j) {
  const n = s.length;
  let k = j;
  while (k < n && isEmailChar(s.charCodeAt(k))) k++;
  if (k >= n || s.charCodeAt(k) !== 64) return -1; // no '@' after the run
  let p = k;
  while (p > 0 && isEmailChar(s.charCodeAt(p - 1))) p--;
  return p;
}

function isAsciiAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// What may precede a `www.` link: whitespace, *, _, ~ or ( (marked's
// wwwStart lookbehind).
const WWW_PRE = /[\s*_~(]/;

// The next place plain text might end: a trigger character
// (\ < ! [ ` * ~ _ @), a www./protocol/mailto:/xmpp: link start, or a
// hard-break run (two or more spaces followed by a newline). The engine
// returns the leftmost such place; each hit is then checked against
// marked's exact stop conditions, and a hit that is not a real stop is
// skipped by resuming just past it. The protocol letters are
// case-insensitive (marked's Re matches Https://, FTP://, ...), while
// www. and mailto:/xmpp: are lowercase only.
const TEXT_STOP = /[\\<!\[`*~_@]|www\.|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|mailto:|xmpp:| {2,}\n/g;

// Where marked's inline text rule stops consuming plain text in s: the
// index just past the run. The rule's first group takes one unit once the
// other tokenizers have failed here: a whole run of backticks or tildes,
// or any one other character. From after that unit on, the run ends at
// the first real stop.
function scanTextEnd(s) {
  const n = s.length;
  let start = 1;
  const c0 = s.charCodeAt(0);
  if (c0 === 96 || c0 === 126) { // ` or ~: take the whole run, not one char
    while (start < n && s.charCodeAt(start) === c0) start++;
  }
  TEXT_STOP.lastIndex = start;
  let m;
  while ((m = TEXT_STOP.exec(s)) !== null) {
    const j = m.index;
    const hit = m[0];
    if (hit.length === 1) {
      if (hit === '@') {
        // Stop before an email local part: the run of email characters
        // ending here starts the address, and the text ends before it.
        let p = j;
        while (p > 0 && isEmailChar(s.charCodeAt(p - 1))) p--;
        if (p < j && p >= 1) return p;
        TEXT_STOP.lastIndex = j + 1;
        continue;
      }
      // A trigger character that is also an email character (_ * ` ~ !)
      // may sit inside an email local part (a_b@c.d). If it does, the
      // text ends before the local part, not here.
      if (isEmailChar(hit.charCodeAt(0))) {
        const p = emailLocalStart(s, j);
        if (p >= 1 && p <= j) return p;
      }
      return j; // a trigger character: \ < ! [ ` * ~ _
    }
    if (hit === 'www.') {
      if (WWW_PRE.test(s[j - 1])) return j;
      TEXT_STOP.lastIndex = j + 1;
      continue;
    }
    if (hit[0] === ' ') return j; // hard-break run, text ends before it
    if (hit === 'mailto:' || hit === 'xmpp:') {
      if (!isAsciiAlnum(s.charCodeAt(j - 1))) return j;
      TEXT_STOP.lastIndex = j + 1;
      continue;
    }
    return j; // http://, https:// or ftp://
  }
  return n;
}

// marked's entity handling for a text token: only numeric character
// references are decoded (&#65; -> A, &#x41; -> A); a bare & that is not
// part of a valid reference becomes &amp;. Named references (&copy;)
// pass through untouched.
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP =
  /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function unescapeText(s) {
  if (s.indexOf('&#') === -1 || !NUMERIC_REF.test(s)) return s;
  return s.replace(NUMERIC_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

// Replace the inline text tokenizer with the scanner version. The token
// it builds is the one marked's builds (same raw, same decoded text,
// same escaped flag); only the way the run end is found changes.
const origInlineText = Tokenizer.prototype.inlineText;
Tokenizer.prototype.inlineText = function (src) {
  if (!src) return origInlineText.call(this, src);
  const end = scanTextEnd(src);
  if (end <= 0) return origInlineText.call(this, src);
  const raw = src.slice(0, end);
  const inRaw = this.lexer.state.inRawBlock;
  return { type: 'text', raw, text: inRaw ? raw : unescapeText(raw), escaped: inRaw };
};



/** The HTML marked renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  return marked.parse(markdown);
}
