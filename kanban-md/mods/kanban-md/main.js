// kanban-md: plain-text kanban boards for Herdr, one markdown file per board in ~/kanban.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { home, appHome, props, openOverlay, closeOverlay, readTextFile, writeTextFile, exec, hc, focused, notify, run, agents, panes, spaces, shared, setShared, nextCommand, settings, theme } from "herdr";
import {
  COLUMNS, emptyLanes, parse, serialize, notesOf, boardName, importIssues, matches, parseArchive, archiveCards, localDay,
  addCard, editCard, removeCard, shiftCard, reorderCard, cardLinks, withoutLinks, withLink,
} from "./board.js";
import { columnFor, describe, ciPrompt } from "./links.js";
import { branchFor, cardBranch, agentsByBranch, finished, playbookOf, taskFor, babysitFor, babysitTask, playbookNamed, PLAYBOOK_LIST } from "./work.js";
import { parseRuns, recordPlaybook } from "./runs.js";
import { PAD_Y, CHIPS_GAP, CARD_GAP, INPUT_H, LINE_H, wrapText, cardHeight, chipLayout, chipsOf } from "./cards.js";
import { projectOf, isRepository, currentBranch, commitsAhead, push, checkout } from "./git.js";
import { statusesOf, currentPullRequest, pullRequestFrom, createPullRequest, openIssues, showIssue, failedRun } from "./github.js";
import { pickAgent, lastAgentMessage } from "./agents.js";
import { alpha, unzoom, keycaps, sectionLabel, agentMark, chipRowsView } from "./ui.js";
import { helpView, cardRunView } from "./inspector.js";
import { projectSetup, everywhereSetup } from "./claude.js";
import { setupPage, setupItems, columnRows } from "./setup-page.js";
import { setupSummary } from "./setup.js";

const TEXT_SIZE = 13;
// Card text sits inside: the column's border, the list's 8px sides, the card's border and 12px sides.
const CARD_INSET = 2 + 16 + 2 + 24;
// Room the agent's status takes at the end of a card's first line: Herdr's own marks.
const markWidth = (agent) => (!agent ? 0 : agent.status === "blocked" ? 76 : 20);

const DIR = `${home()}/kanban`;
const TRASH = `${DIR}/.trash`;
const ARCHIVE = `${DIR}/.archive`; // each board's archived cards, <board>.md
const REPOS = `${DIR}/.repos.json`; // board name -> repository folder, learnt from project boards
const DEFAULT_BOARD = "main";
const POLL_MS = 3000; // picks up edits made to the files elsewhere
const STATUS_MS = 60000; // linked pull requests, through gh
const AGENTS_MS = 2000; // agents finishing their work
const HISTORY_LIMIT = 200;
const NOTES_SAVE_MS = 600; // notes save this long after the last keystroke
const OPENED = "kanban-md.opened"; // { cwd, at }: where ⌘⇧K was pressed, for the board's tab
const OPENED_MS = 200;

const KEYS = {
  "left": "left", "h": "left", "right": "right", "l": "right",
  "up": "up", "k": "up", "down": "down", "j": "down",
  "shift-left": "shift-left", "shift-h": "shift-left", "shift-right": "shift-right", "shift-l": "shift-right",
  "shift-up": "shift-up", "shift-k": "shift-up", "shift-down": "shift-down", "shift-j": "shift-down",
  "n": "new", "a": "new", "enter": "open-card", "e": "edit", "d": "delete", "x": "delete", "backspace": "delete",
  "cmd-z": "undo", "cmd-shift-z": "redo",
  "[": "prev-board", "shift-tab": "prev-board", "]": "next-board", "tab": "next-board",
  "b": "new-board", "p": "project-board", "shift-d": "delete-board", "escape": "close",
  "g": "open-diff", "shift-2": "link", "@": "link", "o": "open-pr", "s": "start-work", "shift-b": "babysit", "i": "inspect", "?": "help", "shift-/": "help", "shift-n": "notes", "shift-i": "import-issues", "f": "fix-ci",
  "t": "go-to-agent", "shift-a": "archive", "cmd-k": "palette", "/": "palette",
  "1": "column-1", "2": "column-2", "3": "column-3", "4": "column-4", "5": "column-5",
};

// Every key, grouped, for How it works. The hint line only offers the selected card's next
// steps; ⌘K lists every action with its key.
const KEY_GUIDE = [
  ["Move", [["←→↑↓", "between cards"], ["hjkl", "the same"], ["1–5", "to a column"], ["⇧ + move", "the card"], ["[ ]", "other boards"]]],
  ["Cards", [["n", "new card"], ["e ↵", "edit"], ["d", "delete"], ["⌘Z", "undo"], ["⌘⇧Z", "redo"], ["⇧A", "archive shipped"]]],
  ["Work", [["s", "start work"], ["t", "go to agent"], ["i", "inspect"], ["g", "open diff or issue"], ["@", "link branch"], ["o", "open pull request"], ["⇧B", "babysit"], ["f", "fix CI"]]],
  ["Board", [["⌘K /", "go to, all actions"], ["⇧N", "notes"], ["⇧I", "import issues"], ["b", "new board"], ["p", "project board"], ["⇧D", "delete board"], ["?", "this page"]]],
];
// Card actions the hint line leaves to ⌘K: they apply to every card.
const EVERY_CARD = new Set(["edit", "delete"]);
// Each column's dot, from the theme's palette.
const COLUMN_TINTS = ["ansi5", "ansi4", "ansi3", "ansi6", "ansi2"];
const NO_REPO = { title: "No repository for this board", body: "Open the board from a terminal inside the project once.", level: "warning" };

const fileOf = (board) => `${DIR}/${board}.md`;
const archiveOf = (board) => `${ARCHIVE}/${board}.md`;
const runsOf = (board) => `${DIR}/.runs/${board}.json`; // what agents report about their playbooks
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function storedBoard() {
  try { return localStorage.getItem("board"); } catch { return null; }
}

function storeBoard(board) {
  try { localStorage.setItem("board", board); } catch { /* not kept: opens the first board next time */ }
}

// ⌘⇧K opens the board's own tab, so it keeps running: following agents and GitHub, and telling
// when an agent finishes. The overlay mod.open shows is only a launcher: it selects the tab, or
// makes it, hands it the folder ⌘⇧K was pressed in, and closes.
function launch() {
  const cwd = focused()?.cwd ?? null;
  const pane = panes().find((p) => p.mod === "kanban-md");
  if (pane) {
    setShared(OPENED, { cwd, at: Date.now() });
    const space = spaces().find((s) => s.tabs.some((t) => t.id === pane.tab));
    if (space && !space.active) run("space.select", { id: space.id });
    run("tab.select", { id: pane.tab });
  } else {
    run("tab.new", { name: "Board", mod: "kanban-md", props: { cwd } });
  }
  closeOverlay(props().overlay);
}

