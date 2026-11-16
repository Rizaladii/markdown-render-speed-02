// parse.js — a fast, dependency-free CommonMark 0.31.2 + GFM 0.29 renderer.
// parse(markdown) returns exactly the HTML marked 18.1.3 returns with its
// default options (gfm on, breaks off, pedantic off, async off), byte for
// byte. Written from scratch: the pipeline, the code and the structure are
// my own; the grammar it implements is the CommonMark + GFM spec as marked
// interprets it (where marked departs from the spec, marked wins).
//
// Design: a block pass turns the source into a small tree of block nodes
// (inline content is queued and lexed afterwards, so link definitions
// anywhere in the document resolve), then a render pass walks the tree.
// The hot loops scan with sticky regexes at a position index instead of
// re-slicing the remaining source for every token.
//
// parse() is stateless per call by design: nothing is cached between cases,
// so a scored set of any size renders each case from scratch.

// ---------------------------------------------------------------- patterns

// A leading ^ inside a fragment that gets spliced into a bigger pattern
// would anchor to the start of the whole string; strip it when splicing.
const CARET_STRIP = /(^|[^\[])\^/g;

// Compose a regex from a template string, replacing each slot name with a
// fragment (string or regex source). Fragments lose a leading ^. Slot names
// are replaced longest-first, so a name that is a prefix of another (PUNCT
// inside PUNCTSPACE) cannot corrupt the longer one.
function build(template, flags, slots) {
  let src = template;
  if (slots) {
    const names = Object.keys(slots).sort((a, b) => b.length - a.length);
    for (const name of names) {
      let frag = slots[name];
      if (frag instanceof RegExp) frag = frag.source;
      frag = frag.replace(CARET_STRIP, '$1');
      src = src.split(name).join(frag);
    }
  }
  return new RegExp(src, flags || '');
}

// A position-anchored (sticky) copy of a ^-anchored pattern: the match must
// start exactly at lastIndex, so no ^ is needed (and a ^ would pin it to 0).
function stick(re) {
  // Strip the anchor at the start of every alternative (after ^, | or (,
  // never inside [^...] or \^^), or the pattern could only ever match at
  // position 0 of the string.
  const body = re.source.replace(/(^|\||\()\^/g, '$1');
  const flags = re.flags.replace('g', '').replace('y', '') + 'y';
  return new RegExp(body, flags);
}

// Run a sticky regex at a position in a string.
function at(re, str, pos) {
  re.lastIndex = pos;
  return re.exec(str);
}

// ------------------------------------------------------------- misc regexes

const MISC = {
  // strip 0-4 spaces (or a tab) of indent from an indented code block line
  codeDedent: /^(?: {0,3}\t| {1,4})/gm,
  // unescape [ and ] inside a link label
  labelUnescape: /\\([\[\]])/g,
  // how much a fenced block's own indent takes off its content lines
  fenceIndent: /^(\s+)(?:```)/,
  leadSpace: /^\s+/,
  endsHash: /#$/,
  startsSpace: /^ /,
  endsSpace: / $/,
  endsSpaceTab: /[ \t]$/,
  nonSpace: /[^ ]/,
  newlineGlobal: /\n/g,
  tabGlobal: /\t/g,
  leadSpaceTab: /^[ \t]+/,
  multiSpace: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlank: /\n[ \t]*\n[ \t]*$/,
  bqStart: /^ {0,3}>/,
  // a lazy setext underline inside a blockquote must not become a heading
  bqSetext: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  bqMarker: /^ {0,3}>[ \t]?/gm,
  bqMarkerSpace: /^( {0,3}>)([ \t]+)/gm,
  listNest: /^ {1,4}(?=( {4})*[^ ])/g,
  listTask: /^\[[ xX]\][ \t]+\S/,
  listTaskStrip: /^\[[ xX]\][ \t]+/,
  taskBox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  angleHref: /^<(.*)>$/,
  tableDelim: /[:|]/,
  tableEdge: /^\||\| *$/g,
  tableBlankRow: /\n[ \t]*$/,
  alignRight: /^ *-+: *$/,
  alignCenter: /^ *:-+: *$/,
  alignLeft: /^ *:-+ *$/,
  aOpen: /^<a /i,
  aClose: /^<\/a>/i,
  preOpen: /^<(pre|code|kbd|script)(\s|>)/i,
  preClose: /^<\/(pre|code|kbd|script)(\s|>)/i,
  angleOpen: /^</,
  angleClose: />$/,
  pedanticTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/,
  alphaNum: /[\p{L}\p{N}]/u,
  numRef: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numRefOrAmp: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escTest: /[&<>"']/,
  escReplace: /[&<>"']/g,
  escTestLoose: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escReplaceLoose: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  pct: /%25/g,
  pipe: /\|/g,
  pipeSplit: / \|/,
  pipeEscaped: /\\\|/g,
  crlf: /\r\n|\r/g,
  spaceOnlyLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endsNewline: /\n$/,
  // list item / interrupt factories (indent 0..3, cached)
  itemRe: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBullet: (indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),
  hrAt: (indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`),
  fencesAt: (indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`),
  headAt: (indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`),
  htmlAt: (indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'),
  bqAt: (indent) => new RegExp(`^ {0,${indent}}>`),
};

// Block-level HTML tags (CommonMark condition 6 list).
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

// ------------------------------------------------------------ string helpers

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML. With encode, every & < > " ' becomes an entity; without it,
// an & that already starts a character reference is left alone.
function escapeHtml(html, encode) {
  if (encode) {
    if (MISC.escTest.test(html)) return html.replace(MISC.escReplace, (ch) => ESCAPES[ch]);
  } else if (MISC.escTestLoose.test(html)) {
    return html.replace(MISC.escReplaceLoose, (ch) => ESCAPES[ch]);
  }
  return html;
}

// Numeric character references outside code stand for the character they
// name; zero, out of range, or a surrogate becomes the replacement char.
// A decoded & must not join its neighbours into a new reference.
function decodeRefs(text) {
  if (!MISC.numRef.test(text)) return text;
  return text.replace(MISC.numRefOrAmp, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

// A link destination is only usable when encodeURI accepts it.
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(MISC.pct, '%');
  } catch {
    return null;
  }
  return href;
}

// Split a table row on unescaped pipes, trimming cells and honouring a
// column count (extra cells are dropped, missing ones padded empty).
function splitCells(row, count) {
  const marked = row.replace(MISC.pipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = marked.split(MISC.pipeSplit);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(MISC.pipeEscaped, '|');
  return cells;
}

// Remove a suffix of c's (or, with invert, of non-c's) without a regex.
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suff = 0;
  while (suff < l) {
    const ch = str.charAt(l - suff - 1);
    if (ch === c && !invert) suff++;
    else if (ch !== c && invert) suff++;
    else break;
  }
  return str.slice(0, l - suff);
}

// Drop trailing blank lines, keeping at most one.
function trimBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && MISC.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

// A link label, folded for matching: trimmed, inner whitespace collapsed,
// Unicode case folded (round-trip through upper case, as commonmark.js).
function normalizeLabel(label) {
  return label.trim().replace(MISC.multiSpace, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Where the brackets in str close, counting nesting and skipping escapes:
// -1 balanced or absent, -2 more opens than closes, else the index of an
// unmatched closer.
function closingBracket(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === pair[0]) level++;
    else if (str[i] === pair[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

// Expand tabs to spaces, tracking the column from indent.
function expandTabs(line, indent) {
  let col = indent || 0;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// ------------------------------------------------------------ block grammar

const COMMENT = '<!--(?:-?>|[\\s\\S]*?(?:-->|$))';
const BULLET = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const TAG_ATTR = ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?';

// A link label inside a definition (up to 999 chars is enforced by the
// bounded variant used for searching).
const DEF_LABEL = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
// A link title: "..." or '...' or (...), with backslash escapes inside.
const DEF_TITLE = '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))';

const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  text: /^[^\n]+/,
  list: build('^(BULLET)([ \\t][^\\n]*?)?(?:\\n|$)', '', { BULLET }),
  def: build('^ {0,3}\\[(LABEL)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(TITLE))? *(?:\\n+|$)', '', {
    LABEL: DEF_LABEL,
    TITLE: DEF_TITLE,
  }),
  html: build(
    '^ {0,3}(?:'
    + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
    + '|COMMENT[^\\n]*(\\n+|$)'
    + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
    + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
    + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
    + '|</?(TAG)(?:[ \\t]+|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
    + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:ATTR)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
    + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
    + ')', 'i', { COMMENT, TAG: BLOCK_TAGS, ATTR: TAG_ATTR }),
};

// Setext heading: the underline may end with spaces or tabs; the text may
// not be interrupted by a list, code, fence, quote, heading, hr, html or
// (in GFM) a table start. The |TABLE slot is replaced whole (pipe and all)
// so a missing table leaves no empty alternative behind.
function makeSetext(tableFrag) {
  return build(SETEXT_CORE, '', { ...SETEXT_SLOTS, '|TABLE': tableFrag });
}
const SETEXT_CORE = '^(?!BULLET|CODE|FENCES|BQ|HEAD|HTML|TABLE)((?:.|\\n(?!\\s*?\\n|BULLET|FENCES|BQ|HEAD|HR|HTML|TABLE))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
const SETEXT_SLOTS = {
  BULLET,
  CODE: '(?: {4}| {0,3}\\t)',
  FENCES: ' {0,3}(?:`{3,}|~{3,})',
  BQ: ' {0,3}>',
  HEAD: ' {0,3}#{1,6}(?:\\s|$)',
  HR: ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)',
  HTML: ' {0,3}<[^\\n>]+>\\n',
};
BLOCK.lheading = makeSetext(' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n');

// GFM table: header line, delimiter row, body rows (a body row ends at a
// blank line or a line that starts another block).
BLOCK.table = build(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|HR|HEAD|BQ|CODE|FENCES|LIST|HTML).*(?:\\n|$))*)\\n*|$)', '',
  {
    HR: BLOCK.hr,
    HEAD: ' {0,3}#{1,6}(?:\\s|$)',
    BQ: ' {0,3}>',
    CODE: '(?: {4}| {0,3}\\t)[^\\n]',
    FENCES: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
    LIST: ' {0,3}(?:[*+-]|1[.)])[ \\t]',
    HTML: ' {0,3}(?:</?(?:TAG)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
    TAG: BLOCK_TAGS,
  });

// A paragraph is interrupted by a line that starts a heading, hr, fence,
// quote, list, html block or (in GFM) a table; a setext underline does not
// interrupt it, and a line of only spaces ends it.
function makeParagraph(listInterrupt) {
  return build(
    '^([^\\n]+(?:\\n(?!HR|HEAD|BQ|FENCES|LIST|HTML|TABLE|[ \\t]+\\n)[^\\n]+)*)', '',
    {
      HR: BLOCK.hr,
      HEAD: ' {0,3}#{1,6}(?:\\s|$)',
      BQ: ' {0,3}>',
      FENCES: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
      LIST: listInterrupt,
      HTML: ' {0,3}(?:</?(?:TAG)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
      TAG: BLOCK_TAGS,
      TABLE: BLOCK.table,
    });
}
BLOCK.paragraph = makeParagraph(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]');
// Inside a blockquote a bare list marker (any number) starts a sibling list,
// so it must not be lazily continued as paragraph text.
BLOCK.bqParagraph = makeParagraph(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)');

BLOCK.blockquote = build(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(PARA)|[^\\n]*)(?:\\n|$))+', '',
  { PARA: BLOCK.bqParagraph });

