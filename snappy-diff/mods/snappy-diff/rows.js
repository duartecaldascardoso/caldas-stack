// The rows the diff view draws for one file, and how they wrap. Pure.
import { wordDiff } from "./words.js";
import { highlight } from "./syntax.js";

// A cell is one side of one line: { n, text, kind: "ctx" | "add" | "del", lazy }. Its syntax
// tokens and word changes are only worked out when it is first drawn (tokensOf, marksOf): a big
// diff opens without highlighting lines nobody scrolls to. `lazy` is shared by the copies a
// split row makes of a context line, so either side's work serves both.
// Rows: { t: "hunk", hunk, hidden, context } between hunks; { t: "split", left, right } or
// { t: "unified", cell, old, new } for lines; { t: "notice", text } for files without lines.
// `expanded`, when the file's text is known, opens separators: { lines, gaps: Set of hunk indexes }.
export function fileRows(file, style, lang, expanded = null) {
  if (file.tooLarge) return [{ t: "notice", text: `Too large to show: ${(file.add + file.del).toLocaleString()} lines changed` }];
  if (file.binary) return [{ t: "notice", text: "Binary file not shown" }];
  if (!file.hunks.length) {
    const text = file.type === "rename-pure" ? `Renamed from ${file.prevName}, unchanged` : "Empty file";
    return [{ t: "notice", text }];
  }
  const rows = [];
  const contextRow = (cell) => (style === "split"
    ? { t: "split", left: { ...cell, n: cell.old }, right: { ...cell, n: cell.new } }
    : { t: "unified", cell, old: cell.old, new: cell.new });
  let shownTo = 1; // the next new-side line number after the last hunk shown
  file.hunks.forEach((hunk, index) => {
    // A separator stands for the unchanged lines it hides; a file changed from line 1 has none.
    const hidden = Math.max(0, hunk.newStart - shownTo);
    if (hidden && expanded?.lines && expanded.gaps.has(index)) {
      const offset = hunk.newStart - hunk.oldStart; // context reads the same on both sides
      const texts = expanded.lines.slice(shownTo - 1, hunk.newStart - 1);
      const run = textRun(lang, texts.map((text, i) => ({ kind: "ctx", text, old: shownTo + i - offset, new: shownTo + i })));
      for (const cell of run.cells) rows.push(contextRow(cell));
    } else if (hidden) rows.push({ t: "hunk", hunk: index, hidden, context: hunk.context });
    shownTo = hunk.newStart + hunk.newCount;
    const cells = hunkCells(hunk, lang);
    for (let i = 0; i < cells.length;) {
      if (cells[i].kind === "ctx") {
        rows.push(contextRow(cells[i++]));
        continue;
      }
      const dels = [];
      const adds = [];
      while (cells[i]?.kind === "del") dels.push(cells[i++]);
      while (cells[i]?.kind === "add") adds.push(cells[i++]);
      pairLines(dels, adds);
      if (style === "split") {
        for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
          rows.push({ t: "split", left: dels[j] ? { ...dels[j], n: dels[j].old } : null, right: adds[j] ? { ...adds[j], n: adds[j].new } : null });
        }
      } else {
        for (const cell of dels) rows.push({ t: "unified", cell, old: cell.old, new: null });
        for (const cell of adds) rows.push({ t: "unified", cell, old: null, new: cell.new });
      }
    }
  });
  // After the last change: only known once the file's text is loaded.
  const lines = expanded?.lines;
  const last = file.hunks.at(-1);
  const total = lines ? lines.length - (lines.at(-1) === "" ? 1 : 0) : 0;
  const after = lines ? Math.max(0, total - (shownTo - 1)) : 0;
  if (after && expanded.gaps.has(file.hunks.length)) {
    const offset = last.newStart + last.newCount - (last.oldStart + last.oldCount);
    const texts = lines.slice(shownTo - 1, total);
    const run = textRun(lang, texts.map((text, i) => ({ kind: "ctx", text, old: shownTo + i - offset, new: shownTo + i })));
    for (const cell of run.cells) rows.push(contextRow(cell));
  } else if (after) rows.push({ t: "hunk", hunk: file.hunks.length, hidden: after, context: "" });
  return rows;
}

