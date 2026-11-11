// The board as data: parsing and writing the markdown file, and the edits the view makes.
// Pure functions over `lanes` (one array of card strings per column); nothing here touches Herdr.

// The columns follow pstack's loop: Ideas is the backlog, then Plan, Work, Review and Ship.
export const COLUMNS = ["Ideas", "Plan", "Work", "Review", "Ship"];
// The names boards used before, still read so old files open; saving writes the new ones.
const OLD_NAMES = { todo: 1, wip: 2, test: 3, done: 4 };

// A column's index from its name or old name (case-insensitive), or -1.
export function columnIndex(name) {
  const key = String(name ?? "").toLowerCase();
  const i = COLUMNS.findIndex((c) => c.toLowerCase() === key);
  return i >= 0 ? i : OLD_NAMES[key] ?? -1;
}

export function emptyLanes() {
  return COLUMNS.map(() => []);
}

// Free notes close a board's file, under this heading, kept exactly as written.
const NOTES = /^##\s+notes\s*$/i;

// "## <column>" starts a lane (case-insensitive, old names too), "- " or "* " lines are its cards.
// Anything else, including cards under an unknown heading, is ignored. "## Notes" ends the
// columns: what follows is the board's notes, lists and headings included.
export function parse(text) {
  const lanes = emptyLanes();
  let lane = -1;
  for (const line of (text ?? "").split("\n")) {
    if (NOTES.test(line)) break;
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      lane = columnIndex(heading[1]);
      continue;
    }
    const card = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (card && lane >= 0) lanes[lane].push(card[1]);
  }
  return lanes;
}

// The board's notes: everything after "## Notes", without the blank lines around it.
export function notesOf(text) {
  const lines = (text ?? "").split("\n");
  const at = lines.findIndex((line) => NOTES.test(line));
  return at < 0 ? "" : lines.slice(at + 1).join("\n").replace(/^\s*\n/, "").trimEnd();
}

export function serialize(title, lanes, notes = "") {
  const sections = COLUMNS.map((c, i) => `\n## ${c}\n` + lanes[i].map((card) => `- ${card}\n`).join(""));
  const tail = notes.trim() ? `\n## Notes\n\n${notes.trimEnd()}\n` : "";
  return `# ${title}\n` + sections.join("") + tail;
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

// What a card is linked to, written in its text so the file stays plain markdown:
// numbers ("#42", "issue #34", "PR #47", or a GitHub issue or pull request URL) and a branch
// ("@feature/login"). { refs: [{ n, kind, token }], branch, branchToken }, or null. A ref's kind
// is "pr" or "issue" when the text says so, and null for a bare "#42": GitHub settles it.
const URL_REF = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/(pull|issues)\/(\d+)\S*/g;
const WORD_REF = /(^|[\s(,])((?:(issue|pr)\s+)?#(\d+))\b/gi;
const BRANCH = /(?:^|\s)(@([\w./-]*[\w-]))/;

export function cardLinks(text) {
  const refs = [];
  for (const m of text.matchAll(URL_REF)) refs.push({ n: Number(m[2]), kind: m[1] === "pull" ? "pr" : "issue", token: m[0] });
  const withoutUrls = text.replace(URL_REF, " ");
  for (const m of withoutUrls.matchAll(WORD_REF)) {
    const n = Number(m[4]);
    if (refs.some((r) => r.n === n)) continue;
    refs.push({ n, kind: m[3] ? (m[3].toLowerCase() === "pr" ? "pr" : "issue") : null, token: m[2] });
  }
  const branch = text.match(BRANCH);
  if (!refs.length && !branch) return null;
  return { refs, branch: branch?.[2] ?? null, branchToken: branch?.[1] ?? null };
}

// The card's text without the links at its end, for showing them apart. Links inside a
// sentence ("PR #47 needs a test") stay where they are.
export function withoutLinks(text) {
  const links = cardLinks(text);
  if (!links) return text;
  const tokens = [...links.refs.map((r) => r.token), links.branchToken].filter(Boolean);
  let rest = text.trimEnd();
  for (let found = true; found;) {
    found = false;
    for (const token of tokens) {
      if (rest.endsWith(token) && rest.length > token.length) {
        rest = rest.slice(0, -token.length).trimEnd();
        found = true;
      }
    }
  }
  return rest;
}

// The card's text with one more link at its end: "#42", "issue #34" or "@branch". A branch
// replaces the card's branch; a number it already has is left as it is.
export function withLink(text, token) {
  if (token.startsWith("@")) {
    const old = cardLinks(text)?.branchToken;
    return old ? text.replace(old, token) : `${text.trimEnd()} ${token}`;
  }
  const n = Number(token.match(/#(\d+)/)?.[1]);
  if (cardLinks(text)?.refs.some((r) => r.n === n)) return text;
  return `${text.trimEnd()} ${token}`;
}

// Open issues brought into Ideas as "<title> issue #<n>", leaving out any the board already
// mentions anywhere. Issues: [{ number, title }]. Returns { lanes, added } (added: the new cards).
export function importIssues(lanes, issues) {
  const known = new Set(lanes.flat().flatMap((card) => cardLinks(card)?.refs.map((r) => r.n) ?? []));
  const added = issues
    .filter((issue) => !known.has(issue.number))
    .map((issue) => `${issue.title.replace(/\s+/g, " ").trim()} issue #${issue.number}`);
  return { lanes: lanes.map((lane, i) => (i === 0 ? [...lane, ...added] : lane)), added };
}