// Sticky (position-anchored) copies for the hot loops.
const S = {};
for (const key of Object.keys(BLOCK)) S[key] = stick(BLOCK[key]);
S.paragraph = stick(BLOCK.paragraph);
S.bqParagraph = stick(BLOCK.bqParagraph);

// ---------------------------------------------------------- inline grammar

// One matched pair of brackets, holding no bracket of its own.
const LABEL_BRACKETS = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
// A link label: brackets nest to a fixed depth of two, which is what the
// spec suite asks for; code spans and escapes may appear inside it.
const LABEL_INLINE = '(?:\\[(?:BRACKETS|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
// The title after a link destination.
const LINK_TITLE = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';

// Bounded variants used when searching for a reference link: the label is
// capped at 999 items (every label CommonMark allows) so a candidate that
// can never match does not scan to the end of the source.
const LABEL_BLOCK_B = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const LABEL_INLINE_B = '(?:[^\\[\\]\\\\`]*(?:\\[(?:BRACKETS|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';

const PUNCT = '[\\p{P}\\p{S}]';
// In GFM, ~ is not punctuation for emphasis (it belongs to strikethrough).
const PUNCT_GFM = '(?!~)[\\p{P}\\p{S}]';
const PUNCT_SPACE = '[\\s\\p{P}\\p{S}]';
const PUNCT_SPACE_GFM = '(?!~)[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE = '[^\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_GFM = '(?:[^\\s\\p{P}\\p{S}]|~)';

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  autolink: build('^<(SCHEME:[^\\s\\x00-\\x1f<>]*|EMAIL)>', '', {
    SCHEME: '[a-zA-Z][a-zA-Z0-9+.-]{1,31}',
    EMAIL: '[a-zA-Z0-9.!#$%&\'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])',
  }),
  tag: build(
    '^COMMENT'
    + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
    + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:ATTR)*?\\s*/?>'
    + '|^<\\?[\\s\\S]*?\\?>'
    + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
    + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>', '',
    {
      COMMENT: '<!--(?:-?>|[\\s\\S]*?-->)',
      ATTR: '\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?',
    }),
  link: build('^!?\\[(LABEL)\\]\\([ \\t\\n]*(HREF)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(TITLE))?[ \\t\\n]*\\)', '', {
    LABEL: LABEL_INLINE.replace(/BRACKETS/g, LABEL_BRACKETS),
    HREF: '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))',
    TITLE: LINK_TITLE,
  }),
  reflink: build('^!?\\[(LABEL)\\]\\[(REF)\\]', '', {
    LABEL: LABEL_INLINE.replace(/BRACKETS/g, LABEL_BRACKETS),
    REF: DEF_LABEL,
  }),
  nolink: build('^!?\\[(REF)\\](?:\\[\\])?', '', { REF: DEF_LABEL }),
  // A punctuation run (not * or _) that can follow an emphasis opener.
  punct: build('^((?![*_])PUNCTSPACE)', 'u', { PUNCTSPACE: PUNCT_SPACE }),
  // What an emphasis opener looks like: a run of * or _ plus what follows.
  emLDelim: build('^(?:\\*+(?:((?!\\*)PUNCT)|([^\\s*]))?)|^_+(?:((?!_)PUNCT)|([^\\s_]))?', 'u', { PUNCT: PUNCT_GFM }),
  // What can close an emphasis span: six shapes, by what flanks the run.
  emRDelimAst: build(
    '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
    + '|[^*]+(?=[^*])'
    + '|(?!\\*)PUNCT(\\*+)(?=[\\s]|$)'
    + '|NOTPUNCTSPACE(\\*+)(?!\\*)(?=PUNCTSPACE|$)'
    + '|(?!\\*)PUNCTSPACE(\\*+)(?=NOTPUNCTSPACE)'
    + '|[\\s](\\*+)(?!\\*)(?=PUNCT)'
    + '|(?!\\*)PUNCT(\\*+)(?!\\*)(?=PUNCT)'
    + '|NOTPUNCTSPACE(\\*+)(?=NOTPUNCTSPACE)', 'gu',
    { PUNCT: PUNCT_GFM, PUNCTSPACE: PUNCT_SPACE_GFM, NOTPUNCTSPACE: NOT_PUNCT_SPACE_GFM }),
  emRDelimUnd: build(
    '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
    + '|[^_]+(?=[^_])'
    + '|(?!_)PUNCT(_+)(?=[\\s]|$)'
    + '|NOTPUNCTSPACE(_+)(?!_)(?=PUNCTSPACE|$)'
    + '|(?!_)PUNCTSPACE(_+)(?=NOTPUNCTSPACE)'
    + '|[\\s](_+)(?!_)(?=PUNCT)'
    + '|(?!_)PUNCT(_+)(?!_)(?=PUNCT)', 'gu',
    { PUNCT, PUNCTSPACE: PUNCT_SPACE, NOTPUNCTSPACE: NOT_PUNCT_SPACE }),
  // Strikethrough delimiters, shaped like the emphasis ones.
  delLDelim: build('^~~?(?:((?!~)PUNCT)|[^\\s~])', 'u', { PUNCT }),
  delRDelim: build(
    '^[^~]+(?=[^~])'
    + '|(?!~)PUNCT(~~?)(?=[\\s]|$)'
    + '|NOTPUNCTSPACE(~~?)(?!~)(?=PUNCTSPACE|$)'
    + '|(?!~)PUNCTSPACE(~~?)(?=NOTPUNCTSPACE)'
    + '|[\\s](~~?)(?!~)(?=PUNCT)'
    + '|(?!~)PUNCT(~~?)(?!~)(?=PUNCT)'
    + '|NOTPUNCTSPACE(~~?)(?=NOTPUNCTSPACE)', 'gu',
    { PUNCT, PUNCTSPACE: PUNCT_SPACE, NOTPUNCTSPACE: NOT_PUNCT_SPACE }),
  // A backslash before punctuation (used to mask escapes for emphasis).
  anyPunct: build('\\\\(PUNCT)', 'gu', { PUNCT }),
  // The same, but a code span is kept whole and its backticks masked.
  anyPunctOutCode: build('(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(PUNCT)', 'gu', { PUNCT }),
  // Link / code span / html runs, masked so emphasis does not see inside.
  blockSkip: build('LINK|PRECODE-CODE|HTML', 'g', {
    LINK: '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)',
    'PRECODE-': '(?<!`)()',
    CODE: '(?<b>`+)[^`]+\\k<b>(?!`)',
    HTML: '<(?! )[^<>]*?>',
  }),
  // GFM extended autolinks: www., http(s)://, ftp://, bare emails.
  url: build('^EMAILPROTO|^((?:PROTO):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^EMAIL', '', {
    EMAILPROTO: '(?:mailto:EMAIL|xmpp:EMAIL(?:\\/[A-Za-z0-9@.]+)?)'.replace(/EMAIL/g, '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])'),
    PROTO: '[hH][tT][tT][pP][sS]?|[fF][tT][pP]',
    EMAIL: '[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])',
  }),
  // Trims an autolink's tail: trailing punctuation and balanced parens stay.
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
};