export default class Kanban extends View {
  init(_props, cx) {
    if (props()?.overlay && !props()?.view) {
      this.launcher = true;
      cx.timer.after(0, () => launch());
      return;
    }
    this.boards = [];
    this.board = storedBoard() ?? DEFAULT_BOARD;
    this.project = null; // the project ⌘⇧K was pressed in: { name, root }, or null
    this.repos = {};
    this.lanes = emptyLanes();
    this.raw = null; // the file as last read or written, to detect edits made elsewhere
    this.col = 0;
    this.rows = COLUMNS.map(() => 0);
    this.history = {}; // board -> { undo: [lanes], redo: [lanes] }
    this.editing = null; // { kind: "card", col, row } (row null: a new card) or { kind: "board" }
    this.ask = null; // a question on the hint line waiting for y: { prompt, yes, danger, run(cx) }
    // "card" (the selected card's run) or "help" (the loop and every playbook), in place of the columns.
    this.inspecting = props()?.view === "help" ? "help" : null;
    this.helpIndex = 0;
    this.detail = null; // the inspected card's { branch, message, commits }
    this.runs = {};
    this.agentsBefore = agentsByBranch(agents(), panes());
    this.statuses = new Map(); // "<repo>#<number>" -> prStatus or issueStatus

    // Each column is a virtual list, so moving the cursor can scroll its card into view.
    this.scrolls = COLUMNS.map(() => VirtualListScrollHandle.new());
    this.columnW = 0; // measured
    this.charW = TEXT_SIZE * 0.6; // measured from the code font
    // Free notes, one page per board, kept at the end of its file under "## Notes".
    this.view = props()?.view === "notes" ? "notes" : "board"; // or "archive", "setup"
    // What agents work with here and everywhere: { root, project, everywhere }, read when shown.
    this.setup = null;
    this.setupIndex = 0;
    this.setupScrolls = [VirtualListScrollHandle.new(), VirtualListScrollHandle.new()];
    this.archived = []; // the board's archive, [{ day, cards }], read when it's shown
    // Go to (⌘K): cards on every board, boards and actions, filtered as you type.
    this.palette = false;
    this.paletteIndex = 0;
    this.everything = []; // every board's cards, [{ board, lanes }], read when go-to opens
    this.paletteInput = InputState.new({ placeholder: "Cards, boards and actions" });
    this.paletteInput.on("change", (_e, cx) => { this.paletteIndex = 0; cx.notify(); });
    this.notes = "";
    this.notesPending = false; // typed but not saved yet: a refresh mustn't overwrite it
    this.notesTyped = 0;
    this.notesInput = TextareaState.new({ placeholder: "Notes for this board: decisions, links, what to remember…" });
    this.notesInput.set_soft_wrap(true);
    this.notesInput.on("change", (_e, cx) => this.typeNotes(cx));
    this.input = InputState.new({ placeholder: "" });
    this.input.on("submit", (_e, cx) => this.commitEdit(cx));
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(300, () => { if (!this.editing) this.handle.focus(); });

    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", DIR]);
      this.repos = JSON.parse(await readTextFile(REPOS).catch(() => null) ?? "{}");
      await this.showProject(props()?.cwd ?? focused()?.cwd, cx);
      await this.syncStatuses(cx);
      if (props()?.view === "inspect") await this.inspectCard(props().card, cx);
    });
    cx.timer.every(POLL_MS, (cx) => { if (!this.editing) cx.spawn((cx) => this.refresh(cx)); });
    cx.timer.every(STATUS_MS, (cx) => { if (!this.editing) cx.spawn((cx) => this.syncStatuses(cx)); });
    cx.timer.every(AGENTS_MS, (cx) => this.noticeFinished(cx));
    this.openedAt = shared(OPENED)?.at ?? 0;
    cx.timer.every(OPENED_MS, (cx) => this.noticeOpened(cx));
    cx.spawn(async () => { for (;;) if ((await nextCommand()) === "focus") this.focusBoard(); });
  }

  // The board takes the keyboard, unless something on it is being typed into.
  focusBoard() {
    if (this.editing) this.input.focus();
    else if (this.palette) this.paletteInput.focus();
    else if (this.view === "notes") this.notesInput.focus();
    else this.handle.focus();
  }

  // ⌘⇧K again, from another terminal: the board for that project, when it has one.
  noticeOpened(cx) {
    const opened = shared(OPENED);
    if (!opened || opened.at <= this.openedAt) return;
    this.openedAt = opened.at;
    this.focusBoard();
    if (opened.cwd) cx.spawn((cx) => this.showProject(opened.cwd, cx));
  }

  // The project `cwd` is in becomes the board's project, and its board opens if it has one.
  async showProject(cwd, cx) {
    this.project = await projectOf(cwd);
    if (this.project) await this.rememberRepo(this.project.name, this.project.root);
    await this.refresh(cx);
    if (this.project && this.boards.includes(this.project.name)) this.openBoard(this.project.name, cx);
    cx.notify();
  }

  // Files

  async refresh(cx) {
    const ls = await exec("ls", [DIR]);
    const boards = ls.stdout.split("\n").filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
    this.boards = boards.length ? boards : [DEFAULT_BOARD];
    if (!this.boards.includes(this.board)) this.board = this.boards[0];

    const text = await readTextFile(fileOf(this.board));
    this.runs = parseRuns(await readTextFile(runsOf(this.board)).catch(() => null));
    if (this.inspecting === "card") await this.loadDetail();
    if (text === null || text !== this.raw) {
      this.raw = text;
      this.lanes = parse(text);
      this.clampRows();
      if (!this.notesPending) this.showNotes(notesOf(text));
    }
    cx.notify();
  }

  save(cx) {
    const board = this.board;
    const text = serialize(board, this.lanes, this.notes);
    const expected = this.raw;
    this.raw = text;
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(fileOf(board), text, expected);
      } catch {
        // The file changed on disk since it was read: show that version instead.
        this.raw = null;
        await this.refresh(cx);
      }
    });
  }

  // Boards

  // Opens a board, the cursor on `at` ({ col, row }) or the first card.
  openBoard(board, cx, at = null) {
    if (board === this.board) {
      if (at) { this.col = at.col; this.rows[at.col] = at.row; cx.notify(); }
      return;
    }
    // Notes typed a moment ago belong to the board they were typed on: save them first.
    if (this.notesPending) {
      this.notesTyped++;
      this.notesPending = false;
      this.save(cx);
    }
    this.board = board;
    this.raw = null;
    this.lanes = emptyLanes();
    // The rows survive the read: refresh only clamps them to the board's cards.
    this.col = at?.col ?? 0;
    this.rows = COLUMNS.map((_, c) => (c === at?.col ? at.row : 0));
    this.ask = null;
    this.archived = [];
    if (this.view === "archive") cx.spawn((cx) => this.loadArchive(cx));
    this.setup = null;
    if (this.view === "setup") cx.spawn((cx) => this.loadSetup(cx));
    storeBoard(board);
    cx.spawn(async (cx) => { await this.refresh(cx); await this.syncStatuses(cx); });
    cx.notify();
  }

  cycleBoard(step, cx) {
    const i = this.boards.indexOf(this.board);
    const n = this.boards.length;
    this.openBoard(this.boards[(i + step + n) % n], cx);
  }

  createBoard(name, cx) {
    if (!this.boards.includes(name)) {
      this.boards = [...this.boards, name].sort();
      cx.spawn(async () => {
        await writeTextFile(fileOf(name), serialize(name, emptyLanes()), null).catch(() => {});
      });
    }
    this.openBoard(name, cx);
  }

  // Moves the file to ~/kanban/.trash rather than deleting it.
  deleteBoard(cx) {
    const board = this.board;
    delete this.history[board];
    this.boards = this.boards.filter((b) => b !== board);
    this.openBoard(this.boards[0] ?? DEFAULT_BOARD, cx);
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", TRASH]);
      await exec("mv", [fileOf(board), `${TRASH}/${board}-${Date.now()}.md`]);
      await this.refresh(cx);
    });
  }

  // Cards

  selected() {
    return this.lanes[this.col][this.rows[this.col]] ?? null;
  }

  // Applies an edit from board.js: keeps the previous lanes for undo, moves the cursor, saves.
  apply(result, cx) {
    if (!result) return;
    this.remember();
    this.lanes = result.lanes;
    this.col = result.col;
    this.rows[result.col] = result.row;
    this.clampRows();
    this.save(cx);
    cx.notify();
  }

  // Keeps the lanes as they are for undo, before they change.
  remember() {
    const history = (this.history[this.board] ??= { undo: [], redo: [] });
    history.undo.push(this.lanes);
    if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
    history.redo = [];
  }

  travel(from, to, cx) {
    const history = this.history[this.board];
    if (!history?.[from].length) return;
    history[to].push(this.lanes);
    this.lanes = history[from].pop();
    this.clampRows();
    this.save(cx);
    cx.notify();
  }

  clampRows() {
    this.rows = this.rows.map((row, i) => Math.max(0, Math.min(row, this.lanes[i].length - 1)));
  }

  moveCursor(dc, dr, cx) {
    this.col = Math.max(0, Math.min(COLUMNS.length - 1, this.col + dc));
    const max = this.lanes[this.col].length - 1;
    this.rows[this.col] = Math.max(0, Math.min(max, this.rows[this.col] + dr));
    cx.notify();
  }

  // Editing

  startEdit(editing, value, cx) {
    this.editing = editing;
    this.input.set_value(value);
    this.input.set_selected_range({ start: 0, end: value.length });
    this.input.focus();
    cx.notify();
  }

  stopEdit(cx) {
    this.editing = null;
    this.handle.focus();
    cx.notify();
  }

  commitEdit(cx) {
    const editing = this.editing;
    const text = this.input.value();
    this.stopEdit(cx);
    if (editing?.kind === "board") {
      const name = boardName(text);
      if (name) this.createBoard(name, cx);
    } else if (editing?.row === null) {
      this.apply(addCard(this.lanes, editing.col, text), cx);
    } else if (editing) {
      this.apply(editCard(this.lanes, editing.col, editing.row, text), cx);
    }
  }

  // Keys

  onKey(event, cx) {
    if (this.palette) return this.paletteKey(event.keystroke, cx);
    if (event.keystroke === "cmd-k") { this.openPalette(cx); cx.stop_propagation(); return; }
    if (this.view === "setup" && this.setupKey(event.keystroke, cx)) { cx.stop_propagation(); return; }
    if (this.view !== "board") {
      if (event.key === "escape") { this.showBoard(cx); cx.stop_propagation(); }
      return;
    }
    if (this.editing) {
      if (event.key === "escape") { this.stopEdit(cx); cx.stop_propagation(); }
      return;
    }
    if (this.ask) {
      const ask = this.ask;
      this.ask = null;
      if (event.keystroke === "y" || event.keystroke === "enter") ask.run(cx);
      cx.notify();
      cx.stop_propagation();
      return;
    }
    if (this.inspecting) {
      const action = KEYS[event.keystroke];
      if (["escape", "i", "?", "shift-/"].includes(event.keystroke)) this.inspecting = null;
      else if (this.inspecting === "help" && (action === "up" || action === "down")) {
        this.helpIndex = (this.helpIndex + (action === "up" ? -1 : 1) + PLAYBOOK_LIST.length) % PLAYBOOK_LIST.length;
      } else if (this.inspecting === "card" && ["up", "down", "left", "right"].includes(action)) {
        // Other cards: the inspector follows the cursor.
        this.perform(action, cx);
        this.inspect(cx);
      }
      cx.notify();
      cx.stop_propagation();
      return;
    }
    const action = KEYS[event.keystroke];
    if (!action) return;
    this.perform(action, cx);
    cx.stop_propagation();
  }

  perform(action, cx) {
    const { lanes, col } = this;
    const row = this.rows[col];
    const card = this.selected();
    const newCard = () => this.startEdit({ kind: "card", col, row: null }, "", cx);
    const editSelected = () => card != null && this.startEdit({ kind: "card", col, row }, card, cx);
    switch (action) {
      case "left": return this.moveCursor(-1, 0, cx);
      case "right": return this.moveCursor(1, 0, cx);
      case "up": return this.moveCursor(0, -1, cx);
      case "down": return this.moveCursor(0, 1, cx);
      case "shift-left": return this.apply(shiftCard(lanes, col, row, -1), cx);
      case "shift-right": return this.apply(shiftCard(lanes, col, row, 1), cx);
      case "shift-up": return this.apply(reorderCard(lanes, col, row, -1), cx);
      case "shift-down": return this.apply(reorderCard(lanes, col, row, 1), cx);
      case "new": return newCard();
      case "edit": return editSelected();
      case "open-card": return card != null ? editSelected() : newCard();
      case "delete": return this.apply(removeCard(lanes, col, row), cx);
      case "undo": return this.travel("undo", "redo", cx);
      case "redo": return this.travel("redo", "undo", cx);
      case "prev-board": return this.cycleBoard(-1, cx);
      case "next-board": return this.cycleBoard(1, cx);
      case "new-board": return this.startEdit({ kind: "board" }, "", cx);
      case "project-board": return this.project && this.createBoard(this.project.name, cx);
      case "delete-board":
        return this.askFor({ prompt: `Delete board "${this.board}"?`, yes: "delete", danger: true, run: (cx) => this.deleteBoard(cx) }, cx);
      case "open-diff": return card != null && this.openDiff(card);
      case "link": return card != null && this.linkBranch(card, cx);
      case "open-pr": return card != null && this.askPullRequest(card, cx);
      case "start-work": return card != null && this.askStartWork(card, cx);
      case "babysit": return card != null && this.askBabysit(card, cx);
      case "fix-ci": return card != null && this.fixCi(card, cx);
      case "go-to-agent": return card != null && this.goToAgent(card);
      case "archive": return this.askArchive(cx);
      case "palette": return this.openPalette(cx);
      case "inspect":
        if (card == null) return;
        this.inspecting = "card";
        return this.inspect(cx);
      case "help": this.inspecting = "help"; return cx.notify();
      case "notes": return this.showNotesPage(cx);
      case "import-issues": return this.askImport(cx);
      case "close": return props()?.overlay && closeOverlay(props().overlay);
      default: {
        const column = action.match(/^column-(\d)$/);
        if (column) this.moveCursor(Number(column[1]) - 1 - col, 0, cx);
      }
    }
  }

  // Puts a question on the hint line; y runs it, any other key drops it.
  askFor(ask, cx) {
    this.ask = ask;
    cx.notify();
  }

  // Links: a card's pull request or branch opens in snappy-diff.

  repoFor(board) {
    return this.repos[board] ?? (board === this.project?.name ? this.project.root : null);
  }

  async rememberRepo(board, folder) {
    if (this.repos[board] === folder) return;
    const before = await readTextFile(REPOS).catch(() => null);
    this.repos = { ...this.repos, [board]: folder };
    await writeTextFile(REPOS, JSON.stringify(this.repos, null, 2), before).catch(() => {});
  }

  // A board's repository when it hasn't been opened from inside it: a git repository named
  // like the board, inside or next to the current project (~/code/app's board "api" finds
  // ~/code/api, and a folder of projects that is itself a repository finds its children).
  async findRepo(board) {
    const root = this.project?.root;
    if (this.repoFor(board) || !root) return this.repoFor(board);
    const parent = root.slice(0, root.lastIndexOf("/"));
    for (const folder of [`${root}/${board}`, `${parent}/${board}`]) {
      if (!(await isRepository(folder))) continue;
      await this.rememberRepo(board, folder);
      return folder;
    }
    return null;
  }

  // A card's links, each number with what GitHub said about it: { refs, branch, pr, issue }.
  linksOf(card) {
    const links = card == null ? null : cardLinks(card);
    if (!links) return null;
    const repo = this.repoFor(this.board);
    const refs = links.refs.map((r) => ({ ...r, status: repo ? this.statuses.get(`${repo}#${r.n}`) ?? null : null }));
    const is = (kind) => (r) => r.kind === kind || (r.kind === null && r.status?.kind === kind);
    return { ...links, refs, pr: refs.find(is("pr")) ?? null, issue: refs.find(is("issue")) ?? null };
  }

  // The branch a card's work happens on: its own, or its pull request's head.
  branchOf(card) {
    const links = this.linksOf(card);
    return cardBranch(links, links?.pr?.status);
  }

  // g: the card's pull request or branch in snappy-diff; an issue alone opens in the browser.
  openDiff(card) {
    const links = this.linksOf(card);
    if (!links) return;
    const repo = this.repoFor(this.board);
    if (!repo) { notify(NO_REPO); return; }
    const branch = this.branchOf(card);
    if (!links.pr && !branch) {
      if (links.issue) showIssue(repo, links.issue.n);
      return;
    }
    openOverlay({
      mod: "snappy-diff", kind: "dialog", modal: true, width: 0.96, height: 0.92,
      props: links.pr ? { repo, pr: links.pr.n } : { repo, head: branch },
    });
  }

  // @: links the card to the branch its board's repository is on, and to that branch's pull
  // request when it has one.
  linkBranch(card, cx) {
    const { col } = this;
    const row = this.rows[col];
    const repo = this.repoFor(this.board);
    if (!repo) return;
    cx.spawn(async (cx) => {
      const pr = await currentPullRequest(repo);
      let text = withLink(card, `@${await currentBranch(repo)}`);
      if (pr) text = withLink(text, `#${pr}`);
      this.apply(editCard(this.lanes, col, row, text), cx);
    });
  }

  // GitHub: what each number on the board is, cards that follow it, and opening pull requests.

  // Asks gh about every number on the open board: a pull request, else an issue. Then moves the
  // cards that should follow: merged or completed to ship, an open pull request to review.
  async syncStatuses(cx) {
    const repo = await this.findRepo(this.board);
    if (!repo) return;
    const refs = new Map();
    for (const card of this.lanes.flat()) for (const r of cardLinks(card)?.refs ?? []) if (!refs.has(r.n) || r.kind) refs.set(r.n, r.kind);
    for (const [n, status] of await statusesOf(repo, [...refs])) this.statuses.set(`${repo}#${n}`, status);
    this.followStatuses(cx);
    cx.notify();
  }

  followStatuses(cx) {
    const moves = [];
    const lanes = this.lanes.map((lane) => [...lane]);
    const columns = { review: COLUMNS.indexOf("Review"), ship: COLUMNS.indexOf("Ship") };
    this.lanes.forEach((lane, col) => lane.forEach((card) => {
      const links = this.linksOf(card);
      const ref = links?.pr ?? links?.issue;
      const to = ref?.status && columnFor(ref.status, col, columns);
      if (to == null) return;
      lanes[col].splice(lanes[col].indexOf(card), 1);
      lanes[to].push(card);
      moves.push(`#${ref.n} → ${COLUMNS[to].toLowerCase()}`);
    }));
    if (!moves.length) return;
    this.remember();
    this.lanes = lanes;
    this.clampRows();
    this.save(cx);
    notify({ title: "Board updated from GitHub", body: moves.join(", "), level: "info", timeout: 4000 });
  }

  // o: push the card's branch (or the current one) and open a pull request titled like the
  // card, closing its issue if it has one. Asks first, since both are seen by others.
  askPullRequest(card, cx) {
    const links = this.linksOf(card);
    if (links?.pr) { notify({ title: `Already linked to #${links.pr.n}`, level: "info", timeout: 2500 }); return; }
    const repo = this.repoFor(this.board);
    if (!repo) return;
    const { col } = this;
    const row = this.rows[col];
    cx.spawn(async (cx) => {
      const branch = this.branchOf(card) ?? (await currentBranch(repo));
      if (!branch || branch === "HEAD" || ["main", "master"].includes(branch)) {
        notify({ title: "No branch to open a pull request from", body: "Start work on the card, link it to a branch, or switch to one.", level: "warning" });
        return;
      }
      const title = withoutLinks(card);
      const issue = links?.issue?.n ?? null;
      this.askFor({
        prompt: `Push ${branch} and open a pull request "${title}"?`, yes: "open",
        run: (cx) => this.openPullRequest({ col, row, branch, repo, title, issue }, cx),
      }, cx);
    });
  }

  openPullRequest({ col, row, branch, repo, title, issue }, cx) {
    cx.spawn(async (cx) => {
      const pushError = await push(repo, branch);
      if (pushError !== null) { notify({ title: `Couldn't push ${branch}`, body: pushError, level: "error" }); return; }
      const opened = await createPullRequest(repo, branch, title, issue ? `Closes #${issue}` : "");
      if (opened.error !== undefined) { notify({ title: "Couldn't open the pull request", body: opened.error, level: "error" }); return; }
      notify({ title: `Opened pull request #${opened.number}`, body: title, level: "success", timeout: 4000 });
      const card = this.lanes[col][row];
      if (card == null || withoutLinks(card) !== title) return; // the board moved on; the pull request still exists
      this.apply(editCard(this.lanes, col, row, withLink(card, `#${opened.number}`)), cx);
      await this.syncStatuses(cx);
    });
  }

  // Working on cards: start an agent on a card, and follow the agents working on them.

  // The first installed agent, or a toast saying there is none.
  async agentToStart() {
    const picked = await pickAgent();
    if (!picked) notify({ title: "No agent to start", body: "Install one Herdr knows, like Claude Code or Codex.", level: "warning" });
    return picked;
  }

  // The folder checked out on branch, or a toast saying why there isn't one.
  async checkoutOrSay(repo, branch) {
    const { folder, error } = await checkout(repo, branch);
    if (!folder) notify({ title: `Couldn't make a worktree for ${branch}`, body: error, level: "error" });
    return folder ?? null;
  }

  // s: a worktree on a branch named after the card, a space there with an agent that gets the
  // card (and its issue) as its task, the card linked to the branch and moved to work. Asks first.
  // Claude Code with pstack gets the card through poteto-mode, with the card's playbook.
  askStartWork(card, cx) {
    const repo = this.repoFor(this.board);
    if (!repo) { notify(NO_REPO); return; }
    const { col } = this;
    const row = this.rows[col];
    const branch = this.branchOf(card) ?? branchFor(withoutLinks(card));
    const issue = this.linksOf(card)?.issue?.n ?? null;
    cx.spawn(async (cx) => {
      const picked = await this.agentToStart();
      if (!picked) return;
      const { agent, pstack } = picked;
      const playbook = pstack ? ` with pstack ${playbookOf(withoutLinks(card)).playbook ?? "poteto-mode"}` : "";
      this.askFor({
        prompt: `Start ${agent.name ?? "an agent"}${playbook} on ${branch} in a new worktree?`, yes: "start",
        run: (cx) => this.startWork({ col, row, card, branch, repo, issue, agent, pstack }, cx),
      }, cx);
    });
  }

  startWork({ col, row, card, branch, repo, issue, agent, pstack }, cx) {
    cx.spawn(async (cx) => {
      const folder = await this.checkoutOrSay(repo, branch);
      if (!folder) return;
      const title = withoutLinks(card);
      const { playbook, title: task } = playbookOf(title);
      run("space.new", { name: task.slice(0, 40), folder, argv: agent.run, task: taskFor(title, issue, pstack) });
      if (playbook) await this.recordRun(branch, playbook);
      const work = COLUMNS.indexOf("Work");
      const linked = cardLinks(card)?.branch ? card : withLink(card, `@${branch}`);
      const lanes = this.lanes.map((lane) => [...lane]);
      const at = lanes[col].indexOf(card);
      if (at < 0) return; // the board moved on; the work started anyway
      lanes[col].splice(at, 1);
      lanes[work].push(linked);
      this.apply({ lanes, col: work, row: lanes[work].length - 1 }, cx);
      notify({ title: `Started ${title}`, body: `${agent.name ?? "Agent"} on ${branch}`, level: "success", timeout: 3000 });
    });
  }

  // ⇧B: an agent on the card's pull request, in its branch's checkout, with pstack's Babysit
  // playbook: driven to merge-ready when conflicts, changes requested or failing checks block
  // it, else one status pass. One babysitter per branch, so not while an agent is on it. Asks first.
  askBabysit(card, cx) {
    const repo = this.repoFor(this.board);
    const pr = this.linksOf(card)?.pr;
    const sit = pr ? babysitFor(pr.n, pr.status) : null;
    const branch = this.branchOf(card);
    if (!repo || !sit || !branch) {
      notify({ title: "Nothing to babysit", body: "The card needs an open pull request.", level: "warning", timeout: 3000 });
      return;
    }
    const busy = this.agentOf(card);
    if (busy) {
      notify({ title: `${busy.name} is already on ${branch}`, body: "One agent per pull request.", level: "warning", timeout: 3000 });
      return;
    }
    cx.spawn(async (cx) => {
      const picked = await this.agentToStart();
      if (!picked) return;
      const { agent, pstack } = picked;
      const why = sit.blockers.length ? ` (${sit.blockers.join(", ")})` : "";
      const how = sit.mode === "drive" ? `to merge-ready${why}` : "for one status check";
      this.askFor({
        prompt: `Babysit #${sit.number} ${how} with ${agent.name ?? "an agent"}${pstack ? " and pstack" : ""}?`, yes: "babysit",
        run: (cx) => this.babysit({ card, branch, repo, sit, agent, pstack }, cx),
      }, cx);
    });
  }

  babysit({ card, branch, repo, sit, agent, pstack }, cx) {
    cx.spawn(async () => {
      const folder = await this.checkoutOrSay(repo, branch);
      if (!folder) return;
      run("space.new", { name: `Babysit #${sit.number}`, folder, argv: agent.run, task: babysitTask(sit, withoutLinks(card), pstack) });
      await this.recordRun(branch, "Babysit");
      notify({ title: `Babysitting #${sit.number}`, body: `${agent.name ?? "Agent"} on ${branch}, ${sit.mode}`, level: "success", timeout: 3000 });
    });
  }

  // Runs: the playbook a card's agent follows and the steps it reported (`kanban step`).

  // The board names the playbook when it starts an agent, so its steps show at once.
  async recordRun(branch, playbook) {
    const path = runsOf(this.board);
    await exec("mkdir", ["-p", `${DIR}/.runs`]);
    const text = await readTextFile(path).catch(() => null);
    const runs = recordPlaybook(parseRuns(text), branch, playbook, new Date().toISOString());
    // An agent that wrote meanwhile wins; its next step brings the playbook back anyway.
    await writeTextFile(path, JSON.stringify(runs, null, 2), text).then(() => { this.runs = runs; }, () => {});
  }

  // A card's run and its playbook: { run, book, planned }. Without a run, the playbook its
  // prefix picks is planned.
  runOf(card) {
    const branch = this.branchOf(card);
    const run = branch ? this.runs[branch] ?? null : null;
    const book = playbookNamed(run?.playbook) ?? playbookNamed(playbookOf(withoutLinks(card)).playbook);
    return { run, book, planned: !run?.playbook };
  }

  // Shows the selected card's run, and loads what it needs from its agent and branch.
  inspect(cx) {
    this.detail = null;
    cx.spawn(async (cx) => { await this.loadDetail(); cx.notify(); });
    if (!this.setup) cx.spawn((cx) => this.loadSetup(cx));
    cx.notify();
  }

  // Opens the inspector on the first card whose text holds `query`, for a mod opened with props
  // { view: "inspect", card }.
  async inspectCard(query, cx) {
    await this.refresh(cx);
    const q = String(query ?? "").toLowerCase();
    const col = this.lanes.findIndex((lane) => lane.some((c) => c.toLowerCase().includes(q)));
    if (!q || col < 0) return;
    this.col = col;
    this.rows[col] = this.lanes[col].findIndex((c) => c.toLowerCase().includes(q));
    this.inspecting = "card";
    await this.loadDetail();
    cx.notify();
  }

  // The inspected card's agent's last message and the commits on its branch.
  async loadDetail() {
    const card = this.selected();
    const branch = card != null ? this.branchOf(card) : null;
    const repo = this.repoFor(this.board);
    if (!branch || !repo) { this.detail = null; return; }
    const cwd = this.agentOf(card)?.cwd;
    const message = cwd ? await lastAgentMessage(cwd) : null;
    this.detail = { branch, message, commits: await commitsAhead(repo, branch) };
  }

  // Agents by branch, read live: render runs again whenever Herdr's agents change.
  agentOf(card) {
    const branch = this.branchOf(card);
    return branch ? this.agentMap?.get(branch) ?? null : null;
  }

  // An agent that stops working on a card's branch means the card is ready for review, on any
  // board. The toast opens its diff.
  noticeFinished(cx) {
    const now = agentsByBranch(agents(), panes());
    const done = finished(this.agentsBefore, now);
    this.agentsBefore = now;
    this.nameTab(now);
    if (done.length) cx.spawn(async () => this.announceFinished(done, now));
  }

  // The tab's name says when agents on the board's cards need you, so it shows from any tab.
  nameTab(agentsNow) {
    const waiting = new Set(this.lanes.flat().map((card) => this.branchOf(card)).filter((b) => agentsNow.get(b)?.status === "blocked"));
    const name = waiting.size ? `Board · ${waiting.size} needs you` : "Board";
    if (name === this.tabName) return;
    const tab = panes().find((p) => p.mod === "kanban-md")?.tab;
    if (!tab) return;
    this.tabName = name;
    run("tab.rename", { id: tab, name });
  }

  // t: the card's agent, in whichever space and tab it is.
  goToAgent(card) {
    const agent = this.agentOf(card);
    if (agent) run("agent.focus", { terminal: agent.address });
    else notify({ title: "No agent on this card", body: "s starts one.", level: "info", timeout: 2500 });
  }

  async announceFinished(branches, now) {
    for (const branch of branches) {
      const found = await this.cardOnBranch(branch);
      if (!found) continue;
      const { card, repo, pr } = found;
      notify({
        title: `${withoutLinks(card)} is ready for review`, body: `${now.get(branch).name ?? "The agent"} finished on ${branch}`,
        level: "success", timeout: 8000,
        action: { name: "tab.new", args: { name: withoutLinks(card).slice(0, 30), mod: "snappy-diff", props: pr ? { repo, pr } : { repo, head: branch } } },
      });
    }
  }

  // The card working on `branch`, on the shown board or another: { card, repo, pr }.
  async cardOnBranch(branch) {
    const shown = this.lanes.flat().find((c) => this.branchOf(c) === branch);
    if (shown != null) {
      const repo = this.repoFor(this.board);
      return repo ? { card: shown, repo, pr: this.linksOf(shown)?.pr?.n } : null;
    }
    for (const board of this.boards) {
      const repo = this.repoFor(board);
      if (board === this.board || !repo) continue;
      const cards = parse(await readTextFile(fileOf(board)).catch(() => null)).flat();
      const prOf = (card) => cardLinks(card)?.refs.find((r) => r.kind !== "issue")?.n;
      const named = cards.find((c) => cardLinks(c)?.branch === branch);
      if (named != null) return { card: named, repo, pr: prOf(named) };
      // Another board's pull requests aren't followed: ask gh which one is on the branch.
      if (!cards.some(prOf)) continue;
      const n = await pullRequestFrom(repo, branch);
      const linked = n ? cards.find((c) => prOf(c) === n) : null;
      if (linked != null) return { card: linked, repo, pr: n };
    }
    return null;
  }

  // f: a card whose pull request's checks fail sends the failing step of the failed job's log to
  // the agent on its branch, to find the cause and fix it.
  fixCi(card, cx) {
    const pr = this.linksOf(card)?.pr;
    const repo = this.repoFor(this.board);
    if (!pr || !repo) return;
    if (pr.status?.checks !== "failing") {
      notify({ title: `#${pr.n} has no failing checks`, level: "info", timeout: 2500 });
      return;
    }
    const agent = this.agentOf(card);
    if (!agent) {
      notify({ title: "No agent on this card's branch", body: "s starts one; then f sends it the failure.", level: "warning" });
      return;
    }
    cx.spawn(async () => {
      const { failed, log, error } = await failedRun(repo, pr.n);
      if (error !== undefined) { notify({ title: "Couldn't read the failed log", body: error, level: "error" }); return; }
      if (!failed.length) { notify({ title: `Couldn't find #${pr.n}'s failed run`, body: "Its failing checks may not run on GitHub Actions.", level: "warning" }); return; }
      const sent = await hc(["send", agent.address, ciPrompt(pr.n, failed, log)]);
      if (sent.code === 0) notify({ title: `Sent #${pr.n}'s CI failure to ${agent.name}`, body: failed.map((c) => c.name).join(", "), level: "success", timeout: 3000 });
      else notify({ title: `Couldn't send to ${agent.name}`, body: (sent.stderr || sent.stdout).trim().split("\n").pop(), level: "error" });
    });
  }

  // ⇧I: the repository's open issues into Ideas, once each. Asks first, saying how many.
  askImport(cx) {
    const repo = this.repoFor(this.board);
    if (!repo) { notify(NO_REPO); return; }
    cx.spawn(async (cx) => {
      const issues = await openIssues(repo);
      if (!issues) {
        notify({ title: "Couldn't list the issues", body: "Is the GitHub CLI (gh) installed and signed in?", level: "error" });
        return;
      }
      const { added } = importIssues(this.lanes, issues);
      if (!added.length) {
        notify({ title: "No new issues", body: `All ${issues.length} open issues are on the board already.`, level: "info", timeout: 3000 });
        return;
      }
      this.askFor({ prompt: `Add ${plural(added.length, "open issue")} to Ideas?`, yes: "add", run: (cx) => this.importIssues(issues, cx) }, cx);
    });
  }

  importIssues(issues, cx) {
    const { lanes, added } = importIssues(this.lanes, issues); // against the board as it is now
    if (!added.length) return;
    this.apply({ lanes, col: 0, row: lanes[0].length - 1 }, cx);
    notify({ title: `Added ${plural(added.length, "issue")} to Ideas`, body: added.slice(0, 3).join(", ") + (added.length > 3 ? "…" : ""), level: "success", timeout: 3000 });
  }

  // Archive: shipped cards off the board, into ~/kanban/.archive/<board>.md under the day.

  // ⇧A: asks first, saying how many.
  askArchive(cx) {
    const shipped = this.lanes[COLUMNS.length - 1].length;
    if (!shipped) { notify({ title: "Nothing shipped to archive", level: "info", timeout: 2500 }); return; }
    this.askFor({ prompt: `Archive ${plural(shipped, "shipped card")}?`, yes: "archive", run: (cx) => this.archiveShipped(cx) }, cx);
  }

  archiveShipped(cx) {
    const ship = COLUMNS.length - 1;
    const board = this.board;
    const cards = this.lanes[ship];
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", ARCHIVE]);
      const before = await readTextFile(archiveOf(board)).catch(() => null);
      const text = archiveCards(before, board, cards, localDay());
      const written = await writeTextFile(archiveOf(board), text, before).then(() => true, () => false);
      if (!written) { notify({ title: "Couldn't write the archive", body: "It changed meanwhile; try again.", level: "error" }); return; }
      notify({ title: `Archived ${plural(cards.length, "card")}`, body: `~/kanban/.archive/${board}.md`, level: "success", timeout: 3000 });
      if (board !== this.board) return; // the board changed meanwhile: its cards stay, archived
      this.archived = parseArchive(text);
      const lanes = this.lanes.map((lane, i) => (i === ship ? lane.filter((card) => !cards.includes(card)) : lane));
      this.apply({ lanes, col: this.col, row: this.rows[this.col] }, cx);
    });
  }

  async loadArchive(cx) {
    const board = this.board;
    const archived = parseArchive(await readTextFile(archiveOf(board)).catch(() => null));
    if (board === this.board) this.archived = archived;
    cx.notify();
  }

  showArchivePage(cx) {
    this.view = "archive";
    this.inspecting = null;
    this.handle.focus();
    cx.spawn((cx) => this.loadArchive(cx));
    cx.notify();
  }

  // Setup: what agents work with for the board's project and everywhere (setup-page.js).

  showSetupPage(cx) {
    this.view = "setup";
    this.inspecting = null;
    this.handle.focus();
    cx.spawn((cx) => this.loadSetup(cx));
    cx.notify();
  }

  async loadSetup(cx) {
    const board = this.board;
    const root = this.repoFor(board);
    const [project, everywhere, editor] = await Promise.all([root ? projectSetup(root) : null, everywhereSetup(), this.pickedEditor()]);
    if (board !== this.board) return;
    this.editor = editor;
    this.setup = { root, project, everywhere };
    this.setupIndex = Math.min(this.setupIndex, Math.max(0, setupItems(this.setup).length - 1));
    cx.notify();
  }

  // ↑↓ move through the rows, ←→ between the columns, enter or o opens the row's file.
  setupKey(key, cx) {
    const items = setupItems(this.setup);
    const action = KEYS[key];
    if (key === "enter" || key === "o") {
      this.openSetupItem(this.setupIndex, cx);
      return true;
    }
    if (!items.length || !["up", "down", "left", "right"].includes(action)) return false;
    if (action === "up" || action === "down") {
      this.setupIndex = Math.max(0, Math.min(items.length - 1, this.setupIndex + (action === "up" ? -1 : 1)));
    } else {
      const side = action === "left" ? "project" : "everywhere";
      const first = items.findIndex((e) => e.side === side);
      if (first >= 0 && items[this.setupIndex]?.side !== side) this.setupIndex = first;
    }
    const selected = items[this.setupIndex];
    const c = selected.side === "project" ? 0 : 1;
    this.setupScrolls[c].scroll_to_item(columnRows(items, selected.side).findIndex((r) => r.index === this.setupIndex), "center");
    cx.notify();
    return true;
  }

  // Opens the row's file in the editor picked in snappy-diff's settings, as snappy-diff does.
  openSetupItem(index, cx) {
    const path = setupItems(this.setup)[index]?.item.path;
    this.setupIndex = index;
    if (path) cx.open_url(`${this.editor ?? "zed"}://file${encodeURI(path)}`);
    cx.notify();
  }

  // The editor picked in snappy-diff's settings: "zed" (its default), "vscode" or "cursor".
  async pickedEditor() {
    try { return JSON.parse(await readTextFile(`${appHome()}/data/snappy-diff/prefs.json`)).editor || "zed"; } catch { return "zed"; }
  }

  // Go to (⌘K, /), like snappy-diff's: cards on this board, then on the others while typing,
  // boards and actions. ↑↓ pick, enter goes, esc closes.

  openPalette(cx) {
    this.palette = true;
    this.paletteIndex = 0;
    this.paletteInput.set_value("");
    this.paletteInput.focus();
    cx.spawn(async (cx) => {
      this.everything = await Promise.all(this.boards.map(async (board) => ({ board, lanes: parse(await readTextFile(fileOf(board)).catch(() => null)) })));
      cx.notify();
    });
    cx.notify();
  }

  // The board's columns, on `board` with the cursor on `at` ({ col, row }) or its first card.
  goToCard(board, at, cx) {
    this.inspecting = null;
    this.showBoard(cx);
    this.openBoard(board, cx, at);
  }

  closePalette(cx) {
    this.palette = false;
    this.focusBoard();
    cx.notify();
  }

  paletteResults() {
    const query = this.paletteInput.value().trim();
    const hit = (text) => !query || matches(text, query);
    const cardsOf = (board, lanes) => lanes.flatMap((lane, col) => lane.map((card, row) => ({ board, card, col, row }))).filter(({ card }) => hit(card));
    const toCard = ({ board, card, col, row }) => ({
      label: withoutLinks(card), hint: board === this.board ? COLUMNS[col] : `${board} · ${COLUMNS[col]}`,
      run: (cx) => this.goToCard(board, { col, row }, cx),
    });
    const card = this.selected();
    const forCard = this.cardActions(card).map(({ key, label, action }) => ({ label: `${label}: ${withoutLinks(card)}`, hint: key, run: (cx) => this.perform(action, cx) }))
      .filter((r) => hit(r.label));
    const here = cardsOf(this.board, this.lanes).map(toCard);
    const elsewhere = !query ? [] : this.everything.filter((b) => b.board !== this.board).flatMap((b) => cardsOf(b.board, b.lanes)).slice(0, 40).map(toCard);
    const boards = this.boards.filter((b) => b !== this.board && hit(b))
      .map((b) => ({ label: b, hint: "board", run: (cx) => this.goToCard(b, null, cx) }));
    const offer = this.project && !this.boards.includes(this.project.name);
    const actions = [
      ["New card", "n", "new"],
      ["Notes", "⇧N", "notes"],
      ["Archive", "", (cx) => this.showArchivePage(cx)],
      ["Setup: instructions, skills, hooks, MCP", "", (cx) => this.showSetupPage(cx)],
      ["Archive shipped cards", "⇧A", "archive"],
      ["Import open issues", "⇧I", "import-issues"],
      ["Undo", "⌘Z", "undo"],
      ["Redo", "⌘⇧Z", "redo"],
      ["How it works, and every key", "?", "help"],
      ["New board", "b", "new-board"],
      ...(offer ? [[`Board for ${this.project.name}`, "p", "project-board"]] : []),
      ["Delete board", "⇧D", "delete-board"],
    ].filter(([label]) => hit(label))
      .map(([label, hint, action]) => ({ label, hint: hint || "action", run: typeof action === "function" ? action : (cx) => this.perform(action, cx) }));
    return [...forCard, ...here, ...elsewhere, ...boards, ...actions];
  }

  // What can be done with a card, the likeliest next step first: [{ key, label, action }].
  cardActions(card) {
    if (card == null) return [];
    const links = this.linksOf(card);
    const pr = links?.pr;
    const branch = this.branchOf(card);
    const agent = this.agentOf(card);
    const repo = this.repoFor(this.board);
    const actions = [
      ...(pr?.status?.checks === "failing" && agent ? [["f", "Fix CI", "fix-ci"]] : []),
      ...(agent ? [["t", "Go to agent", "go-to-agent"]] : repo ? [["s", "Start work", "start-work"]] : []),
      ...(repo && (pr || branch) ? [["g", "Open diff", "open-diff"]] : repo && links?.issue ? [["g", "Open issue", "open-diff"]] : []),
      ["i", "Inspect", "inspect"],
      ...(pr && babysitFor(pr.n, pr.status) && !agent ? [["⇧B", "Babysit", "babysit"]] : []),
      ...(repo && !pr ? [["o", "Open pull request", "open-pr"]] : []),
      ...(repo && !branch ? [["@", "Link branch", "link"]] : []),
      ["e", "Edit", "edit"],
      ["d", "Delete", "delete"],
    ];
    return actions.map(([key, label, action]) => ({ key, label, action }));
  }

  paletteKey(key, cx) {
    const results = this.paletteResults();
    if (key === "escape" || key === "cmd-k") this.closePalette(cx);
    else if (key === "enter") this.pickResult(results[this.paletteIndex], cx);
    else if (key === "down") this.paletteIndex = Math.min(results.length - 1, this.paletteIndex + 1);
    else if (key === "up") this.paletteIndex = Math.max(0, this.paletteIndex - 1);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  pickResult(result, cx) {
    if (!result) return;
    this.closePalette(cx);
    result.run(cx);
  }

  // Notes: a free page per board, saved as you type.

  showNotes(notes) {
    this.notes = notes;
    if (this.notesInput.value() !== notes) {
      this.settingNotes = true;
      this.notesInput.set_value(notes);
      this.settingNotes = false;
    }
  }

  showNotesPage(cx) {
    this.view = "notes";
    this.inspecting = null;
    this.notesInput.focus();
    cx.notify();
  }

  showBoard(cx) {
    this.view = "board";
    this.handle.focus();
    cx.notify();
  }

  // Saves a moment after the last keystroke, so typing doesn't write the file on every key.
  typeNotes(cx) {
    if (this.settingNotes) return;
    this.notes = this.notesInput.value();
    this.notesPending = true;
    const typed = ++this.notesTyped;
    cx.timer.after(NOTES_SAVE_MS, (cx) => {
      if (typed !== this.notesTyped) return;
      this.notesPending = false;
      this.save(cx);
      cx.notify();
    });
  }

  // View

  render() {
    if (this.launcher) return div();
    const t = theme();
    const font = settings().font_family;
    this.agentMap = agentsByBranch(agents(), panes());
    this.revealCursor();
    return v_flex().id("kanban").track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .size_full().px(18).pt(16).pb(12).gap(14).bg(t.canvas).text_color(t.foreground).text_size(13)
      .when(Boolean(font), (el) => el.font_family(font))
      .child(this.renderTop(t))
      .child(this.view === "notes" ? this.renderNotes(t) : this.view === "archive" ? this.renderArchive(t)
        : this.view === "setup" ? setupPage(t, { setup: this.setup, selected: this.setupIndex, scrolls: this.setupScrolls, pick: (i, cx) => this.openSetupItem(i, cx) })
        : this.inspecting ? this.renderInspector(t)
        : h_flex().flex_1().min_h(0).gap(12).children(COLUMNS.map((name, c) => this.renderColumn(t, name, c))))
      .child(this.renderHint(t))
      .when(this.palette, (el) => el.child(this.renderPalette(t)))
      // Measures the font's character width, which card wrapping is computed from.
      .child(div().id("probe").absolute().top(-100).left(0).opacity(0).whitespace_nowrap().text_size(TEXT_SIZE)
        .when(Boolean(font), (el) => el.font_family(font))
        .on_size_change((size, cx) => {
          const width = unzoom(size.width) / 100;
          if (width > 0 && Math.abs(width - this.charW) > 0.01) { this.charW = width; cx.notify(); }
        })
        .child("0".repeat(100)));
  }

  // Keeps the cursor's card on screen: scrolls its column when the cursor or the board changes.
  revealCursor() {
    const row = this.editing?.kind === "card" && this.editing.row === null ? this.lanes[this.col].length : this.rows[this.col];
    // The column's length too: the first render comes before the board's file is read.
    const key = `${this.board}|${this.col}|${row}|${this.lanes[this.col].length}`;
    if (key === this.revealed) return;
    this.revealed = key;
    this.scrolls[this.col].scroll_to_item(Math.max(0, row), "top");
  }

  cardCols(agent = null) {
    return Math.max(8, Math.floor((this.columnW - CARD_INSET - markWidth(agent)) / this.charW));
  }

  // The room chips have in a card.
  chipWidth() {
    return Math.max(80, this.columnW - CARD_INSET);
  }

  chipsOf(t, card, done) {
    return chipsOf(t, this.linksOf(card), this.runOf(card), this.charW, done);
  }

  // Board tabs on the left, progress on the right.
  renderTop(t) {
    const editingName = this.editing?.kind === "board";
    const segment = (id, label, active, onClick) => h_flex().id(id).h(26).px(10).gap(6).items_center().rounded(6).cursor_pointer()
      .text_color(active ? t.foreground : t.muted).when(active, (el) => el.bg(t.raised))
      .hover((s) => s.text_color(t.foreground))
      .on_click(onClick)
      .child(label);
    const group = () => h_flex().p(3).gap(2).items_center().rounded(8).border_1().border_color(t.border).bg(t.background);
    const tab = (board) => segment(`board-${board}`, board, board === this.board, (_e, cx) => { this.openBoard(board, cx); this.handle.focus(); })
      .when(board === this.project?.name, (el) => el.child(div().size(5).rounded(3).bg(t.accent)));
    const add = h_flex().id("board-new").h(26).w(26).justify_center().items_center().rounded(6).cursor_pointer()
      .text_color(t.dim).hover((s) => s.text_color(t.foreground).bg(t.hover))
      .on_click((_e, cx) => this.startEdit({ kind: "board" }, "", cx))
      .child("+");
    const total = this.lanes.reduce((n, lane) => n + lane.length, 0);
    const shipped = this.lanes[COLUMNS.length - 1].length;
    return h_flex().items_center().gap(12)
      .child(group()
        .children(this.boards.map(tab))
        .child(editingName ? div().w(160).child(this.renderInput(t, "new-board")) : add))
      .child(group()
        .child(segment("view-board", "Board", this.view === "board", (_e, cx) => this.showBoard(cx)))
        .child(segment("view-notes", "Notes", this.view === "notes", (_e, cx) => this.showNotesPage(cx))
          .when(Boolean(this.notes.trim()), (el) => el.child(div().size(5).rounded(3).bg(t.dim))))
        .child(segment("view-archive", "Archive", this.view === "archive", (_e, cx) => this.showArchivePage(cx)))
        .child(segment("view-setup", "Setup", this.view === "setup", (_e, cx) => this.showSetupPage(cx))))
      .child(div().flex_1())
      .when(total > 0, (el) => el.child(h_flex().gap(10).items_center().text_size(11.5).text_color(t.dim)
        .child(`${shipped}/${total} shipped`)
        .child(div().w(96).h(4).rounded(2).bg(t.border)
          .child(div().h_full().rounded(2).bg(t.ansi2).w(Math.round((96 * shipped) / total))))));
  }

  renderColumn(t, name, c) {
    const active = c === this.col;
    const cards = this.lanes[c];
    const adding = this.editing?.kind === "card" && this.editing.col === c && this.editing.row === null;
    const tint = t[COLUMN_TINTS[c]];
    const items = cards.map((text, r) => ({ text, r })).concat(adding ? [{ input: true }] : []);
    const sizes = items.map((item) => {
      const editingThis = this.editing?.kind === "card" && this.editing.col === c && this.editing.row === item.r;
      if (item.input || editingThis) return INPUT_H + CARD_GAP;
      const lines = wrapText(withoutLinks(item.text), this.cardCols(this.agentOf(item.text))).length;
      return cardHeight(lines, chipLayout(this.chipsOf(t, item.text, false).map((chip) => chip.width), this.chipWidth()).length);
    });
    return v_flex().id(`col-${c}`).flex_1().min_w(0).h_full().rounded(10).border_1()
      .border_color(active ? alpha(t.accent, "66") : t.border).bg(t.background)
      .when(c === 0, (el) => el.on_size_change((size, cx) => {
        const width = unzoom(size.width);
        if (Math.abs(width - this.columnW) > 1) { this.columnW = width; cx.notify(); }
      }))
      .on_mouse_down("left", (e) => { this.pressCount = e.click_count; })
      .on_click((_e, cx) => { if (!active) { this.col = c; this.handle.focus(); cx.notify(); } })
      .child(h_flex().px(12).pt(12).pb(10).gap(8).items_center()
        .child(div().size(8).rounded(4).bg(tint))
        .child(div().flex_1().text_size(12.5).font_semibold().text_color(active ? t.foreground : t.muted).child(name))
        .child(div().px(7).py(1).rounded(8).bg(t.raised).text_size(11).text_color(t.dim).child(String(cards.length))))
      .when(!items.length, (el) => el.child(div().mx(12).py(14).flex().justify_center().rounded(8)
        .border_1().border_color(alpha(t.border, "99")).text_size(12).text_color(t.dim)
        .child(active ? "n to add a card" : "No cards")))
      .when(items.length > 0, (el) => el.child(div().flex_1().min_h(0).relative().px(8).pb(2)
        .child(v_virtual_list(`cards-${c}`, items.length, sizes, (i) => (items[i].input ? "new" : `card-${items[i].r}`), (range) =>
          items.slice(range.start, range.end).map((item, i) => div().h(sizes[range.start + i]).pb(CARD_GAP)
            .child(item.input ? this.renderInput(t, `new-${c}`) : this.renderCard(t, c, item.r, item.text))))
          .track_scroll(this.scrolls[c]).size_full()
          .on_item_click((key, cx) => {
            if (!key.startsWith("card-")) return;
            const r = Number(key.slice(5));
            this.col = c;
            this.rows[c] = r;
            if (this.pressCount > 1) this.startEdit({ kind: "card", col: c, row: r }, this.lanes[c][r], cx);
            else { this.handle.focus(); cx.notify(); }
          }))
        .child(Scrollbar.vertical(`cards-${c}`).absolute().inset_0())));
  }

  renderCard(t, c, r, text) {
    const editing = this.editing;
    if (editing?.kind === "card" && editing.col === c && editing.row === r) return this.renderInput(t, `edit-${c}-${r}`);
    const selected = !editing && c === this.col && r === this.rows[c];
    const done = c === COLUMNS.length - 1;
    const agent = this.agentOf(text);
    return v_flex().relative().px(12).py(PAD_Y).gap(CHIPS_GAP).rounded(8).border_1().cursor_pointer()
      .border_color(selected ? t.accent : t.border).bg(selected ? t.selected : t.raised)
      .hover((s) => s.border_color(selected ? t.accent : t.input))
      .child(v_flex().text_color(done ? t.muted : t.foreground).children(wrapText(withoutLinks(text), this.cardCols(agent)).map((line) =>
        h_flex().h(LINE_H).items_center().whitespace_nowrap().child(line))))
      .when(Boolean(cardLinks(text)), (el) => el.child(chipRowsView(t, this.chipsOf(t, text, done), this.chipWidth())))
      // The agent's status sits at the end of the first line, where it can't be pushed out.
      .when(Boolean(agent), (el) => el.child(h_flex().absolute().top(PAD_Y + 1).right(10).h(LINE_H).items_center()
        .child(agentMark(t, agent))));
  }

  renderInput(t, id) {
    return div().id(id).h(INPUT_H).px(12).flex().items_center().rounded(8).bg(t.background)
      .border_1().border_color(t.accent)
      .child(Input.new(this.input).w_full().text_color(t.foreground));
  }

  renderNotes(t) {
    const font = settings().font_family;
    return v_flex().flex_1().min_h(0).rounded(10).border_1().border_color(t.border).bg(t.background)
      .child(h_flex().px(16).pt(12).pb(10).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().size(8).rounded(4).bg(t.accent))
        .child(div().flex_1().text_size(12.5).font_semibold().child(`${this.board} notes`))
        .child(div().text_size(11).text_color(t.dim).child(this.notesPending ? "saving…" : `~/kanban/${this.board}.md`)))
      .child(div().flex_1().min_h(0).p(16)
        .child(Textarea.new(this.notesInput).size_full().text_size(13).text_color(t.foreground)
          .when(Boolean(font), (el) => el.font_family(font))));
  }

  // The board's archived cards, newest day first, read-only.
  renderArchive(t) {
    const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    return v_flex().flex_1().min_h(0).rounded(10).border_1().border_color(t.border).bg(t.background)
      .child(h_flex().px(16).pt(12).pb(10).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().size(8).rounded(4).bg(t.ansi2))
        .child(div().flex_1().text_size(12.5).font_semibold().child(`${this.board} archive`))
        .child(div().text_size(11).text_color(t.dim).child(`~/kanban/.archive/${this.board}.md`)))
      .child(v_flex().id("archive").flex_1().min_h(0).overflow_y_scroll().px(16).py(14).gap(18)
        .when(!this.archived.length, (el) => el.child(div().text_size(12).text_color(t.dim).child("Nothing archived yet. ⇧A on the board archives the shipped cards.")))
        .children(this.archived.map(({ day: iso, cards }) => v_flex().gap(6)
          .child(h_flex().gap(8).items_center().child(sectionLabel(t, day(iso))).child(div().text_size(10.5).text_color(t.dim).child(String(cards.length))))
          .children(cards.map((card) => h_flex().gap(10).px(12).py(7).rounded(6).bg(t.raised).items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(withoutLinks(card)))
            .when(withoutLinks(card) !== card, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(card.slice(withoutLinks(card).length).trim()))))))));
  }

  // Go to, over the board: the typed query, then the results.
  renderPalette(t) {
    const results = this.paletteResults();
    return div().absolute().inset_0().flex().justify_center().bg(alpha(t.background, "99"))
      .on_mouse_down("left", (_e, cx) => this.closePalette(cx))
      .child(v_flex().id("palette").mt(80).w(600).max_h(460).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(h_flex().h(44).px(12).gap(10).items_center().border_b_1().border_color(t.border)
          .child(svg("mods/kanban-md/icons/search.svg").size(15).flex_none().text_color(t.dim))
          .child(div().flex_1().child(Input.new(this.paletteInput).w_full().text_size(14))))
        .child(v_flex().id("palette-results").max_h(400).overflow_y_scrollbar().p(6).gap(1)
          .when(!results.length, (el) => el.child(div().p(12).text_size(12.5).text_color(t.dim).child("Nothing matches.")))
          .children(results.slice(0, 120).map((r, i) => h_flex().id(`result-${i}`).h(32).px(10).gap(10).items_center().rounded(6).cursor_pointer()
            .when(i === this.paletteIndex, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.pickResult(r, cx))
            .child(div().flex_1().min_w(0).truncate().text_size(13).child(r.label))
            .child(div().flex_none().text_size(11.5).text_color(t.dim).child(r.hint))))));
  }

  // In place of the columns: the selected card's run (i), or the loop and every playbook (?).
  renderInspector(t) {
    if (this.inspecting === "help") return helpView(t, this.helpIndex, KEY_GUIDE);
    const card = this.selected();
    if (card == null) return div().flex_1().text_color(t.muted).child("No card selected.");
    const branch = this.branchOf(card);
    return cardRunView(t, {
      title: withoutLinks(card), col: this.col, ...this.runOf(card), agent: this.agentOf(card), branch,
      pr: this.linksOf(card)?.pr, detail: this.detail?.branch === branch ? this.detail : null,
      setup: setupSummary(this.setup?.project),
    });
  }

  // Keys as keycaps. Asks and the selected card's state come first, in words.
  renderHint(t) {
    const line = h_flex().h(22).gap(14).items_center().text_size(11.5).text_color(t.dim);
    if (this.palette) return line.child(keycaps(t, [["↑↓", "pick"], ["↵", "go"], ["esc", "close"]]));
    if (this.view === "notes") return line.child(keycaps(t, [["esc", "back to the board"]])).child("saved as you type");
    if (this.view === "archive") return line.child(keycaps(t, [["esc", "back to the board"]]));
    if (this.view === "setup") return line.child(keycaps(t, [["↑↓", "pick"], ["←→", "project or everywhere"], ["↵", "open in your editor"], ["esc", "back to the board"]]));
    if (this.inspecting === "help") return line.child(keycaps(t, [["↑↓", "playbook"], ["esc", "back to the board"]]));
    if (this.inspecting) return line.child(keycaps(t, [["←→↑↓", "other cards"], ["esc", "back to the board"]]));
    if (this.ask) {
      return line.child(div().text_color(this.ask.danger ? t.blocked : t.accent).child(this.ask.prompt))
        .child(keycaps(t, [["y", this.ask.yes], ["any key", "cancel"]]));
    }
    if (this.editing) return line.child(keycaps(t, [["↵", "save"], ["esc", "cancel"]]));
    // The selected card's state and its next steps on the left; the way to everything else on
    // the right.
    const card = this.selected();
    const links = card != null ? this.linksOf(card) : null;
    const ref = links?.pr ?? links?.issue;
    const agent = card != null ? this.agentOf(card) : null;
    const next = card == null ? [["n", "new card"]]
      : this.cardActions(card).filter((a) => !EVERY_CARD.has(a.action)).slice(0, 3).map((a) => [a.key, a.label.toLowerCase()]);
    const offer = this.project && !this.boards.includes(this.project.name) ? [["p", `board for ${this.project.name}`]] : [];
    const doing = { working: "is working", blocked: "needs you", done: "is ready for review", idle: "is idle" };
    return line
      .when(Boolean(agent), (el) => el.child(h_flex().gap(6).items_center().text_color(t.muted)
        .child(agentMark(t, agent)).child(`${agent.name ?? "Agent"} ${doing[agent.status] ?? agent.status}`)))
      .when(Boolean(ref?.status), (el) => el.child(div().text_color(t.muted).child(describe(ref.n, ref.status))))
      .child(keycaps(t, [...offer, ...next]))
      .child(div().flex_1())
      .child(keycaps(t, [["⌘K", "all actions"], ["?", "help"]]));
  }
}
