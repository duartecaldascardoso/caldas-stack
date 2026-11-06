// The rows the diff view draws for one file, and how they wrap. Pure.
import { wordDiff } from "./words.js";
import { highlight } from "./syntax.js";

// A cell is one side of one line: { n, text, kind: "ctx" | "add" | "del", tokens, marks }.
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
      highlight(lang, texts).forEach((tokens, i) => {
        const n = shownTo + i;
        rows.push(contextRow({ kind: "ctx", text: texts[i], old: n - offset, new: n, tokens, marks: null }));
      });
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
      pairWords(dels, adds);
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
  return rows;
}

// Every line of a hunk with its numbers on both sides and its syntax tokens. Each side is
// highlighted as the run of lines it reads as, so a comment opened on one line carries on.
function hunkCells(hunk, lang) {
  const cells = [];
  let old = hunk.oldStart;
  let next = hunk.newStart;
  const oldSide = [];
  const newSide = [];
  for (const line of hunk.lines) {
    const kind = line.kind === "+" ? "add" : line.kind === "-" ? "del" : "ctx";
    const cell = { kind, text: line.text, old: kind === "add" ? null : old++, new: kind === "del" ? null : next++, marks: null };
    if (kind !== "add") oldSide.push(cell);
    if (kind !== "del") newSide.push(cell);
    cells.push(cell);
  }
  const oldTokens = highlight(lang, oldSide.map((c) => c.text));
  const newTokens = highlight(lang, newSide.map((c) => c.text));
  oldSide.forEach((cell, i) => { cell.tokens = oldTokens[i]; });
  // Context lines read the same on both sides; the new side's tokens win.
  newSide.forEach((cell, i) => { cell.tokens = newTokens[i]; });
  return cells;
}

// The i-th removed line of a change most often became its i-th added line.
function pairWords(dels, adds) {
  for (let i = 0; i < Math.min(dels.length, adds.length); i++) {
    const diff = wordDiff(dels[i].text, adds[i].text);
    if (!diff) continue;
    dels[i].marks = diff.before;
    adds[i].marks = diff.after;
  }
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
  const marks = cell.marks ?? [];
  let pos = 0;
  for (const token of cell.tokens ?? [{ text: cell.text, kind: null }]) {
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