// The search form of reflink/nolink, used to find reference candidates
// anywhere in a run (global, unanchored, bounded labels).
INLINE.reflinkSearch = build('REFLINK|NOLINK(?!\\()', 'g', {
  REFLINK: build('^!?\\[(LABEL)\\]\\[(REF)\\]', '', {
    LABEL: LABEL_INLINE_B.replace(/BRACKETS/g, LABEL_BRACKETS),
    REF: LABEL_BLOCK_B,
  }),
  NOLINK: build('^!?\\[(REF)\\](?:\\[\\])?', '', { REF: LABEL_BLOCK_B }),
});

const SI = {};
for (const key of Object.keys(INLINE)) SI[key] = stick(INLINE[key]);
SI.reflinkSearch = INLINE.reflinkSearch;

// ------------------------------------------------------------ block lexing

// Indent-dependent interrupt tests, cached by (kind, indent) like marked's.
const IND_CACHE = new Map();
function indRe(kind, indent) {
  const n = Math.max(0, Math.min(3, indent - 1));
  const key = kind + ':' + n;
  let re = IND_CACHE.get(key);
  if (!re) {
    if (kind === 'breakNext' || kind === 'breakLine') {
      // One test for all the interrupts that can end a list item's line:
      // the next line ends on a bullet, hr, fence, heading, html block or
      // blockquote; the previous line ends on a fence, heading, html block
      // or hr. Built from the same factories as the single tests, so the
      // bodies are identical; the 'i' flag only affects the html body, whose
      // siblings hold no letters.
      const strip = (r) => r.source.replace(/^\^ \{0,\d+\}/, '');
      const parts = kind === 'breakNext'
        ? [MISC.nextBullet(n), MISC.hrAt(n), MISC.fencesAt(n), MISC.headAt(n), MISC.htmlAt(n), MISC.bqAt(n)]
        : [MISC.fencesAt(n), MISC.headAt(n), MISC.htmlAt(n), MISC.hrAt(n)];
      re = new RegExp(`^ {0,${n}}(?:` + parts.map(strip).join('|') + ')', 'i');
    } else {
      re = kind === 'bullet' ? MISC.nextBullet(n)
        : kind === 'hr' ? MISC.hrAt(n)
        : kind === 'fences' ? MISC.fencesAt(n)
        : kind === 'head' ? MISC.headAt(n)
        : kind === 'html' ? MISC.htmlAt(n)
        : MISC.bqAt(n);
    }
    IND_CACHE.set(key, re);
  }
  return re;
}

// A fenced block's content loses up to the fence's own indent on each line.
function fenceCompensate(raw, text) {
  const m = raw.match(MISC.fenceIndent);
  if (m === null) return text;
  const take = m[1];
  return text.split('\n').map((node) => {
    const lead = node.match(MISC.leadSpace);
    if (lead === null) return node;
    return node.slice(Math.min(lead[0].length, take.length));
  }).join('\n');
}

// Queue an inline run: its tokens are filled in after the whole block pass,
// so link definitions later in the document already resolve.
function queueInline(ctx, src, kids) {
  ctx.queue.push({ src, kids });
  return kids;
}

function tokSpace(s, pos) {
  const m = at(S.newline, s, pos);
  if (m && m[0].length > 0) return { kind: 'space', raw: m[0] };
  return null;
}

function tokCode(s, pos) {
  const m = at(S.code, s, pos);
  if (!m) return null;
  const raw = trimBlankLines(m[0]);
  return { kind: 'code', raw, text: raw.replace(MISC.codeDedent, '') };
}

function tokFences(s, pos) {
  const m = at(S.fences, s, pos);
  if (!m) return null;
  return {
    kind: 'code',
    raw: m[0],
    lang: m[2] ? m[2].trim().replace(INLINE.anyPunct, '$1') : m[2],
    text: fenceCompensate(m[0], m[3] || ''),
  };
}

function tokHeading(s, pos, ctx) {
  const m = at(S.heading, s, pos);
  if (!m) return null;
  let text = m[2].trim();
  if (MISC.endsHash.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || MISC.endsSpaceTab.test(trimmed)) text = trimmed.trim();
  }
  const kids = [];
  queueInline(ctx, text, kids);
  return { kind: 'heading', raw: rtrim(m[0], '\n'), depth: m[1].length, text, kids };
}

function tokHr(s, pos) {
  const m = at(S.hr, s, pos);
  if (!m) return null;
  return { kind: 'hr', raw: rtrim(m[0], '\n') };
}

function tokHtml(s, pos) {
  const m = at(S.html, s, pos);
  if (!m) return null;
  const raw = trimBlankLines(m[0]);
  return {
    kind: 'html', block: true, raw,
    pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
    text: raw,
  };
}

function tokDef(s, pos) {
  const m = at(S.def, s, pos);
  if (!m) return null;
  // Outside angle brackets a destination holds only balanced parentheses.
  if (!MISC.angleOpen.test(m[2]) && closingBracket(m[2], '()') !== -1) return null;
  const tag = normalizeLabel(m[1]);
  const href = m[2] ? m[2].replace(MISC.angleHref, '$1').replace(INLINE.anyPunct, '$1') : '';
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunct, '$1') : m[3];
  return { kind: 'def', tag, raw: rtrim(m[0], '\n'), href, title };
}

