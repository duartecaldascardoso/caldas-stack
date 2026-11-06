// How tall a card is, so a column can be a virtual list that scrolls to its cursor. Pure.

export const LINE_H = 18; // a card's text lines
export const PAD_Y = 10; // above and below a card's content
export const CHIPS_H = 22; // the row of link and agent chips
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

// A card's height in the list, the gap after it included.
export function cardHeight(lineCount, hasChips) {
  return 2 * BORDER + 2 * PAD_Y + lineCount * LINE_H + (hasChips ? CHIPS_GAP + CHIPS_H : 0) + CARD_GAP;
}
