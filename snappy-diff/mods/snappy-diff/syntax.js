// A small syntax highlighter: comments, strings, numbers, keywords, types and calls for the
// common languages. Herdr exposes no tokenizer, and a diff shows fragments of files anyway.
// Pure: no Herdr imports, tested with node.

const words = (text) => new Set(text.split(/\s+/).filter(Boolean));

const C_LIKE = words(`
  abstract as async await break case catch class const continue crate debugger default defer delete do dyn
  else enum export extends extern final finally fn for from func function go goto if impl implements import in
  instanceof interface keyof let loop match mod move mut namespace new of override package private protected
  pub public readonly ref return satisfies select static struct super switch this throw throws trait try type
  typeof unsafe use var void where while with yield fun val when object chan map range fallthrough declare
  int long short char float double boolean byte unsigned signed sizeof typedef union bool string i8 i16 i32 i64
  u8 u16 u32 u64 usize isize f32 f64 str`);
const PYTHON = words(`
  and as assert async await break class continue def del elif else except finally for from global if import
  in is lambda nonlocal not or pass raise return try while with yield match case self`);
const SHELL = words(`if then else elif fi for in do done case esac while until function return export local readonly set unset source`);
const RUBY = words(`alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require`);
const SQL = words(`
  select from where and or not insert into update delete create table alter drop join left right inner outer
  on as group by order having limit offset values set is in like distinct union all primary key foreign
  references index view begin commit rollback case when then else end returning with`);
const CONSTANTS = words(`true false null undefined None True False nil NaN Infinity NULL`);

const C = { line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'"], keywords: C_LIKE };
const LANGUAGES = {
  js: { ...C, quotes: ['"', "'", "`"], multiline: ["`"] },
  rust: { ...C, quotes: ['"'] },
  go: { ...C, quotes: ['"', "'", "`"], multiline: ["`"] },
  c: C,
  python: { line: ["#"], block: [], quotes: ['"""', "'''", '"', "'"], multiline: ['"""', "'''"], keywords: PYTHON },
  shell: { line: ["#"], block: [], quotes: ['"', "'"], keywords: SHELL },
  ruby: { line: ["#"], block: [], quotes: ['"', "'"], keywords: RUBY },
  yaml: { line: ["#"], block: [], quotes: ['"', "'"], keywords: new Set(), keys: true },
  toml: { line: ["#"], block: [], quotes: ['"""', '"', "'"], multiline: ['"""'], keywords: new Set(), keys: true },
  json: { line: [], block: [], quotes: ['"'], keywords: new Set(), keys: true },
  css: { line: [], block: [["/*", "*/"]], quotes: ['"', "'"], keywords: new Set(), keys: true },
  sql: { line: ["--"], block: [["/*", "*/"]], quotes: ["'", '"'], keywords: SQL, caseless: true },
  html: { line: [], block: [["<!--", "-->"]], quotes: ['"', "'"], keywords: new Set(), markup: true },
  markdown: { markdown: true },
};

const EXTENSIONS = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", mts: "js", cts: "js",
  rs: "rust", go: "go",
  c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", cs: "c", java: "c", kt: "c", kts: "c", swift: "c", scala: "c",
  dart: "c", php: "c", zig: "c", proto: "c",
  py: "python", pyi: "python",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  rb: "ruby",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "toml", cfg: "toml", conf: "shell", env: "shell",
  json: "json", jsonc: "js", json5: "js",
  css: "css", scss: "css", less: "css",
  sql: "sql",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html", svelte: "html",
  md: "markdown", mdx: "markdown", markdown: "markdown",
};
const NAMES = { Dockerfile: "shell", Makefile: "shell", Justfile: "shell", ".gitignore": "shell", ".env": "shell" };

export function languageOf(path) {
  const name = path.split("/").pop();
  const id = NAMES[name] ?? EXTENSIONS[name.includes(".") ? name.split(".").pop().toLowerCase() : ""];
  return id ? LANGUAGES[id] : null;
}

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0[xob][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)[a-zA-Z]*/y;
const SPACE = /\s+/y;

function at(regex, text, pos) {
  regex.lastIndex = pos;
  const m = regex.exec(text);
  return m ? m[0] : null;
}

// Tokens for each of `lines`, as [{ text, kind }], carrying open comments and strings from
// one line to the next. kind: null (plain), "comment", "string", "number", "keyword",
// "constant", "type", "function", "property", "punctuation".
export function highlight(lang, lines) {
  if (!lang) return lines.map((text) => [{ text, kind: null }]);
  if (lang.markdown) return lines.map(markdownLine);
  const state = { close: null, kind: null };
  return lines.map((text) => scanLine(lang, text, state));
}

