// How tall a card is, so a column can be a virtual list that scrolls to its cursor, and the
// chips under its text. Pure.
import { progress } from "./runs.js";

export const LINE_H = 18; // a card's text lines
export const PAD_Y = 10; // above and below a card's content
export const CHIPS_H = 22; // a row of link chips
export const CHIPS_ROW_GAP = 4; // between rows of chips
export const CHIP_GAP = 6; // between chips in a row
export const CHIPS_GAP = 8; // between the text and the chips
export const BORDER = 1;
export const CARD_GAP = 6; // between cards
export const INPUT_H = 36; // the card being written

// Where a text wraps at `cols` characters: the lines' text. Breaks after the last space that
// fits; a word longer than a line breaks where it must.
export function wrapText(text, cols) {
  const width = Math.max(1, cols);
  const lines = [];
  let rest = text;
  while (rest.length > width) {
    const space = rest.lastIndexOf(" ", width);
    const end = space > 0 ? space : width;
    lines.push(rest.slice(0, end));
    rest = rest.slice(end).replace(/^ /, "");
  }
  lines.push(rest);
  return lines;
}

// Chips of these widths in rows of `available` px, filled left to right: [[indexes], …].
export function chipLayout(widths, available) {
  const rows = [];
  let used = 0;
  widths.forEach((width, i) => {
    const next = used ? used + CHIP_GAP + width : width;
    if (!rows.length || (next > available && used)) { rows.push([i]); used = width; } else { rows.at(-1).push(i); used = next; }
  });
  return rows;
}

export const chipRows = (widths, available) => chipLayout(widths, available).length;

// A card's height in the list, the gap after it included.
export function cardHeight(lineCount, chipRowCount = 0) {
  const chips = chipRowCount ? CHIPS_GAP + chipRowCount * CHIPS_H + (chipRowCount - 1) * CHIPS_ROW_GAP : 0;
  return 2 * BORDER + 2 * PAD_Y + lineCount * LINE_H + chips + CARD_GAP;
}

// A card's links and playbook progress as chips, each { mark, texts, width }: a mark (a dot for a
// pull request, a ring for an issue, or none), and pieces of text as [text, colour]. Widths come
// from `charW`, the 13px text's character width, the way the card's text is wrapped, so the
// card's height is known before it is drawn. `links` is the card's links with GitHub's statuses,
// `run` and `book` its playbook run, `done` whether it shipped.
export function chipsOf(t, links, { run, book }, charW, done) {
  if (!links) return [];
  const ch = (charW * 11) / 13;
  const chip = (mark, texts) => ({
    mark, texts,
    width: 16 + (mark ? 12 : 0) + texts.reduce((n, [text]) => n + text.length * ch, 0) + 6 * Math.max(0, texts.length - 1),
  });
  const number = (n) => [`#${n}`, done ? t.muted : t.foreground];
  const out = [];
  for (const ref of links.refs) {
    const st = ref.status;
    if (st?.kind === "issue" || (ref.kind === "issue" && !st)) {
      const color = !st ? t.dim : st.state === "open" ? t.ansi2 : st.completed ? t.ansi5 : t.dim;
      const state = st ? [[st.state === "closed" && !st.completed ? "not planned" : st.state, t.dim]] : [];
      out.push(chip({ ring: true, color }, [number(ref.n), ["issue", t.dim], ...state]));
      continue;
    }
    const color = { open: t.ansi2, draft: t.dim, merged: t.ansi5, closed: t.ansi1 }[st?.state] ?? t.dim;
    const checks = { passing: ["✓", t.ansi2], failing: ["✗", t.ansi1], pending: ["•", t.ansi3] }[st?.checks];
    const review = { approved: ["approved", t.ansi2], changes: ["changes", t.ansi1] }[st?.review];
    out.push(chip({ ring: false, color }, [number(ref.n), ...(st ? [[st.state, t.dim]] : []), ...(checks ? [checks] : []), ...(review ? [review] : [])]));
  }
  if (links.branch) out.push(chip(null, [[`⎇ ${links.branch}`, done ? t.dim : t.muted]]));
  if (run && book) {
    const at = progress(run, book.steps.length);
    out.push(chip(null, [[`${at.done}/${book.steps.length}`, done ? t.muted : t.foreground], [at.current ? book.steps[at.current - 1][0] : "done", t.dim]]));
  }
  return out;
}