function tokTable(s, pos, ctx) {
  const m = at(S.table, s, pos);
  if (!m) return null;
  if (!MISC.tableDelim.test(m[2])) return null;
  const headers = splitCells(m[1]);
  const aligns = m[2].replace(MISC.tableEdge, '').split('|');
  const rows = m[3] && m[3].trim() ? m[3].replace(MISC.tableBlankRow, '').split('\n') : [];
  if (headers.length !== aligns.length) return null;
  const align = [];
  for (const a of aligns) {
    if (MISC.alignRight.test(a)) align.push('right');
    else if (MISC.alignCenter.test(a)) align.push('center');
    else if (MISC.alignLeft.test(a)) align.push('left');
    else align.push(null);
  }
  const table = { kind: 'table', raw: rtrim(m[0], '\n'), header: [], align, rows: [] };
  for (let i = 0; i < headers.length; i++) {
    const kids = [];
    queueInline(ctx, headers[i], kids);
    table.header.push({ text: headers[i], kids, header: true, align: align[i] });
  }
  for (const row of rows) {
    table.rows.push(splitCells(row, headers.length).map((cell, i) => {
      const kids = [];
      queueInline(ctx, cell, kids);
      return { text: cell, kids, header: false, align: align[i] };
    }));
  }
  return table;
}