function scanLine(lang, text, state) {
  const out = [];
  const push = (part, kind) => {
    if (!part) return;
    const last = out.at(-1);
    if (last && last.kind === kind) last.text += part;
    else out.push({ text: part, kind });
  };
  let pos = 0;

  // Inside a block comment or a multi-line string from an earlier line.
  if (state.close) {
    const end = findClose(text, 0, state.close, state.kind === "string");
    if (end < 0) { push(text, state.kind); return out; }
    push(text.slice(0, end), state.kind);
    pos = end;
    state.close = null;
  }

  while (pos < text.length) {
    const starts = (delimiter) => text.startsWith(delimiter, pos);
    const line = lang.line.find(starts);
    if (line) { push(text.slice(pos), "comment"); break; }

    const block = lang.block.find(([open]) => starts(open));
    if (block) {
      const end = findClose(text, pos + block[0].length, block[1], false);
      if (end < 0) { push(text.slice(pos), "comment"); state.close = block[1]; state.kind = "comment"; break; }
      push(text.slice(pos, end), "comment");
      pos = end;
      continue;
    }

    const quote = lang.quotes.find(starts);
    if (quote) {
      const end = findClose(text, pos + quote.length, quote, true);
      if (end < 0) {
        push(text.slice(pos), "string");
        if (lang.multiline?.includes(quote)) { state.close = quote; state.kind = "string"; }
        break;
      }
      const isKey = lang.keys && /^\s*:/.test(text.slice(end));
      push(text.slice(pos, end), isKey ? "property" : "string");
      pos = end;
      continue;
    }

    if (lang.markup && text[pos] === "<") {
      const tag = /<\/?[\w:.-]*/y;
      tag.lastIndex = pos;
      const m = tag.exec(text);
      if (m && m[0].length > 1) { push("<", "punctuation"); push(m[0].slice(1), "keyword"); pos += m[0].length; continue; }
    }

    const space = at(SPACE, text, pos);
    if (space) { push(space, null); pos += space.length; continue; }

    const prev = text[pos - 1];
    const number = (!prev || !/[\w$]/.test(prev)) && at(NUMBER, text, pos);
    if (number) { push(number, "number"); pos += number.length; continue; }

    const ident = at(IDENT, text, pos);
    if (ident) {
      push(ident, kindOfIdent(lang, ident, text, pos + ident.length));
      pos += ident.length;
      continue;
    }

    push(text[pos], /[{}()[\];,.:=<>+\-*/%!&|^~?@#]/.test(text[pos]) ? "punctuation" : null);
    pos++;
  }
  return out;
}

function kindOfIdent(lang, ident, text, after) {
  const word = lang.caseless ? ident.toLowerCase() : ident;
  if (lang.keywords.has(word)) return "keyword";
  if (CONSTANTS.has(ident) || /^[A-Z][A-Z0-9_]{2,}$/.test(ident)) return "constant";
  const next = text.slice(after).match(/^\s*(\S)/)?.[1];
  if (lang.keys && (next === ":" || next === "=") && !text.slice(0, after - ident.length).trim()) return "property";
  if (lang.markup && next === "=") return "property";
  if (next === "(" || (next === "!" && text[after + 1] === "(")) return "function";
  if (/^[A-Z]/.test(ident)) return "type";
  return null;
}

// Index just past the closing delimiter, or -1. Strings honour backslash escapes.
function findClose(text, from, close, escapes) {
  for (let i = from; i < text.length; i++) {
    if (escapes && text[i] === "\\") { i++; continue; }
    if (text.startsWith(close, i)) return i + close.length;
  }
  return -1;
}

function markdownLine(text) {
  if (/^\s*#{1,6}\s/.test(text)) return [{ text, kind: "keyword" }];
  if (/^\s*(```|~~~)/.test(text)) return [{ text, kind: "comment" }];
  const out = [];
  const pattern = /(`[^`]+`)|(\[[^\]]*\]\([^)]*\))|(\*\*[^*]+\*\*)|(^\s*(?:[-*+]|\d+\.)\s)/g;
  let pos = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > pos) out.push({ text: text.slice(pos, m.index), kind: null });
    const kind = m[1] ? "string" : m[2] ? "function" : m[3] ? "type" : "punctuation";
    out.push({ text: m[0], kind });
    pos = m.index + m[0].length;
  }
  if (pos < text.length || !out.length) out.push({ text: text.slice(pos), kind: null });
  return out;
}
