// How tall a card is, so a column can be a virtual list that scrolls to its cursor. Pure.

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