// Every line of a hunk with its numbers on both sides. Each side is highlighted as the run of
// lines it reads as, so a comment opened on one line carries on; context lines read the same on
// both sides, and take the new side's tokens.
function hunkCells(hunk, lang) {
  const cells = [];
  let old = hunk.oldStart;
  let next = hunk.newStart;
  const oldSide = [];
  const newSide = [];
  for (const line of hunk.lines) {
    const kind = line.kind === "+" ? "add" : line.kind === "-" ? "del" : "ctx";
    const cell = { kind, text: line.text, old: kind === "add" ? null : old++, new: kind === "del" ? null : next++ };
    if (kind !== "add") oldSide.push(cell);
    if (kind !== "del") newSide.push(cell);
    cells.push(cell);
  }
  textRun(lang, oldSide);
  textRun(lang, newSide);
  return cells;
}

// Lines highlighted together when one of them is first drawn. A cell already in a run (a context
// line, in the old side's) moves to this one: the last run a cell joins gives its tokens.
function textRun(lang, cells) {
  const run = { lang, cells };
  for (const cell of cells) {
    cell.lazy ??= { tokens: undefined, marks: undefined, pair: null };
    cell.lazy.run = run;
  }
  return run;
}

// The i-th removed line of a change most often became its i-th added line: their changed words
// are marked, once one of them is drawn.
function pairLines(dels, adds) {
  for (let i = 0; i < Math.min(dels.length, adds.length); i++) {
    dels[i].lazy.pair = { before: dels[i], after: adds[i] };
    adds[i].lazy.pair = dels[i].lazy.pair;
  }
}

// A cell's syntax tokens, [{ text, kind }]: its run is highlighted the first time any of its
// lines is asked for.
export function tokensOf(cell) {
  const lazy = cell.lazy;
  if (!lazy) return cell.tokens ?? [{ text: cell.text, kind: null }];
  if (lazy.tokens === undefined) {
    const { lang, cells } = lazy.run;
    highlight(lang, cells.map((c) => c.text)).forEach((tokens, i) => {
      if (cells[i].lazy.run === lazy.run) cells[i].lazy.tokens = tokens;
    });
  }
  return lazy.tokens;
}

// A cell's changed words, [[start, end)], or null: worked out for its pair the first time either
// line is asked for.
export function marksOf(cell) {
  const lazy = cell.lazy;
  if (!lazy) return cell.marks ?? null;
  if (lazy.marks === undefined) {
    const { pair } = lazy;
    const diff = pair ? wordDiff(pair.before.text, pair.after.text) : null;
    if (pair) {
      pair.before.lazy.marks = diff?.before ?? null;
      pair.after.lazy.marks = diff?.after ?? null;
    } else lazy.marks = null;
  }
  return lazy.marks;
}

// Where a text wraps at `cols` characters: [start, end) per visual line. Breaks after the
// last space that fits, like a browser; a word longer than a line breaks where it must.
export function wrapLines(text, cols) {
  const width = Math.max(1, cols);
  const out = [];
  let start = 0;
  while (text.length - start > width) {
    const space = text.lastIndexOf(" ", start + width - 1);
    const end = space >= start + 1 && text.slice(start, space).trim() ? space + 1 : start + width;
    out.push([start, end]);
    start = end;
  }
  out.push([start, text.length]);
  return out;
}

export const wrapCount = (text, cols) => (text.length <= cols ? 1 : wrapLines(text, cols).length);

// The pieces of text[start, end) to draw: each with its syntax kind and whether it is a
// word-level change.
export function segments(cell, start, end) {
  const out = [];
  const marks = marksOf(cell) ?? [];
  let pos = 0;
  for (const token of tokensOf(cell)) {
    const tokenEnd = pos + token.text.length;
    let from = Math.max(pos, start);
    const to = Math.min(tokenEnd, end);
    while (from < to) {
      const mark = marks.find(([a, b]) => a <= from && from < b);
      const next = marks.find(([a]) => a > from)?.[0] ?? Infinity;
      const stop = Math.min(to, mark ? mark[1] : next);
      out.push({ text: cell.text.slice(from, stop), kind: token.kind, marked: Boolean(mark) });
      from = stop;
    }
    pos = tokenEnd;
  }
  return out;
}
