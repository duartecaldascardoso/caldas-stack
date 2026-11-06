// Code that was moved rather than written: runs of at least three removed lines that reappear,
// identical but for indentation, as added lines anywhere in the diff. Pure.

// Shortest run of identical lines that counts as moved rather than coincidence.
const MIN_RUN = 3;

// Lines too generic to anchor a move on their own: blank, braces, `end`, …
const trivial = (text) => text.length < 4 || /^[\s{}()[\];,.<>/*\-#'"`|]*(end|fi|done|else)?[\s{}()[\];,]*$/.test(text);

const key = (file, side, n) => `${file}\0${side}\0${n}`;

// Every changed line of a file, with its side ("old" or "new") and number.
function changedLines(file) {
  const out = [];
  for (const hunk of file.hunks) {
    let old = hunk.oldStart;
    let next = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.kind === "-") out.push({ side: "old", n: old, text: line.text.trim() });
      if (line.kind === "+") out.push({ side: "new", n: next, text: line.text.trim() });
      if (line.kind !== "+") old++;
      if (line.kind !== "-") next++;
    }
  }
  return out;
}

// { lines: Set of "file\0side\0n", perFile: Map of file id to moved lines (both sides) }.
export function findMoves(files) {
  const removed = [];
  const added = [];
  for (const file of files) {
    if (file.generated) continue;
    for (const line of changedLines(file)) (line.side === "old" ? removed : added).push({ ...line, file: file.id });
  }
  // Where each meaningful removed line sits, by its text.
  const at = new Map();
  removed.forEach((l, i) => {
    if (!trivial(l.text)) at.set(l.text, [...(at.get(l.text) ?? []), i]);
  });

  const lines = new Set();
  const perFile = new Map();
  const mark = (l) => {
    const k = key(l.file, l.side, l.n);
    if (lines.has(k)) return;
    lines.add(k);
    perFile.set(l.file, (perFile.get(l.file) ?? 0) + 1);
  };

  for (let i = 0; i < added.length;) {
    let best = { len: 0, from: -1 };
    for (const from of at.get(added[i].text) ?? []) {
      let len = 0;
      while (
        i + len < added.length && from + len < removed.length
        && added[i + len].text === removed[from + len].text
        && added[i + len].file === added[i].file
        && removed[from + len].file === removed[from].file
      ) len++;
      if (len > best.len) best = { len, from };
    }
    // Enough real lines in the run, not just a match on braces.
    const meaningful = best.len && added.slice(i, i + best.len).filter((l) => !trivial(l.text)).length;
    if (best.len >= MIN_RUN && meaningful >= 2) {
      for (let j = 0; j < best.len; j++) {
        mark(added[i + j]);
        mark(removed[best.from + j]);
      }
      i += best.len;
    } else i++;
  }
  return { lines, perFile };
}

export const isMoved = (moves, file, side, n) => moves.lines.has(key(file, side, n));
