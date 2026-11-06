// The board as data: parsing and writing the markdown file, and the edits the view makes.
// Pure functions over `lanes` (one array of card strings per column); nothing here touches Herdr.

export const COLUMNS = ["Ideas", "Todo", "WIP", "Test", "Done"];

export function emptyLanes() {
  return COLUMNS.map(() => []);
}

// "## <column>" starts a lane (case-insensitive), "- " or "* " lines are its cards.
// Anything else, including cards under an unknown heading, is ignored.
export function parse(text) {
  const lanes = emptyLanes();
  let lane = -1;
  for (const line of (text ?? "").split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      lane = COLUMNS.findIndex((c) => c.toLowerCase() === heading[1].toLowerCase());
      continue;
    }
    const card = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (card && lane >= 0) lanes[lane].push(card[1]);
  }
  return lanes;
}

export function serialize(title, lanes) {
  const sections = COLUMNS.map((c, i) => `\n## ${c}\n` + lanes[i].map((card) => `- ${card}\n`).join(""));
  return `# ${title}\n` + sections.join("");
}

// A board's file name from what someone typed: no path separators, no leading dots.
export function boardName(input) {
  const name = input.trim().replace(/[/\\:]/g, "-").replace(/^\.+/, "");
  return name || null;
}

// Each edit returns new lanes and where the cursor lands, or null when there is nothing to do.

export function addCard(lanes, col, text) {
  const card = text.trim();
  if (!card) return null;
  const next = lanes.map((l, i) => (i === col ? [...l, card] : l));
  return { lanes: next, col, row: next[col].length - 1 };
}

// Empty text deletes the card.
export function editCard(lanes, col, row, text) {
  const card = text.trim();
  if (card === lanes[col][row]) return null;
  if (!card) return removeCard(lanes, col, row);
  const next = lanes.map((l, i) => (i === col ? l.map((c, j) => (j === row ? card : c)) : l));
  return { lanes: next, col, row };
}

export function removeCard(lanes, col, row) {
  if (row < 0 || row >= lanes[col].length) return null;
  const next = lanes.map((l, i) => (i === col ? l.filter((_, j) => j !== row) : l));
  return { lanes: next, col, row: Math.min(row, next[col].length - 1) };
}

// Moves a card to the end of the next column left (-1) or right (+1).
export function shiftCard(lanes, col, row, step) {
  const to = col + step;
  if (row < 0 || row >= lanes[col].length || to < 0 || to >= COLUMNS.length) return null;
  const card = lanes[col][row];
  const next = lanes.map((l, i) => (i === col ? l.filter((_, j) => j !== row) : i === to ? [...l, card] : l));
  return { lanes: next, col: to, row: next[to].length - 1 };
}

// Swaps a card with the one above (-1) or below (+1).
export function reorderCard(lanes, col, row, step) {
  const to = row + step;
  if (row < 0 || to < 0 || to >= lanes[col].length) return null;
  const lane = [...lanes[col]];
  [lane[row], lane[to]] = [lane[to], lane[row]];
  return { lanes: lanes.map((l, i) => (i === col ? lane : l)), col, row: to };
}

// What a card is linked to: a pull request ("#42", or its GitHub URL) or a branch
// ("@feature/login"). The link stays in the card's text, so the file remains plain markdown.
export function cardLink(text) {
  const url = text.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
  if (url) return { pr: Number(url[1]), token: url[0] };
  const pr = text.match(/(?:^|\s)#(\d+)\b/);
  if (pr) return { pr: Number(pr[1]), token: `#${pr[1]}` };
  const branch = text.match(/(?:^|\s)@([\w./-]+[\w-])/);
  if (branch) return { branch: branch[1], token: `@${branch[1]}` };
  return null;
}

// The card's text without its link, for showing the link apart.
export function withoutLink(text) {
  const link = cardLink(text);
  return link ? text.replace(link.token, "").replace(/\s{2,}/g, " ").trim() : text;
}