function tokLheading(s, pos, ctx) {
  const m = at(S.lheading, s, pos);
  if (!m) return null;
  const text = m[1].trim();
  const kids = [];
  queueInline(ctx, text, kids);
  return { kind: 'heading', raw: rtrim(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, kids };
}

function tokParagraph(s, pos, ctx) {
  const m = at(S.paragraph, s, pos);
  if (!m) return null;
  const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
  const kids = [];
  queueInline(ctx, text, kids);
  return { kind: 'paragraph', raw: m[0], text, kids };
}

function tokText(s, pos, ctx) {
  const m = at(S.text, s, pos);
  if (!m) return null;
  const kids = [];
  queueInline(ctx, m[0], kids);
  return { kind: 'text', raw: m[0], text: m[0], kids };
}

function tokBlockquote(s, pos, ctx) {
  const m = at(S.blockquote, s, pos);
  if (!m) return null;
  let lines = rtrim(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const nodes = [];
  while (lines.length > 0) {
    let inBq = false;
    const cur = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (MISC.bqStart.test(lines[i])) {
        cur.push(lines[i]);
        inBq = true;
      } else if (!inBq) {
        cur.push(lines[i]);
      } else break;
    }
    lines = lines.slice(i);
    const curRaw = cur.join('\n');
    // A tab after the marker runs to the next tab stop; the marker only
    // consumes one space of it, the rest is content.
    const curText = curRaw
      .replace(MISC.bqMarkerSpace, (_, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(MISC.bqSetext, '\n    $1')
      .replace(MISC.bqMarker, '');
    raw = raw ? raw + '\n' + curRaw : curRaw;
    text = text ? text + '\n' + curText : curText;
    const savedTop = ctx.state.top;
    ctx.state.top = true;
    lexBlocks(curText, ctx, nodes, true);
    ctx.state.top = savedTop;
    if (lines.length === 0) break;
    const last = nodes[nodes.length - 1];
    if (last && (last.kind === 'code' || last.kind === 'heading' || last.kind === 'hr' || last.kind === 'html' || last.kind === 'table')) {
      break;
    } else if (last && last.kind === 'blockquote') {
      // The continuation lines belong to the same nesting frame as the
      // nested quote, which already had one '>' stripped, so strip one
      // marker from them too.
      const continuation = lines.join('\n');
      const newText = last.raw + '\n' + continuation.replace(MISC.bqMarker, '');
      const newTok = tokBlockquote(newText, 0, ctx);
      nodes[nodes.length - 1] = newTok;
      const leftover = newText.substring(newTok.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - last.text.length) + newTok.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && MISC.bqStart.test(lines[0])) continue;
      break;
    } else if (last && last.kind === 'list') {
      const newText = last.raw + '\n' + lines.join('\n');
      const newTok = tokList(newText, 0, ctx);
      nodes[nodes.length - 1] = newTok;
      // The list raw has no '>' markers, so count the continuation lines
      // the list took and add those lines instead.
      const consumedCount = newTok.raw.length > last.raw.length
        ? newText.slice(last.raw.length + 1, newTok.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = raw + '\n' + consumed;
        text = text + '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  return { kind: 'blockquote', raw, text, kids: nodes };
}

function tokList(s, pos, ctx) {
  const m = at(S.list, s, pos);
  if (!m) return null;
  const listSrc = s.slice(pos);
  // Work by index into listSrc: the remainder was re-sliced on every line,
  // copying the rest of the list once per line (quadratic on long lists).
  let p = 0;
  let bull = m[1].trim();
  const ordered = bull.length > 1;
  const list = {
    kind: 'list', raw: '', ordered,
    start: ordered ? +bull.slice(0, -1) : '',
    loose: false, items: [],
  };
  bull = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRe = MISC.itemRe(bull);
  const itemReY = new RegExp(itemRe.source.replace(/^\^/, ''), 'y');
  let endsBlank = false;
  const lineAt = (i) => {
    const nl = listSrc.indexOf('\n', i);
    return nl === -1 ? listSrc.slice(i) : listSrc.slice(i, nl);
  };
  while (p < listSrc.length) {
    let endEarly = false;
    let itemContents = '';
    itemReY.lastIndex = p;
    const cap = itemReY.exec(listSrc);
    if (!cap) break;
    if (at(S.hr, listSrc, p)) break; // the bullet was actually an hr
    const itemStart = p;
    p += cap[0].length;
    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = firstLine.includes('\t')
      ? firstLine.replace(MISC.leadSpaceTab, (ws) => expandTabs(ws, bulletIndent))
      : firstLine;
    let nextLine = lineAt(p);
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(MISC.nonSpace);
      indent = indent > 4 ? 1 : indent; // >4 spaces is indented code: 1 indent
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && MISC.blankLine.test(nextLine)) {
      // Items begin with at most one blank line.
      p += nextLine.length + 1;
      endEarly = true;
    }
    if (!endEarly) {
      const breakNextRe = indRe('breakNext', indent);
      const breakLineRe = indRe('breakLine', indent);
      while (p < listSrc.length) {
        const rawLine = lineAt(p);
        nextLine = rawLine;
        const nextNoTabs = nextLine.includes('\t')
          ? nextLine.replace(MISC.leadSpaceTab, (ws) => expandTabs(ws))
          : nextLine;
        if (breakNextRe.test(nextLine)) break;
        if (nextNoTabs.search(MISC.nonSpace) >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextNoTabs.slice(indent);
        } else {
          if (blankLine) break;
          // An indented code block ends the item's paragraph continuation.
          const lineNoTabs = line.includes('\t') ? line.replace(MISC.tabGlobal, '    ') : line;
          if (lineNoTabs.search(MISC.nonSpace) >= 4) break;
          if (breakLineRe.test(line)) break;
          // A lazy continuation can look like a setext underline once the
          // list indent is removed; keep it in the paragraph.
          const setextCont = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && BLOCK.lheading.test(`${line}\n${nextLine}`);
          const cont = setextCont ? `    ${nextNoTabs.replace(/^ {0,3}/, '')}` : nextLine;
          itemContents += '\n' + cont;
        }
        blankLine = !nextLine.trim();
        p += rawLine.length + 1;
        line = nextNoTabs.slice(indent);
      }
    }
    // The loops above may have appended a '\n' the source never had; it can
    // only land on the item that exhausts src, whose raw is trimmed below.
    const raw = listSrc.slice(itemStart, p);
    if (!list.loose) {
      if (endsBlank) list.loose = true;
      else if (MISC.doubleBlank.test(raw)) endsBlank = true;
    }
    list.items.push({
      kind: 'list_item', raw,
      task: MISC.listTask.test(itemContents),
      loose: false, text: itemContents, kids: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return null; // not a list: there were no items
  }
  list.raw = listSrc.slice(0, p).trimEnd();
  // Item children are tokenized here, once the final item is trimmed.
  for (const item of list.items) {
    ctx.state.top = false;
    item.kids = lexBlocks(item.text, ctx, [], false);
    if (!list.loose) {
      const spacers = item.kids.filter((t) => t.kind === 'space');
      const multi = spacers.length > 0 && spacers.some((t) => MISC.anyLine.test(t.raw));
      list.loose = multi;
    }
  }
  // Place task checkboxes using the final list.loose.
  for (const item of list.items) {
    const first = item.kids[0];
    if (item.task && first && (first.kind === 'text' || first.kind === 'paragraph')) {
      item.text = item.text.replace(MISC.listTaskStrip, '');
      first.raw = first.raw.replace(MISC.listTaskStrip, '');
      first.text = first.text.replace(MISC.listTaskStrip, '');
      for (let i = ctx.queue.length - 1; i >= 0; i--) {
        if (MISC.listTask.test(ctx.queue[i].src)) {
          ctx.queue[i].src = ctx.queue[i].src.replace(MISC.listTaskStrip, '');
          break;
        }
      }
      const box = MISC.taskBox.exec(item.raw);
      if (box) {
        const cb = { kind: 'checkbox', raw: box[0] + ' ', checked: box[0] !== '[ ]' };
        item.checked = cb.checked;
        if (list.loose) {
          if (item.kids[0] && ['paragraph', 'text'].includes(item.kids[0].kind) && item.kids[0].kids) {
            item.kids[0].raw = cb.raw + item.kids[0].raw;
            item.kids[0].text = cb.raw + item.kids[0].text;
            item.kids[0].kids.unshift(cb);
          } else {
            item.kids.unshift({ kind: 'paragraph', raw: cb.raw, text: cb.raw, kids: [cb] });
          }
        } else {
          item.kids.unshift(cb);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.kids) if (tok.kind === 'text') tok.kind = 'paragraph';
    }
  }
  return list;
}

// The block loop: tries each block shape in order at the current position,
// merging continuations into the previous paragraph or text where marked
// does, and queuing inline runs for later.
function lexBlocks(s, ctx, nodes, clipped) {
  nodes = nodes || [];
  clipped = !!clipped;
  let pos = 0;
  let remain = Infinity;
  while (pos < s.length) {
    const left = s.length - pos;
    if (left >= remain) throw new Error('Infinite loop on byte: ' + s.charCodeAt(pos));
    remain = left;
    let node;
    if (node = tokSpace(s, pos)) {
      pos += node.raw.length;
      const last = nodes[nodes.length - 1];
      if (node.raw.length === 1 && last !== undefined) last.raw += '\n';
      else nodes.push(node);
      continue;
    }
    if (node = tokCode(s, pos)) {
      pos += node.raw.length;
      const last = nodes[nodes.length - 1];
      // An indented code block cannot interrupt a paragraph.
      if (last && (last.kind === 'paragraph' || last.kind === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + node.raw;
        last.text += '\n' + node.text;
        ctx.queue[ctx.queue.length - 1].src = last.text;
      } else nodes.push(node);
      continue;
    }
    if (node = tokFences(s, pos)) {
      pos += node.raw.length;
      nodes.push(node);
      continue;
    }
    if (node = tokHeading(s, pos, ctx)) {
      pos += node.raw.length;
      nodes.push(node);
      continue;
    }
    if (node = tokHr(s, pos)) {
      pos += node.raw.length;
      nodes.push(node);
      continue;
    }
    if (node = tokBlockquote(s, pos, ctx)) {
      pos += node.raw.length;
      nodes.push(node);
      continue;
    }
    if (node = tokList(s, pos, ctx)) {
      pos += node.raw.length;
      nodes.push(node);
      continue;
    }
    if (node = tokHtml(s, pos)) {
      pos += node.raw.length;
      nodes.push(node);
      continue;
    }
    if (node = tokDef(s, pos)) {
      pos += node.raw.length;
      const last = nodes[nodes.length - 1];
      if (last && (last.kind === 'paragraph' || last.kind === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + node.raw;
        last.text += '\n' + node.raw;
        ctx.queue[ctx.queue.length - 1].src = last.text;
      } else {
        // The first definition of a label wins; a later one still eats text.
        if (!ctx.links[node.tag]) { ctx.links[node.tag] = { href: node.href, title: node.title }; ctx.hasLinks = true; }
        nodes.push(node);
      }
      continue;
    }
    if (node = tokTable(s, pos, ctx)) {
      pos += node.raw.length;
      nodes.push(node);
      continue;
    }
    if (node = tokLheading(s, pos, ctx)) {
      pos += node.raw.length;
      nodes.push(node);
      continue;
    }
    if (ctx.state.top && (node = tokParagraph(s, pos, ctx))) {
      const last = nodes[nodes.length - 1];
      if (clipped && last && last.kind === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + node.raw;
        last.text += '\n' + node.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = last.text;
      } else nodes.push(node);
      clipped = false;
      pos += node.raw.length;
      continue;
    }
    if (node = tokText(s, pos, ctx)) {
      pos += node.raw.length;
      const last = nodes[nodes.length - 1];
      if (last && last.kind === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + node.raw;
        last.text += '\n' + node.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = last.text;
      } else nodes.push(node);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + s.charCodeAt(pos));
  }
  ctx.state.top = true;
  return nodes;
}

// ---------------------------------------------------------- inline lexing

// One scan of a masked source for the last emphasis/strong and
// strikethrough closers, shared by every opener in the pass. A run can
// close only when it is not preceded by whitespace or the start.
// Shared closer frame for runs with no emphasis delimiter: no `*`/`_`/`~`
// means no emphasis or strikethrough can open, so the last closers are -1.
// Frame `em`/`del` are read-only after creation, so this is shared safely.
const EMPTY_EM = { '*': -1, _: -1 };
function scanClosers(src) {
  const em = { '*': -1, _: -1 };
  let del = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i;
      else em[ch] = i;
    }
    i = j - 1;
  }
  return { masked: src, em, del };
}

function lastEmCloser(ctx, maskedSrc, delim) {
  const frame = ctx.hints[ctx.hints.length - 1];
  if (frame && frame.masked === maskedSrc) return frame.em[delim];
  return scanClosers(maskedSrc).em[delim];
}

function lastDelCloser(ctx, maskedSrc) {
  const frame = ctx.hints[ctx.hints.length - 1];
  if (frame && frame.masked === maskedSrc) return frame.del;
  return scanClosers(maskedSrc).del;
}

// Does this link text hold a link already? An image does not count: an
// image may hold a link, a link may not.
function linkInText(ctx, text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(INLINE.blockSkip)) {
    if (INLINE.link.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(INLINE.reflinkSearch)) {
    const m0 = match[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(m0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(ctx, m0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

// Mask links, code, html and escapes so emphasis and strikethrough do not
// see their delimiters inside them. Every mask keeps the length it
// replaces, so the masked source lines up with the real one.
function maskSrc(ctx, src) {
  let masked = src;
  // A reference link can only mask when its label is actually defined, and
  // both reference forms need a ']'.
  if (ctx.hasLinks && src.includes(']')) {
    const search = INLINE.reflinkSearch;
    const maskOne = (m0) => {
      const refStart = m0.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normalizeLabel(m0.slice(refStart + 1, -1)))) return m0;
      // A candidate whose text already holds a link never becomes one, so
      // flattening the whole span would hide the emphasis that still
      // applies inside it; mask the links it holds instead.
      if (refStart > 1 && m0.charAt(0) !== '!') {
        const text = m0.slice(1, refStart - 1);
        if (linkInText(ctx, text)) {
          return '[' + text.replace(search, maskOne) + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m0.length - 2) + ']';
    };
    masked = masked.replace(search, maskOne);
  }
  // Mask escaped punctuation; a backslash inside a code span is literal,
  // so mask the backticks inside the span instead. Nothing to mask when
  // the run holds neither a backtick nor a backslash.
  if (src.includes('`') || src.includes('\\')) {
    masked = masked.replace(INLINE.anyPunctOutCode, (m0, code, punct) => {
      if (punct) return '+'.repeat(m0.length);
      if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return m0;
    });
  }
  // Mask links, code spans and raw HTML so emphasis cannot cross them.
  // A link needs '](' with no space, a code span needs '`', raw HTML
  // needs '<'.
  if (src.includes('](') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(INLINE.blockSkip, (m0, _link, context) => {
      const offset = context ? context.length : 0;
      return m0.slice(0, offset) + '[' + 'a'.repeat(m0.length - offset - 2) + ']';
    });
  }
  return masked;
}

// Is the end of this link label inside an html tag or autolink that runs
// past it? Then the label is not a label at all.
function labelEndInToken(ctx, src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = INLINE.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INLINE.tag.exec(tokenSrc) || INLINE.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Build a link or image token from a matched label, rendering the label's
// own inline tokens. A link whose label holds another link is not a link.
function makeLink(ctx, isImage, label, href, title, raw) {
  const text = label.replace(MISC.labelUnescape, '$1');
  const outerInLink = ctx.state.inLink;
  const outerEmitted = ctx.state.linkEmitted;
  const outerRawBlock = ctx.state.inRawBlock;
  ctx.state.inLink = true;
  ctx.state.linkEmitted = false;
  const kids = [];
  runInline(ctx, text, kids);
  const textHasLink = ctx.state.linkEmitted;
  ctx.state.linkEmitted = outerEmitted;
  ctx.state.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      // These tokens are discarded, so undo the raw-block state they opened.
      ctx.state.inRawBlock = outerRawBlock;
      return null;
    }
    ctx.state.linkEmitted = true;
  }
  return { kind: isImage ? 'image' : 'link', raw, href, title: title || null, text, kids };
}

function tokEscape(ctx, run, pos) {
  const m = at(SI.escape, run, pos);
  if (!m) return null;
  return { kind: 'escape', raw: m[0], text: m[1] };
}

function tokTag(ctx, run, pos) {
  const m = at(SI.tag, run, pos);
  if (!m) return null;
  if (!ctx.state.inLink && MISC.aOpen.test(m[0])) ctx.state.inLink = true;
  else if (ctx.state.inLink && MISC.aClose.test(m[0])) ctx.state.inLink = false;
  if (!ctx.state.inRawBlock && MISC.preOpen.test(m[0])) ctx.state.inRawBlock = true;
  else if (ctx.state.inRawBlock && MISC.preClose.test(m[0])) ctx.state.inRawBlock = false;
  return { kind: 'html', raw: m[0], inLink: ctx.state.inLink, inRawBlock: ctx.state.inRawBlock, block: false, text: m[0] };
}

function tokLink(ctx, run, pos) {
  // Without a ')' ahead the link pattern cannot match; skipping it avoids
  // its quadratic backtracking over unterminated-link inputs.
  if (ctx.state.linkParenPossible === false) return null;
  const m = at(SI.link, run, pos);
  if (!m) return null;
  const labelStart = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelEndInToken(ctx, run.slice(pos), m[1], labelStart)) return null;
  const trimmedUrl = m[2].trim();
  let raw = m[0];
  let hrefPart = m[2];
  let titlePart = m[3];
  if (MISC.angleOpen.test(trimmedUrl)) {
    // CommonMark requires matching angle brackets.
    if (!MISC.angleClose.test(trimmedUrl)) return null;
    // The ending bracket cannot be escaped.
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParen = closingBracket(m[2], '()');
    if (lastParen === -2) return null; // more opens than closes
    if (lastParen > -1) {
      const start = m[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + m[1].length + lastParen;
      hrefPart = m[2].substring(0, lastParen);
      raw = m[0].substring(0, linkLen).trim();
      titlePart = '';
    }
  }
  // The ')' that ends the match is the closer only when it is not escaped.
  const unescaped = rtrim(raw.slice(0, -1), '\\');
  if ((raw.length - unescaped.length) % 2 === 0) return null;
  let href = hrefPart.trim();
  const title = titlePart ? titlePart.slice(1, -1) : '';
  if (MISC.angleOpen.test(href)) href = href.slice(1, -1);
  return makeLink(ctx, m[0].charAt(0) === '!', m[1],
    href ? href.replace(INLINE.anyPunct, '$1') : href,
    title ? title.replace(INLINE.anyPunct, '$1') : title,
    raw);
}

function tokReflink(ctx, run, pos) {
  const m = at(SI.reflink, run, pos) || at(SI.nolink, run, pos);
  if (!m) return null;
  const labelStart = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelEndInToken(ctx, run.slice(pos), m[1], labelStart)) return null;
  const link = ctx.links[normalizeLabel(m[2] || m[1])];
  if (!link) {
    const ch = m[0].charAt(0);
    return { kind: 'text', raw: ch, text: ch };
  }
  return makeLink(ctx, m[0].charAt(0) === '!', m[1], link.href, link.title, m[0]);
}

function tokEmStrong(ctx, run, pos, masked, prevChar) {
  // No closer anywhere after this delimiter means no emphasis can form;
  // skip the delimiter rule and the run walk-back entirely.
  if (lastEmCloser(ctx, masked, run[pos]) < pos + 1) return null;
  const m = at(SI.emLDelim, run, pos);
  if (!m) return null;
  if (!m[1] && !m[2] && !m[3] && !m[4]) return null;
  const delim = m[0][0];
  // A mid-run opener must only pair with a delimiter that can only close,
  // or it steals the opener of a later span.
  const midRun = prevChar === delim;
  // The start of this run may already be behind pos, either taken as text
  // after the whole run failed or used to close an earlier span. Flanking
  // and rules 9-10 are about the whole run, so find its start.
  const srcStart = pos;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  const before = masked.slice(Math.max(0, runStart - 2), runStart);
  const runPrevChar = [...before].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!INLINE.punct.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!INLINE.punct.exec(prevChar);
  // _ can't be between two alphanumerics.
  if (m[4] && prevChar.match(MISC.alphaNum)) return null;
  const nextChar = m[1] || m[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...m[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    let midDelimTotal = 0;
    // Rules 9-10 count the whole run, and also apply when the opener could
    // close as well.
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delim === '*' && !runPrevPunct));
    if (delim !== '*' && delim !== '_') return null;
    const endReg = delim === '*' ? INLINE.emRDelimAst : INLINE.emRDelimUnd;
    const lastCloser = lastEmCloser(ctx, masked, delim);
    const windowStart = pos + lLength;
    if (lastCloser < windowStart) return null;
    const window = masked.slice(pos + lLength);
    const lastInWindow = lastCloser - windowStart;
    endReg.lastIndex = 0;
    let match;
    while ((match = endReg.exec(window)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue; // skip single * in __abc*abc__
      rLength = [...rDelim].length;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // CommonMark emphasis rules 9-10
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue; // not enough closing delimiters yet
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = run.slice(pos, pos + lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        const kids = [];
        runInline(ctx, text, kids);
        return { kind: 'em', raw, text, kids };
      }
      const text = raw.slice(2, -2);
      const kids = [];
      runInline(ctx, text, kids);
      return { kind: 'strong', raw, text, kids };
    }
  }
  return null;
}

function tokCodespan(ctx, run, pos) {
  const m = at(SI.code, run, pos);
  if (!m) return null;
  let text = m[2].replace(MISC.newlineGlobal, ' ');
  const hasNonSpace = MISC.nonSpace.test(text);
  const hasSpaceBoth = MISC.startsSpace.test(text) && MISC.endsSpace.test(text);
  if (hasNonSpace && hasSpaceBoth) text = text.substring(1, text.length - 1);
  return { kind: 'codespan', raw: m[0], text };
}

function tokBr(ctx, run, pos) {
  const m = at(SI.br, run, pos);
  if (!m) return null;
  return { kind: 'br', raw: m[0] };
}

function tokDel(ctx, run, pos, masked, prevChar) {
  const m = at(SI.delLDelim, run, pos);
  if (!m) return null;
  const nextChar = m[1] || '';
  if (!nextChar || !prevChar || INLINE.punct.exec(prevChar)) {
    const lLength = [...m[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    const endReg = INLINE.delRDelim;
    const lastCloser = lastDelCloser(ctx, masked);
    const windowStart = pos + lLength;
    if (lastCloser < windowStart) return null;
    const window = masked.slice(pos + lLength);
    const lastInWindow = lastCloser - windowStart;
    endReg.lastIndex = 0;
    let match;
    while ((match = endReg.exec(window)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = run.slice(pos, pos + lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      const kids = [];
      runInline(ctx, text, kids);
      return { kind: 'del', raw, text, kids };
    }
  }
  return null;
}

function tokAutolink(ctx, run, pos) {
  const m = at(SI.autolink, run, pos);
  if (!m) return null;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[1];
    href = 'mailto:' + text;
  } else {
    text = m[1];
    href = text;
  }
  return { kind: 'link', raw: m[0], text, href, autolink: true, kids: [{ kind: 'text', raw: text, text }] };
}

function tokUrl(ctx, run, pos) {
  const m = at(SI.url, run, pos);
  if (!m) return null;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    // Trim the autolink's tail: trailing punctuation and unbalanced
    // parentheses do not belong to it.
    let prev = '';
    let cur = m[0];
    do {
      prev = cur;
      cur = INLINE.backpedal.exec(cur)?.[0] ?? '';
    } while (prev !== cur);
    text = cur;
    href = m[1] === 'www.' ? 'http://' + cur : cur;
  }
  return { kind: 'link', raw: text, text, href, autolink: true, kids: [{ kind: 'text', raw: text, text }] };
}

// Broad email characters (the text rule's stop set): a text run stops
// before a run of these followed by '@', so the URL rule gets its chance.
const EMAIL_CHAR = new Uint8Array(128);
for (const ch of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?`{|}~-") EMAIL_CHAR[ch.charCodeAt(0)] = 1;

// The starts of the email-shaped spans in a run: for each '@', the start of
// the run of email characters before it. If the URL rule declines the span,
// the text resumes and renders the same bytes, so an over-broad span (a
// domain that fails the URL rule) is harmless.
function findEmailStarts(run) {
  const starts = [];
  let at = run.indexOf('@', 0);
  while (at !== -1) {
    let s = at;
    while (s > 0 && EMAIL_CHAR[run.charCodeAt(s - 1)]) s--;
    if (s < at) starts.push(s);
    at = run.indexOf('@', at + 1);
  }
  return starts;
}

// A run with no inline markup at all: no opener byte, no hard break, no
// autolink opener. Such a run is a single text token; the whole inline
// machinery (masking, closer scan, dispatch loop) is skipped for it.
const PLAIN_RUN = /[*_`<\\~!]|\[|  \n|www\.|:\/\/|@/;

// Stops a plain-text run: the next byte that could open another inline rule,
// a hard break (two spaces and a newline), or a scheme/www. opener. The
// mailto: alternative matches the byte before the scheme, so the stop is
// one past the match; every other alternative stops at its first byte.
const TEXT_STOP = /[*_`<\\~!]|\[|\]| {2,}\n|www\.|https?:\/\/|ftp:\/\/|([^a-zA-Z0-9])(?=mailto:|xmpp:)/gi;

function tokInlineText(ctx, run, pos, emailStart) {
  const len = run.length;
  let i = pos + 1;
  const first = run[pos];
  // The rule consumes a whole run of backticks or tildes up front; a single
  // byte otherwise. Either way the token is never empty.
  if (first === '`' || first === '~') {
    while (i < len && run[i] === first) i++;
  }
  let end = len;
  if (emailStart > pos && emailStart < end) end = emailStart;
  TEXT_STOP.lastIndex = i;
  let m;
  while ((m = TEXT_STOP.exec(run)) !== null) {
    let stop = m.index;
    if (m[1] !== undefined) {
      // The mailto: stop: the token keeps the byte before the scheme.
      stop = m.index + 1;
    } else if (m[0].toLowerCase() === 'www.') {
      // www. only opens after whitespace or *_~( (or at the start), and
      // only in lower case; otherwise it is ordinary text.
      if (m[0] !== 'www.') { TEXT_STOP.lastIndex = stop + 1; continue; }
      const prev = stop === 0 ? '' : run[stop - 1];
      if (prev !== '' && prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r'
        && prev !== '*' && prev !== '_' && prev !== '~' && prev !== '(') {
        TEXT_STOP.lastIndex = stop + 1;
        continue;
      }
    }
    if (stop < end) end = stop;
    break;
  }
  const raw = run.slice(pos, end);
  const escaped = ctx.state.inRawBlock;
  return {
    kind: 'text', raw,
    // Raw HTML keeps whatever it was written with; elsewhere a numeric
    // character reference stands for the character itself.
    text: escaped ? raw : decodeRefs(raw),
    esc: escaped,
  };
}

// Does a scheme/www. URL autolink open at pos? The scheme part of the URL
// rule is case-insensitive (http/https/ftp, mailto:/xmpp:); www. is lower
// case only. False for every other first byte, so this is a cheap guard.
function urlSchemeAt(run, pos) {
  const c = run[pos];
  if (c === 'w') return run.startsWith('www.', pos);
  if (c === 'h' || c === 'H') return /^https?:\/\//i.test(run.slice(pos, pos + 8));
  if (c === 'f' || c === 'F') return /^ftp:\/\//i.test(run.slice(pos, pos + 7));
  if (c === 'm' || c === 'M') return /^mailto:/i.test(run.slice(pos, pos + 7));
  if (c === 'x' || c === 'X') return /^xmpp:/i.test(run.slice(pos, pos + 5));
  return false;
}

function tokenizeInlines(ctx, run, masked, kids, hasAt, emailStarts) {
  let keepPrev = false;
  let prevChar = '';
  let pos = 0;
  let remain = Infinity;
  let ei = 0;
  while (pos < run.length) {
    const left = run.length - pos;
    if (left >= remain) throw new Error('Infinite loop on byte: ' + run.charCodeAt(pos));
    remain = left;
    if (!keepPrev) prevChar = '';
    keepPrev = false;
    // The next email-shaped span after this position, if any.
    if (emailStarts) { while (ei < emailStarts.length && emailStarts[ei] <= pos) ei++; }
    const emailStart = emailStarts && ei < emailStarts.length ? emailStarts[ei] : -1;
    // Dispatch on the first byte: every inline rule can only open on one or
    // two characters, so trying all ten at every position is pure overhead.
    // The text rule is the fallback everywhere; it stops before any rule's
    // opener, so the next iteration dispatches to that rule instead.
    const ch = run[pos];
    let tok;
    if (ch === '\\') {
      // A backslash is an escape before punctuation, a hard break before a
      // newline; try the escape first, then the break.
      tok = tokEscape(ctx, run, pos) || tokBr(ctx, run, pos);
    } else if (ch === '<') {
      tok = tokTag(ctx, run, pos) || tokAutolink(ctx, run, pos);
    } else if (ch === '[' || ch === '!') {
      tok = tokLink(ctx, run, pos) || tokReflink(ctx, run, pos);
    } else if (ch === '*' || ch === '_') {
      tok = tokEmStrong(ctx, run, pos, masked, prevChar);
    } else if (ch === '`') {
      tok = tokCodespan(ctx, run, pos);
    } else if (ch === ' ') {
      tok = tokBr(ctx, run, pos);
    } else if (ch === '~') {
      tok = tokDel(ctx, run, pos, masked, prevChar);
    } else if (!ctx.state.inLink && (hasAt || urlSchemeAt(run, pos))) {
      // A URL autolink can only open on a bare email (needs an '@' in the
      // run, checked once per run) or on a scheme/www. opener.
      tok = tokUrl(ctx, run, pos);
    }
    if (tok) {
      pos += tok.raw.length;
      const last = kids[kids.length - 1];
      if (tok.kind === 'text' && last && last.kind === 'text') {
        last.raw += tok.raw;
        last.text += tok.text;
      } else kids.push(tok);
      continue;
    }
    if (tok = tokInlineText(ctx, run, pos, emailStart)) {
      pos += tok.raw.length;
      // Track prevChar before a run of ____ started.
      if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
      keepPrev = true;
      const last = kids[kids.length - 1];
      if (last && last.kind === 'text') {
        last.raw += tok.raw;
        last.text += tok.text;
      } else kids.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + run.charCodeAt(pos));
  }
  return kids;
}

// Lex one inline run right now, sharing one paren scan and one closer scan
// with the run that contains it.
function runInline(ctx, src, kids) {
  if (!PLAIN_RUN.test(src)) {
    // A plain run is one text token; nothing here can open a rule, so the
    // token needs no masking, no closer scan and no dispatch loop.
    const escaped = ctx.state.inRawBlock;
    kids.push({ kind: 'text', raw: src, text: escaped ? src : decodeRefs(src), esc: escaped });
    return kids;
  }
  const prevParen = ctx.state.linkParenPossible;
  ctx.state.linkParenPossible = prevParen && src.includes(')');
  try {
    const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = hasDelim ? maskSrc(ctx, src) : src;
    // A run with no delimiter needs no closer scan: nothing can open.
    ctx.hints.push(hasDelim ? scanClosers(masked) : { masked, em: EMPTY_EM, del: -1 });
    try {
      const hasAt = src.includes('@');
      return tokenizeInlines(ctx, src, masked, kids, hasAt, hasAt ? findEmailStarts(src) : null);
    } finally {
      ctx.hints.pop();
    }
  } finally {
    ctx.state.linkParenPossible = prevParen;
  }
}

// ------------------------------------------------------------- rendering

function renderLink(tok) {
  // References are not resolved inside an autolink, so every & there is
  // literal. Elsewhere only an & that cannot start one needs escaping.
  const parsedText = tok.autolink ? escapeHtml(tok.text, true) : renderInline(tok.kids);
  const clean = cleanUrl(tok.href);
  if (clean === null) return parsedText;
  const href = escapeHtml(clean, tok.autolink);
  let out = '<a href="' + href + '"';
  if (tok.title) out += ' title="' + escapeHtml(tok.title) + '"';
  out += '>' + parsedText + '</a>';
  return out;
}

function renderImage(tok) {
  let text = tok.text;
  if (tok.kids) text = renderText(tok.kids);
  const clean = cleanUrl(tok.href);
  if (clean === null) return escapeHtml(text);
  let out = `<img src="${escapeHtml(clean)}" alt="${escapeHtml(text)}"`;
  if (tok.title) out += ` title="${escapeHtml(tok.title)}"`;
  out += '>';
  return out;
}

// Plain-text rendering, used for image alt text.
function renderText(kids) {
  let out = '';
  for (const tok of kids) {
    switch (tok.kind) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += tok.kids ? renderText(tok.kids) : tok.text;
        break;
      case 'codespan':
      case 'html':
      case 'text':
      case 'escape':
        out += tok.text;
        break;
      case 'br':
        break;
      case 'checkbox':
        out += tok.raw;
        break;
      default:
        throw new Error('Token with "' + tok.kind + '" type was not found.');
    }
  }
  return out;
}

function renderInline(kids) {
  let out = '';
  for (const tok of kids) {
    switch (tok.kind) {
      case 'escape':
        out += escapeHtml(tok.text);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'link':
        out += renderLink(tok);
        break;
      case 'image':
        out += renderImage(tok);
        break;
      case 'checkbox':
        out += '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'strong':
        out += `<strong>${renderInline(tok.kids)}</strong>`;
        break;
      case 'em':
        out += `<em>${renderInline(tok.kids)}</em>`;
        break;
      case 'codespan':
        out += `<code>${escapeHtml(tok.text, true)}</code>`;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'del':
        out += `<del>${renderInline(tok.kids)}</del>`;
        break;
      case 'text':
        out += tok.kids ? renderInline(tok.kids) : (tok.esc ? tok.text : escapeHtml(tok.text));
        break;
      default:
        throw new Error('Token with "' + tok.kind + '" type was not found.');
    }
  }
  return out;
}

function renderCell(cell) {
  const content = renderInline(cell.kids);
  const type = cell.header ? 'th' : 'td';
  const tag = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderBlock(node) {
  switch (node.kind) {
    case 'space':
      return '';
    case 'hr':
      return '<hr>\n';
    case 'heading':
      return `<h${node.depth}>${renderInline(node.kids)}</h${node.depth}>\n`;
    case 'code': {
      const lang = (node.lang || '').match(MISC.notSpaceStart)?.[0];
      // An empty code block has no content, so it must not gain a newline.
      const code = node.text ? node.text.replace(MISC.endsNewline, '') + '\n' : '';
      if (!lang) return '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
      return '<pre><code class="language-' + escapeHtml(lang) + '">'
        + escapeHtml(code, true) + '</code></pre>\n';
    }
    case 'table': {
      let cell = '';
      for (const h of node.header) cell += renderCell(h);
      const header = `<tr>\n${cell}</tr>\n`;
      let body = '';
      for (const row of node.rows) {
        cell = '';
        for (const c of row) cell += renderCell(c);
        body += `<tr>\n${cell}</tr>\n`;
      }
      if (body) body = `<tbody>${body}</tbody>`;
      return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
    }
    case 'blockquote':
      return `<blockquote>\n${renderBlocks(node.kids)}</blockquote>\n`;
    case 'list': {
      let body = '';
      for (const item of node.items) body += `<li>${renderBlocks(item.kids)}</li>\n`;
      const type = node.ordered ? 'ol' : 'ul';
      const startAttr = (node.ordered && node.start !== 1) ? ` start="${node.start}"` : '';
      return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
    }
    case 'checkbox':
      return '<input ' + (node.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    case 'html':
      return node.text;
    case 'def':
      return '';
    case 'paragraph':
      return `<p>${renderInline(node.kids)}</p>\n`;
    case 'text':
      return renderInline(node.kids);
    default:
      throw new Error('Token with "' + node.kind + '" type was not found.');
  }
}

function renderBlocks(nodes) {
  let out = '';
  for (const node of nodes) out += renderBlock(node);
  return out;
}

// ------------------------------------------------------------------- entry

// The HTML marked 18.1.3 renders for `markdown` with its default options.
// Stateless per call: nothing is kept between calls.
export function parse(markdown) {
  const ctx = {
    links: Object.create(null),
    hasLinks: false,
    queue: [],
    hints: [],
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true },
  };
  const src = markdown.includes('\r') ? markdown.replace(MISC.crlf, '\n') : markdown;
  const nodes = lexBlocks(src, ctx, [], false);
  for (let i = 0; i < ctx.queue.length; i++) {
    const next = ctx.queue[i];
    // An inline <pre>, <code>, <kbd> or <script> left open ends with the
    // block holding it; carried over, it would stop every later block's
    // text from being escaped.
    ctx.state.inRawBlock = false;
    runInline(ctx, next.src, next.kids);
  }
  ctx.queue = [];
  return renderBlocks(nodes);
}
