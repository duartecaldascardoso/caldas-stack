// kanban-md: plain-text kanban boards for Herdr, one markdown file per board in ~/kanban.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { home, props, openOverlay, closeOverlay, readTextFile, writeTextFile, exec, focused, notify, run, agents, panes, knownAgents, settings, theme } from "herdr";
import {
  COLUMNS, emptyLanes, parse, serialize, notesOf, boardName,
  addCard, editCard, removeCard, shiftCard, reorderCard, cardLinks, withoutLinks, withLink,
} from "./board.js";
import { prStatus, issueStatus, columnFor, describe, numberFromUrl } from "./links.js";
import { branchFor, worktreePath, cardBranch, agentsByBranch, finished, checkoutOf, playbookOf, taskFor, hasPstack, babysitFor, babysitTask, playbookNamed, PLAYBOOK_LIST } from "./work.js";
import { parseRuns, recordPlaybook, progress, LOOP, stationOf, lastMessage, ago, summarize } from "./runs.js";
import { LINE_H, PAD_Y, CHIPS_H, CHIPS_GAP, CHIPS_ROW_GAP, CHIP_GAP, CARD_GAP, INPUT_H, wrapText, cardHeight, chipLayout } from "./cards.js";

const TEXT_SIZE = 13;
// Herdr scales a mod by the person's zoom after layout: sizes it reports are on-screen pixels,
// while the lengths a mod sets are scaled. Measurements come back through this.
const unzoom = (px) => px / (settings().zoom || 1);
// Card text sits inside: the column's border, the list's 8px sides, the card's border and 12px sides.
const CARD_INSET = 2 + 16 + 2 + 24;
// Room the agent's status takes at the end of a card's first line: Herdr's own marks.
const TRACK_LABEL = 84; // the you / board / agent labels in How it works
const markWidth = (agent) => (!agent ? 0 : agent.status === "blocked" ? 76 : 20);

const DIR = `${home()}/kanban`;
const TRASH = `${DIR}/.trash`;
const REPOS = `${DIR}/.repos.json`; // board name -> repository folder, learnt from project boards
const DEFAULT_BOARD = "main";
const POLL_MS = 3000; // picks up edits made to the files elsewhere
const STATUS_MS = 60000; // linked pull requests, through gh
const AGENTS_MS = 2000; // agents finishing their work
const HISTORY_LIMIT = 200;
const NOTES_SAVE_MS = 600; // notes save this long after the last keystroke

const KEYS = {
  "left": "left", "h": "left", "right": "right", "l": "right",
  "up": "up", "k": "up", "down": "down", "j": "down",
  "shift-left": "shift-left", "shift-h": "shift-left", "shift-right": "shift-right", "shift-l": "shift-right",
  "shift-up": "shift-up", "shift-k": "shift-up", "shift-down": "shift-down", "shift-j": "shift-down",
  "n": "new", "a": "new", "enter": "open-card", "e": "edit", "d": "delete", "x": "delete", "backspace": "delete",
  "cmd-z": "undo", "cmd-shift-z": "redo",
  "[": "prev-board", "shift-tab": "prev-board", "]": "next-board", "tab": "next-board",
  "b": "new-board", "p": "project-board", "shift-d": "delete-board", "escape": "close",
  "g": "open-diff", "shift-2": "link", "@": "link", "o": "open-pr", "s": "start-work", "shift-b": "babysit", "i": "inspect", "?": "help", "shift-/": "help", "shift-n": "notes",
  "1": "column-1", "2": "column-2", "3": "column-3", "4": "column-4", "5": "column-5",
};

const HINTS = [["?", "how it works"], ["⇧N", "notes"], ["←→↑↓", "move"], ["⇧", "move card"], ["n", "new"], ["e", "edit"], ["d", "delete"], ["⌘Z", "undo"], ["[ ]", "board"], ["b", "new board"], ["⇧D", "delete board"]];
// Each column's dot, from the theme's palette.
const COLUMN_TINTS = ["ansi5", "ansi4", "ansi3", "ansi6", "ansi2"];
const alpha = (color, hex) => (/^#[0-9a-f]{6}$/i.test(color) ? color + hex : color);

const fileOf = (board) => `${DIR}/${board}.md`;
const runsOf = (board) => `${DIR}/.runs/${board}.json`; // what agents report about their playbooks

function storedBoard() {
  try { return localStorage.getItem("board"); } catch { return null; }
}

function storeBoard(board) {
  try { localStorage.setItem("board", board); } catch { /* not kept: opens the first board next time */ }
}

export default class Kanban extends View {
  init(_props, cx) {
    this.inspecting = props()?.view === "help" ? "help" : null; // opened straight into How it works
    this.boards = [];
    this.board = storedBoard() ?? DEFAULT_BOARD;
    this.project = null; // the focused terminal's git repository name, if any
    this.projectRoot = null; // and its folder
    this.repos = {};
    this.lanes = emptyLanes();
    this.raw = null; // the file as last read or written, to detect edits made elsewhere
    this.col = 0;
    this.rows = COLUMNS.map(() => 0);
    this.history = {}; // board -> { undo: [lanes], redo: [lanes] }
    this.editing = null; // { kind: "card", col, row } (row null: a new card) or { kind: "board" }
    this.confirmingDelete = false;
    this.confirmingPr = null; // { col, row, branch, repo, title } waiting for y
    this.confirmingStart = null; // { col, row, card, branch, repo, agent } waiting for y
    this.confirmingBabysit = null; // { card, branch, repo, agent, pstack, sit } waiting for y
    // this.inspecting: "card" (the selected card's run) or "help" (the loop and every playbook), set above.
    this.detail = null; // the inspected card's { branch, message, commits }
    this.runs = {};
    this.agentsBefore = agentsByBranch(agents(), panes());
    this.statuses = new Map(); // "<repo>#<number>" -> prStatus

    // Each column is a virtual list, so moving the cursor can scroll its card into view.
    this.scrolls = COLUMNS.map(() => VirtualListScrollHandle.new());
    this.columnW = 0; // measured
    this.charW = TEXT_SIZE * 0.6; // measured from the code font
    // Free notes, one page per board, kept at the end of its file under "## Notes".
    this.view = props()?.view === "notes" ? "notes" : "board";
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
      this.project = await this.detectProject();
      if (this.project) await this.rememberRepo(this.project, this.projectRoot);
      await this.refresh(cx);
      if (this.boards.includes(this.project)) this.openBoard(this.project, cx);
      await this.syncStatuses(cx);
      if (props()?.view === "inspect") await this.inspectCard(props().card, cx);
    });
    cx.timer.every(POLL_MS, (cx) => { if (!this.editing) cx.spawn((cx) => this.refresh(cx)); });
    cx.timer.every(STATUS_MS, (cx) => { if (!this.editing) cx.spawn((cx) => this.syncStatuses(cx)); });
    cx.timer.every(AGENTS_MS, () => this.noticeFinished());
  }

  // Files

  async detectProject() {
    const cwd = focused()?.cwd;
    if (!cwd) return null;
    // A worktree belongs to its repository: the project is the main checkout's folder.
    const common = await exec("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => null);
    const shared = common?.code === 0 ? common.stdout.trim() : "";
    const git = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).catch(() => null);
    const root = shared.endsWith("/.git") ? shared.slice(0, -5) : git?.code === 0 ? git.stdout.trim() : cwd;
    if (root === home() || root === "/") return null;
    this.projectRoot = root;
    return boardName(root.split("/").pop());
  }

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

  openBoard(board, cx) {
    if (board === this.board) return;
    // Notes typed a moment ago belong to the board they were typed on: save them first.
    if (this.notesPending) {
      this.notesTyped++;
      this.notesPending = false;
      this.save(cx);
    }
    this.board = board;
    this.raw = null;
    this.lanes = emptyLanes();
    this.col = 0;
    this.rows = COLUMNS.map(() => 0);
    this.confirmingDelete = false;
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
    this.confirmingDelete = false;
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

  // Applies an edit from board.js: keeps the previous lanes for undo, moves the cursor, saves.
  apply(result, cx) {
    if (!result) return;
    const history = (this.history[this.board] ??= { undo: [], redo: [] });
    history.undo.push(this.lanes);
    if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
    history.redo = [];
    this.lanes = result.lanes;
    this.col = result.col;
    this.rows[result.col] = result.row;
    this.clampRows();
    this.save(cx);
    cx.notify();
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
    if (this.view === "notes") {
      if (event.key === "escape") { this.showBoard(cx); cx.stop_propagation(); }
      return;
    }
    if (this.editing) {
      if (event.key === "escape") { this.stopEdit(cx); cx.stop_propagation(); }
      return;
    }
    if (this.confirmingDelete) {
      if (event.keystroke === "y" || event.keystroke === "enter") this.deleteBoard(cx);
      else { this.confirmingDelete = false; cx.notify(); }
      cx.stop_propagation();
      return;
    }
    if (this.confirmingPr) {
      const ask = this.confirmingPr;
      this.confirmingPr = null;
      if (event.keystroke === "y" || event.keystroke === "enter") this.openPullRequest(ask, cx);
      cx.notify();
      cx.stop_propagation();
      return;
    }
    if (this.confirmingStart) {
      const ask = this.confirmingStart;
      this.confirmingStart = null;
      if (event.keystroke === "y" || event.keystroke === "enter") this.startWork(ask, cx);
      cx.notify();
      cx.stop_propagation();
      return;
    }
    if (this.confirmingBabysit) {
      const ask = this.confirmingBabysit;
      this.confirmingBabysit = null;
      if (event.keystroke === "y" || event.keystroke === "enter") this.babysit(ask, cx);
      cx.notify();
      cx.stop_propagation();
      return;
    }
    if (this.inspecting) {
      const action = KEYS[event.keystroke];
      if (["escape", "i", "?", "shift-/"].includes(event.keystroke)) this.inspecting = null;
      else if (this.inspecting === "help" && (action === "up" || action === "down")) {
        this.helpIndex = ((this.helpIndex ?? 0) + (action === "up" ? -1 : 1) + PLAYBOOK_LIST.length) % PLAYBOOK_LIST.length;
      } else if (this.inspecting === "card" && ["up", "down", "left", "right"].includes(action)) {
        // Other cards: the inspector follows the cursor.
        this.perform(action, cx);
        this.detail = null;
        cx.spawn(async (cx) => { await this.loadDetail(); cx.notify(); });
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
    const newCard = () => this.startEdit({ kind: "card", col, row: null }, "", cx);
    const editSelected = () => lanes[col].length && this.startEdit({ kind: "card", col, row }, lanes[col][row], cx);
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
      case "open-card": return lanes[col].length ? editSelected() : newCard();
      case "delete": return this.apply(removeCard(lanes, col, row), cx);
      case "undo": return this.travel("undo", "redo", cx);
      case "redo": return this.travel("redo", "undo", cx);
      case "prev-board": return this.cycleBoard(-1, cx);
      case "next-board": return this.cycleBoard(1, cx);
      case "new-board": return this.startEdit({ kind: "board" }, "", cx);
      case "project-board": return this.project && this.createBoard(this.project, cx);
      case "delete-board": this.confirmingDelete = true; return cx.notify();
      case "open-diff": return this.openDiff(lanes[col][row]);
      case "link": return this.linkBranch(cx);
      case "open-pr": return this.askPullRequest(cx);
      case "start-work": return this.askStartWork(cx);
      case "babysit": return this.askBabysit(cx);
      case "inspect":
        if (lanes[col][row] == null) return;
        this.inspecting = "card";
        this.detail = null;
        cx.spawn(async (cx) => { await this.loadDetail(); cx.notify(); });
        return cx.notify();
      case "help": this.inspecting = "help"; return cx.notify();
      case "notes": return this.showNotesPage(cx);
      case "close": return props()?.overlay && closeOverlay(props().overlay);
      default: {
        const column = action.match(/^column-(\d)$/);
        if (column) this.moveCursor(Number(column[1]) - 1 - col, 0, cx);
      }
    }
  }

  // Links: a card's pull request or branch opens in snappy-diff.

  repoFor(board) {
    return this.repos[board] ?? (board === this.project ? this.projectRoot : null);
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
    if (this.repoFor(board) || !this.projectRoot) return this.repoFor(board);
    const parent = this.projectRoot.slice(0, this.projectRoot.lastIndexOf("/"));
    for (const folder of [`${this.projectRoot}/${board}`, `${parent}/${board}`]) {
      const top = await exec("git", ["-C", folder, "rev-parse", "--show-toplevel"]).catch(() => null);
      if (top?.code === 0 && top.stdout.trim() === folder) {
        await this.rememberRepo(board, folder);
        return folder;
      }
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
    if (!repo) {
      notify({ title: "No repository for this board", body: "Open the board from a terminal inside the project once.", level: "warning" });
      return;
    }
    const branch = this.branchOf(card);
    if (!links.pr && !branch && links.issue) {
      exec("gh", ["issue", "view", String(links.issue.n), "--web"], { cwd: repo }).catch(() => {});
      return;
    }
    if (!links.pr && !branch) return;
    openOverlay({
      mod: "snappy-diff", kind: "dialog", modal: true, width: 0.96, height: 0.92,
      props: links.pr ? { repo, pr: links.pr.n } : { repo, head: branch },
    });
  }

  // @: links the selected card to the branch its board's repository is on, and to that
  // branch's pull request when it has one.
  linkBranch(cx) {
    const { lanes, col } = this;
    const row = this.rows[col];
    const card = lanes[col][row];
    const repo = this.repoFor(this.board);
    if (card == null || !repo) return;
    cx.spawn(async (cx) => {
      const branch = (await exec("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      const pr = await exec("gh", ["pr", "view", "--json", "number", "-q", ".number"], { cwd: repo }).catch(() => null);
      let text = withLink(card, `@${branch}`);
      if (pr?.code === 0 && pr.stdout.trim()) text = withLink(text, `#${pr.stdout.trim()}`);
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
    const gh = async (args, parse) => {
      const result = await exec("gh", args, { cwd: repo }).catch(() => null);
      if (result?.code !== 0) return null;
      try { return parse(JSON.parse(result.stdout)); } catch { return null; }
    };
    await Promise.all([...refs].map(async ([n, kind]) => {
      const pr = kind === "issue" ? null : await gh(["pr", "view", String(n), "--json", "state,isDraft,reviewDecision,statusCheckRollup,headRefName,mergeable"], prStatus);
      const status = pr ?? (kind === "pr" ? null : await gh(["issue", "view", String(n), "--json", "state,stateReason,url"], issueStatus));
      if (status) this.statuses.set(`${repo}#${n}`, status);
    }));
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
    const history = (this.history[this.board] ??= { undo: [], redo: [] });
    history.undo.push(this.lanes);
    history.redo = [];
    this.lanes = lanes;
    this.clampRows();
    this.save(cx);
    notify({ title: "Board updated from GitHub", body: moves.join(", "), level: "info", timeout: 4000 });
  }

  // o: push the card's branch (or the current one) and open a pull request titled like the
  // card, closing its issue if it has one. Asks first, since both are seen by others.
  askPullRequest(cx) {
    const { col } = this;
    const row = this.rows[col];
    const card = this.lanes[col][row];
    if (card == null) return;
    const links = this.linksOf(card);
    if (links?.pr) { notify({ title: `Already linked to #${links.pr.n}`, level: "info", timeout: 2500 }); return; }
    const repo = this.repoFor(this.board);
    if (!repo) return;
    cx.spawn(async (cx) => {
      const branch = this.branchOf(card) ?? (await exec("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      if (!branch || branch === "HEAD" || ["main", "master"].includes(branch)) {
        notify({ title: "No branch to open a pull request from", body: "Start work on the card, link it to a branch, or switch to one.", level: "warning" });
        return;
      }
      this.confirmingPr = { col, row, branch, repo, title: withoutLinks(card), issue: links?.issue?.n ?? null };
      cx.notify();
    });
  }

  openPullRequest({ col, row, branch, repo, title, issue }, cx) {
    cx.spawn(async (cx) => {
      const lastLine = (text) => text.trim().split("\n").pop();
      const push = await exec("git", ["-C", repo, "push", "-u", "origin", branch]);
      if (push.code !== 0) { notify({ title: `Couldn't push ${branch}`, body: lastLine(push.stderr), level: "error" }); return; }
      const body = issue ? `Closes #${issue}` : "";
      const create = await exec("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body], { cwd: repo });
      const number = create.code === 0 && numberFromUrl(create.stdout);
      if (!number) { notify({ title: "Couldn't open the pull request", body: lastLine(create.stderr), level: "error" }); return; }
      notify({ title: `Opened pull request #${number}`, body: title, level: "success", timeout: 4000 });
      const card = this.lanes[col][row];
      if (card == null || withoutLinks(card) !== title) return; // the board moved on; the pull request still exists
      this.apply(editCard(this.lanes, col, row, withLink(card, `#${number}`)), cx);
      await this.syncStatuses(cx);
    });
  }

  // Working on cards: start an agent on a card, and follow the agents working on them.

  // s: a worktree on a branch named after the card, a space there with an agent that gets the
  // card (and its issue) as its task, the card linked to the branch and moved to work. Asks first.
  // Claude Code with pstack gets the card through poteto-mode, with the card's playbook.
  askStartWork(cx) {
    const { col } = this;
    const row = this.rows[col];
    const card = this.lanes[col][row];
    const repo = this.repoFor(this.board);
    if (card == null) return;
    if (!repo) {
      notify({ title: "No repository for this board", body: "Open the board from a terminal inside the project once.", level: "warning" });
      return;
    }
    const branch = this.branchOf(card) ?? branchFor(withoutLinks(card));
    const issue = this.linksOf(card)?.issue?.n ?? null;
    cx.spawn(async (cx) => {
      const picked = await this.pickAgent();
      if (!picked) return;
      this.confirmingStart = { col, row, card, branch, repo, issue, ...picked };
      cx.notify();
    });
  }

  // The first installed agent Herdr knows, and whether it is Claude Code with pstack: { agent, pstack }.
  async pickAgent() {
    const agent = (await knownAgents().catch(() => [])).find((a) => a.installed);
    if (!agent) {
      notify({ title: "No agent to start", body: "Install one Herdr knows, like Claude Code or Codex.", level: "warning" });
      return null;
    }
    const pstack = agent.key === "claude" && hasPstack(await readTextFile(`${home()}/.claude/plugins/installed_plugins.json`).catch(() => null));
    return { agent, pstack };
  }

  // The folder checked out on branch: an existing checkout, else a new worktree on the branch,
  // made from the default branch when the branch doesn't exist yet. Null when git fails.
  async checkout(repo, branch) {
    const git = (args) => exec("git", ["-C", repo, ...args]);
    const folder = checkoutOf((await git(["worktree", "list", "--porcelain"])).stdout, branch);
    if (folder) return folder;
    const path = worktreePath(home(), repo, branch);
    const hasBranch = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
    if (!hasBranch) await git(["fetch", "--quiet", "origin", branch]); // a pull request opened elsewhere
    const remote = (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`])).code === 0;
    const base = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout.trim() || "HEAD";
    const made = await git(hasBranch ? ["worktree", "add", path, branch]
      : remote ? ["worktree", "add", "-b", branch, path, `origin/${branch}`]
      : ["worktree", "add", "-b", branch, path, base]);
    if (made.code !== 0) {
      notify({ title: `Couldn't make a worktree for ${branch}`, body: made.stderr.trim().split("\n").pop(), level: "error" });
      return null;
    }
    return path;
  }

  startWork({ col, row, card, branch, repo, agent, issue, pstack }, cx) {
    cx.spawn(async (cx) => {
      const folder = await this.checkout(repo, branch);
      if (!folder) return;
      const title = withoutLinks(card);
      run("space.new", { name: playbookOf(title).title.slice(0, 40), folder, argv: agent.run, task: taskFor(title, issue, pstack) });
      const { playbook } = playbookOf(title);
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
  askBabysit(cx) {
    const card = this.lanes[this.col][this.rows[this.col]];
    const repo = this.repoFor(this.board);
    const pr = card != null ? this.linksOf(card)?.pr : null;
    const sit = pr ? babysitFor(pr.n, pr.status) : null;
    const branch = card != null ? this.branchOf(card) : null;
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
      const picked = await this.pickAgent();
      if (!picked) return;
      this.confirmingBabysit = { card, branch, repo, sit, ...picked };
      cx.notify();
    });
  }

  babysit({ card, branch, repo, agent, pstack, sit }, cx) {
    cx.spawn(async () => {
      const folder = await this.checkout(repo, branch);
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

  // The inspected card's agent's last message (from its Claude Code transcript) and the commits
  // on its branch.
  async loadDetail() {
    const card = this.lanes[this.col][this.rows[this.col]];
    const branch = card != null ? this.branchOf(card) : null;
    const repo = this.repoFor(this.board);
    if (!branch || !repo) { this.detail = null; return; }
    const agent = this.agentOf(card);
    let message = null;
    if (agent?.cwd) {
      // Claude Code keeps a folder's sessions in ~/.claude/projects/<folder, / and . as ->.
      const dir = `${home()}/.claude/projects/${agent.cwd.replace(/[/.]/g, "-")}`;
      const newest = (await exec("ls", ["-t", dir]).catch(() => null))?.stdout.split("\n").find((f) => f.endsWith(".jsonl"));
      if (newest) message = lastMessage((await exec("tail", ["-n", "400", `${dir}/${newest}`]).catch(() => null))?.stdout);
    }
    const base = (await exec("git", ["-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => null))?.stdout.trim() || "HEAD";
    const count = await exec("git", ["-C", repo, "rev-list", "--count", `${base}..${branch}`]).catch(() => null);
    this.detail = { branch, message, commits: count?.code === 0 ? Number(count.stdout.trim()) : null };
  }

  // Agents by branch, read live: render runs again whenever Herdr's agents change.
  agentOf(card) {
    const branch = this.branchOf(card);
    return branch ? this.agentMap?.get(branch) ?? null : null;
  }

  // While the board is open: an agent that stops working on a card's branch means the card is
  // ready for review. The toast opens its diff.
  noticeFinished() {
    const now = agentsByBranch(agents(), panes());
    const repo = this.repoFor(this.board);
    for (const branch of finished(this.agentsBefore, now)) {
      const card = this.lanes.flat().find((c) => this.branchOf(c) === branch);
      if (!card || !repo) continue;
      const pr = this.linksOf(card)?.pr;
      notify({
        title: `${withoutLinks(card)} is ready for review`, body: `${now.get(branch).name ?? "The agent"} finished on ${branch}`,
        level: "success", timeout: 8000,
        action: { name: "tab.new", args: { name: withoutLinks(card).slice(0, 30), mod: "snappy-diff", props: pr ? { repo, pr: pr.n } : { repo, head: branch } } },
      });
    }
    this.agentsBefore = now;
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

  // View

  render() {
    const t = theme();
    const font = settings().font_family;
    this.agentMap = agentsByBranch(agents(), panes());
    this.revealCursor();
    return v_flex().id("kanban").track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .size_full().px(18).pt(16).pb(12).gap(14).bg(t.canvas).text_color(t.foreground).text_size(13)
      .when(Boolean(font), (el) => el.font_family(font))
      .child(this.renderTop(t))
      .child(this.view === "notes" ? this.renderNotes(t) : this.inspecting ? this.renderInspector(t)
        : h_flex().flex_1().min_h(0).gap(12).children(COLUMNS.map((name, c) => this.renderColumn(t, name, c))))
      .child(this.renderHint(t))
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

  // Board tabs on the left, progress on the right.
  renderTop(t) {
    const editingName = this.editing?.kind === "board";
    const tab = (board) => {
      const active = board === this.board;
      return h_flex().id(`board-${board}`).h(26).px(10).gap(6).items_center().rounded(6).cursor_pointer()
        .text_color(active ? t.foreground : t.muted).when(active, (el) => el.bg(t.raised))
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.openBoard(board, cx); this.handle.focus(); })
        .child(board)
        .when(board === this.project, (el) => el.child(div().size(5).rounded(3).bg(t.accent)));
    };
    const add = h_flex().id("board-new").h(26).w(26).justify_center().items_center().rounded(6).cursor_pointer()
      .text_color(t.dim).hover((s) => s.text_color(t.foreground).bg(t.hover))
      .on_click((_e, cx) => this.startEdit({ kind: "board" }, "", cx))
      .child("+");
    const total = this.lanes.reduce((n, lane) => n + lane.length, 0);
    const shipped = this.lanes[COLUMNS.length - 1].length;
    return h_flex().items_center().gap(12)
      .child(h_flex().p(3).gap(2).items_center().rounded(8).border_1().border_color(t.border).bg(t.background)
        .children(this.boards.map(tab))
        .child(editingName ? div().w(160).child(this.renderInput(t, "new-board")) : add))
      .child(h_flex().p(3).gap(2).items_center().rounded(8).border_1().border_color(t.border).bg(t.background)
        .children([["board", "Board"], ["notes", "Notes"]].map(([view, label]) => {
          const active = this.view === view;
          return h_flex().id(`view-${view}`).h(26).px(10).gap(6).items_center().rounded(6).cursor_pointer()
            .text_color(active ? t.foreground : t.muted).when(active, (el) => el.bg(t.raised))
            .hover((st) => st.text_color(t.foreground))
            .on_click((_e, cx) => (view === "notes" ? this.showNotesPage(cx) : this.showBoard(cx)))
            .child(label)
            .when(view === "notes" && Boolean(this.notes.trim()), (el) => el.child(div().size(5).rounded(3).bg(t.dim)));
        })))
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
      return cardHeight(lines, chipLayout(this.chips(theme(), item.text, false).map((chip) => chip.width), this.chipWidth()).length);
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
      .when(Boolean(cardLinks(text)), (el) => el.child(this.renderChips(t, text, done)))
      // The agent's status sits at the end of the first line, where it can't be pushed out.
      .when(Boolean(agent), (el) => el.child(h_flex().absolute().top(PAD_Y + 1).right(10).h(LINE_H).items_center()
        .child(this.agentMark(t, agent))));
  }

  // The room chips have in a card, and an 11px character's width.
  chipWidth() {
    return Math.max(80, this.columnW - CARD_INSET);
  }

  // A card's links as chips, each { width, parts }: a mark (a dot for a pull request, a ring for
  // an issue) and pieces of text. Widths are worked out the way the text's are, so the card's
  // height is known before it is drawn.
  chips(t, card, done) {
    const links = this.linksOf(card);
    if (!links) return [];
    const ch = (this.charW * 11) / 13;
    const chip = (mark, texts) => ({
      mark, texts,
      width: 16 + (mark ? 12 : 0) + texts.reduce((n, [text]) => n + text.length * ch, 0) + 6 * Math.max(0, texts.length - 1),
    });
    const out = [];
    for (const ref of links.refs) {
      const st = ref.status;
      if (st?.kind === "issue" || (ref.kind === "issue" && !st)) {
        const color = !st ? t.dim : st.state === "open" ? t.ansi2 : st.completed ? t.ansi5 : t.dim;
        out.push(chip({ ring: true, color }, [[`#${ref.n}`, done ? t.muted : t.foreground], ["issue", t.dim], ...(st ? [[st.state === "closed" && !st.completed ? "not planned" : st.state, t.dim]] : [])]));
        continue;
      }
      const color = { open: t.ansi2, draft: t.dim, merged: t.ansi5, closed: t.ansi1 }[st?.state] ?? t.dim;
      const checks = { passing: ["✓", t.ansi2], failing: ["✗", t.ansi1], pending: ["•", t.ansi3] }[st?.checks];
      const review = { approved: ["approved", t.ansi2], changes: ["changes", t.ansi1] }[st?.review];
      out.push(chip({ ring: false, color }, [[`#${ref.n}`, done ? t.muted : t.foreground], ...(st ? [[st.state, t.dim]] : []), ...(checks ? [checks] : []), ...(review ? [review] : [])]));
    }
    if (links.branch) out.push(chip(null, [[`⎇ ${links.branch}`, done ? t.dim : t.muted]]));
    const { run, book } = this.runOf(card);
    if (run && book) {
      const at = progress(run, book.steps.length);
      out.push(chip(null, [[`${at.done}/${book.steps.length}`, done ? t.muted : t.foreground], [at.current ? book.steps[at.current - 1][0] : "done", t.dim]]));
    }
    return out;
  }

  renderChips(t, card, done) {
    const chips = this.chips(t, card, done);
    const available = this.chipWidth();
    const draw = ({ mark, texts }) => h_flex().h(CHIPS_H).max_w(available).px(7).gap(6).items_center().flex_none().rounded(5)
      .bg(t.background).border_1().border_color(t.border).text_size(11)
      .when(Boolean(mark), (el) => el.child(mark.ring
        ? div().size(7).flex_none().rounded(4).border(1.5).border_color(mark.color)
        : div().size(6).flex_none().rounded(3).bg(mark.color)))
      .children(texts.map(([text, color]) => div().min_w(0).truncate().text_color(color).child(text)));
    return v_flex().gap(CHIPS_ROW_GAP).children(chipLayout(chips.map((c) => c.width), available).map((row) =>
      h_flex().h(CHIPS_H).gap(CHIP_GAP).items_center().children(row.map((i) => draw(chips[i])))));
  }

  // Herdr's own marks, as its agents sidebar draws them: a turning ring while working, "Needs you"
  // when blocked, a filled dot when done, a hollow ring when idle.
  agentMark(t, agent) {
    if (agent.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
    if (agent.status === "blocked") {
      return div().flex_none().px(6).h(18).rounded(5).bg(alpha(t.blocked, "26")).text_size(10.5).font_semibold()
        .text_color(t.blocked).flex().items_center().child("Needs you");
    }
    if (agent.status === "idle") return div().size(7).mx(2).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(2).flex_none().rounded(4).bg(t.done);
  }

  renderInput(t, id) {
    return div().id(id).h(36).px(12).flex().items_center().rounded(8).bg(t.background)
      .border_1().border_color(t.accent)
      .child(Input.new(this.input).w_full().text_color(t.foreground));
  }

  // Keys as keycaps. Asks and the selected card's state come first, in words.
  renderHint(t) {
    const line = h_flex().h(22).gap(14).items_center().text_size(11.5).text_color(t.dim);
    if (this.view === "notes") return line.child(this.keys(t, [["esc", "back to the board"]])).child("saved as you type");
    if (this.inspecting === "help") return line.child(this.keys(t, [["↑↓", "playbook"], ["esc", "back to the board"]]));
    if (this.inspecting) return line.child(this.keys(t, [["←→↑↓", "other cards"], ["esc", "back to the board"]]));
    if (this.confirmingDelete) {
      return line.child(div().text_color(t.blocked).child(`Delete board "${this.board}"?`)).child(this.keys(t, [["y", "delete"], ["any key", "cancel"]]));
    }
    if (this.confirmingPr) {
      const { branch, title } = this.confirmingPr;
      return line.child(div().text_color(t.accent).child(`Push ${branch} and open a pull request "${title}"?`)).child(this.keys(t, [["y", "open"], ["any key", "cancel"]]));
    }
    if (this.confirmingStart) {
      const { branch, agent, card, pstack } = this.confirmingStart;
      const playbook = pstack ? ` with pstack ${playbookOf(withoutLinks(card)).playbook ?? "poteto-mode"}` : "";
      return line.child(div().text_color(t.accent).child(`Start ${agent.name ?? "an agent"}${playbook} on ${branch} in a new worktree?`)).child(this.keys(t, [["y", "start"], ["any key", "cancel"]]));
    }
    if (this.confirmingBabysit) {
      const { agent, pstack, sit } = this.confirmingBabysit;
      const why = sit.blockers.length ? ` (${sit.blockers.join(", ")})` : "";
      const how = sit.mode === "drive" ? `to merge-ready${why}` : "for one status check";
      return line.child(div().text_color(t.accent).child(`Babysit #${sit.number} ${how} with ${agent.name ?? "an agent"}${pstack ? " and pstack" : ""}?`)).child(this.keys(t, [["y", "babysit"], ["any key", "cancel"]]));
    }
    if (this.editing) return line.child(this.keys(t, [["↵", "save"], ["esc", "cancel"]]));
    const card = this.lanes[this.col][this.rows[this.col]];
    const links = card != null ? this.linksOf(card) : null;
    const ref = links?.pr ?? links?.issue;
    const status = ref?.status;
    const repo = this.repoFor(this.board);
    const branch = card != null ? this.branchOf(card) : null;
    const linked = card == null || !repo ? []
      : [
        ...(links?.pr || branch ? [["g", "open diff"]] : links?.issue ? [["g", "open issue"]] : []),
        ["i", "inspect"],
        ...(!this.agentOf(card) ? [["s", "start work"]] : []),
        ...(!branch ? [["@", "link branch"]] : []),
        ...(!links?.pr ? [["o", "open pull request"]] : []),
        ...(links?.pr && babysitFor(links.pr.n, status) && !this.agentOf(card) ? [["⇧B", "babysit"]] : []),
      ];
    const offer = this.project && !this.boards.includes(this.project) ? [["p", `board for ${this.project}`]] : [];
    const agent = card != null ? this.agentOf(card) : null;
    const doing = { working: "is working", blocked: "needs you", done: "is ready for review", idle: "is idle" };
    return line
      .when(Boolean(agent), (el) => el.child(h_flex().gap(6).items_center().text_color(t.muted)
        .child(this.agentMark(t, agent)).child(`${agent.name ?? "Agent"} ${doing[agent.status] ?? agent.status}`)))
      .when(Boolean(status), (el) => el.child(div().text_color(t.muted).child(describe(ref.n, status))))
      .child(this.keys(t, [...offer, ...linked, ...HINTS]));
  }

  // The inspector: in place of the columns, the selected card's place on the loop and its
  // playbook's steps as the agent reported them (i), or the loop and every playbook (?).
  renderInspector(t) {
    const panel = v_flex().id("inspector").flex_1().min_h(0).overflow_y_scroll().gap(22).px(28).py(24)
      .rounded(10).border_1().border_color(t.border).bg(t.raised);
    return this.inspecting === "help" ? this.renderHelp(t, panel) : this.renderCardRun(t, panel);
  }

  // A small uppercase heading over a section.
  label(t, text) {
    return div().text_size(10.5).font_medium().text_color(t.dim).child(text.toUpperCase());
  }

  renderHelp(t, panel) {
    const book = PLAYBOOK_LIST[this.helpIndex ?? 0];
    const who = [["You", t.ansi3, "you"], ["Board", t.ansi6, "board"], ["Agent", t.ansi5, "agent"]];
    return panel
      .child(v_flex().gap(6)
        .child(div().text_size(18).font_semibold().child("How it works"))
        .child(div().text_color(t.muted).whitespace_normal().child("A card goes around this loop. Herdr runs the board and the agents; pstack's playbooks tell the agent how to work.")))
      .child(v_flex().gap(0)
        .child(this.renderTrack(t, null))
        .children(who.map(([name, color, key]) => h_flex().items_stretch().border_t(1).border_color(t.border)
          .child(h_flex().w(TRACK_LABEL).flex_none().gap(8).items_center().py(10)
            .child(div().size(7).rounded_full().bg(color)).child(div().text_size(12).font_medium().text_color(color).child(name)))
          .children(LOOP.map((stop) => div().flex_1().min_w(0).px(10).py(10).text_size(11.5).line_height(17)
            .text_color(stop[key] ? t.muted : t.dim).whitespace_normal().child(stop[key] ?? "·"))))))
      .child(v_flex().gap(10)
        .child(this.label(t, "Playbooks"))
        .child(h_flex().items_stretch().rounded(8).border_1().border_color(t.border).bg(t.canvas)
          .child(v_flex().w(230).flex_none().py(6).border_r(1).border_color(t.border).children(PLAYBOOK_LIST.map((b, i) => {
            const on = b === book;
            return v_flex().px(14).py(8).gap(2).border_l(2).border_color(on ? t.accent : t.canvas).when(on, (el) => el.bg(t.selected))
              .child(div().font_medium().text_color(on ? t.foreground : t.muted).child(b.playbook))
              .child(div().text_size(11).text_color(t.dim).child(b.words.length ? b.words.map((w) => `${w}:`).join("  ") : "⇧B on a pull request"));
          })))
          .child(v_flex().flex_1().min_w(0).gap(16).px(22).py(18)
            .child(v_flex().gap(6)
              .child(h_flex().gap(10).items_center().child(div().text_size(16).font_semibold().child(book.playbook))
                .child(div().text_size(11.5).text_color(t.dim).child(`${book.steps.length} steps`)))
              .child(this.renderEnds(t, book)))
            .child(this.renderSteps(t, book, null)))));
  }

  renderCardRun(t, panel) {
    const card = this.lanes[this.col][this.rows[this.col]];
    if (card == null) return panel.child(div().text_color(t.muted).child("No card selected."));
    const { run, book, planned } = this.runOf(card);
    const agent = this.agentOf(card);
    const links = this.linksOf(card);
    const branch = this.branchOf(card);
    const detail = this.detail?.branch === branch ? this.detail : null;
    const station = stationOf(this.col, { working: Boolean(agent || run?.playbook), playbook: run?.playbook });
    const at = book && run ? progress(run, book.steps.length) : null;
    const since = (iso) => { const a = ago(iso); return a && (a === "just now" ? a : `${a} ago`); };
    const pr = links?.pr;
    const prColor = { open: t.ansi2, draft: t.dim, merged: t.ansi5, closed: t.ansi1 }[pr?.status?.state] ?? t.dim;
    const facts = [
      ["Station", LOOP[station].name],
      ["Branch", branch ?? "none yet"],
      ["Pull request", pr ? (pr.status ? describe(pr.n, pr.status) : `#${pr.n}`) : "none yet"],
      ...(detail?.commits != null ? [["Commits", `${detail.commits} on the branch`]] : []),
      ...(run?.at ? [["Updated", since(run.at)]] : []),
    ];
    return panel
      .child(v_flex().gap(10)
        .child(div().text_size(18).font_semibold().whitespace_normal().child(withoutLinks(card)))
        .child(h_flex().flex_wrap().gap(18).items_center().text_size(12).text_color(t.muted)
          .when(Boolean(book), (el) => el.child(h_flex().gap(6).items_center().child(div().size(7).rounded_full().bg(t.ansi5)).child(`${book.playbook} playbook`)))
          .when(Boolean(branch), (el) => el.child(`⎇ ${branch}`))
          .when(Boolean(pr), (el) => el.child(h_flex().gap(6).items_center().child(div().size(7).rounded_full().bg(prColor))
            .child(pr.status ? describe(pr.n, pr.status) : `#${pr.n}`)))))
      .child(this.renderTrack(t, station))
      .child(h_flex().gap(28).items_start()
        .child(v_flex().flex_1().min_w(0).gap(16)
          .child(v_flex().gap(8)
            .child(h_flex().justify_between().items_center()
              .child(this.label(t, book ? (planned ? "Playbook, planned" : "Playbook") : "Playbook"))
              .when(Boolean(at), (el) => el.child(div().text_size(12).text_color(t.muted)
                .child(at.current ? `${at.done} of ${book.steps.length} · ${book.steps[at.current - 1][0]}` : `all ${book.steps.length} done`))))
            .child(book ? this.renderBar(t, book, run) : div()))
          .child(book ? this.renderSteps(t, book, run) : this.renderNoPlaybook(t))
          .when(Boolean(book), (el) => el.child(this.renderEnds(t, book)))
          .when(Boolean(book && planned), (el) => el.child(div().text_size(11.5).text_color(t.dim).whitespace_normal()
            .child(this.col <= 1 ? "Steps fill in once s starts an agent and it reports them." : "The agent hasn't reported a step yet."))))
        .child(v_flex().w(360).flex_none().gap(22)
          .child(v_flex().gap(8).child(this.label(t, "Agent")).child(this.renderAgent(t, agent, detail?.message)))
          .child(v_flex().gap(8).child(this.label(t, "Details"))
            .child(v_flex().children(facts.map(([k, v], i) => h_flex().gap(12).py(6)
              .when(i > 0, (el) => el.border_t(1).border_color(t.border)).text_size(12)
              .child(div().w(96).flex_none().text_color(t.dim).child(k))
              .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(v))))))));
  }

  // The card's agent: its status, then its last message organised (summarize): the lead, a few
  // points, how much more there is, and when it's blocked, its question.
  renderAgent(t, agent, message) {
    const box = v_flex().gap(10).p(14).rounded(8).border_1().border_color(t.border).bg(t.canvas);
    if (!agent && !message) {
      return box.child(div().text_size(12).text_color(t.dim).whitespace_normal()
        .child(this.col <= 1 ? "No agent yet. s starts one." : "No agent on this branch now."));
    }
    const doing = { working: ["working", t.working], blocked: ["needs you", t.blocked], done: ["ready for review", t.done], idle: ["idle", t.dim] };
    const [word, color] = doing[agent?.status] ?? ["not running", t.dim];
    const when = message?.at ? ago(message.at) : null;
    const sum = message ? summarize(message.text) : null;
    return box
      .child(h_flex().gap(8).items_center()
        .when(Boolean(agent), (el) => el.child(this.agentMark(t, agent)))
        .child(div().font_medium().child(agent?.name ?? "Agent"))
        .child(div().text_size(12).text_color(color).child(word))
        .child(div().flex_1())
        .when(Boolean(when), (el) => el.child(div().text_size(11).text_color(t.dim).child(when === "just now" ? when : `${when} ago`))))
      .when(!sum, (el) => el.child(div().text_size(12).text_color(t.dim).whitespace_normal()
        .child("No message yet, or this agent keeps no Claude Code transcript.")))
      .when(Boolean(sum && agent?.status === "blocked" && sum.question), (el) => el.child(v_flex().gap(4).px(10).py(8).rounded(6)
        .bg(alpha(t.blocked, "1f")).border_1().border_color(alpha(t.blocked, "55"))
        .child(div().text_size(10.5).font_medium().text_color(t.blocked).child("NEEDS YOU"))
        .child(div().text_size(12).text_color(t.foreground).line_height(18).whitespace_normal().child(sum.question))))
      .when(Boolean(sum?.lead), (el) => el.child(div().text_size(12.5).text_color(t.foreground).line_height(19).whitespace_normal().child(sum.lead)))
      .when(Boolean(sum?.points.length), (el) => el.child(v_flex().gap(6).children(sum.points.map((point) =>
        h_flex().gap(8).items_start().text_size(12)
          .child(div().w(10).flex_none().text_color(t.dim).child("•"))
          .child(div().flex_1().min_w(0).text_color(t.muted).line_height(17).whitespace_normal().child(point))))))
      .when(Boolean(sum?.more), (el) => el.child(div().text_size(11).text_color(t.dim)
        .child(`${sum.more} more in the agent's tab`)));
  }

  // The six stations as a track: numbered nodes joined by a line, the columns matching the
  // you / board / agent rows under them. With `current`, earlier stations are passed (✓).
  renderTrack(t, current) {
    return h_flex().items_center().pb(12)
      .child(div().w(current === null ? TRACK_LABEL : 0).flex_none())
      .children(LOOP.map((stop, i) => {
        const here = i === current;
        const passed = current !== null && i < current;
        const node = div().size(22).flex_none().rounded_full().flex().items_center().justify_center().text_size(11).font_semibold()
          .border_1().border_color(here ? t.accent : passed ? t.ansi2 : t.border)
          .bg(here ? t.accent : t.canvas).text_color(here ? t.accent_foreground ?? t.canvas : passed ? t.ansi2 : t.muted)
          .child(passed ? "✓" : String(i + 1));
        return h_flex().flex_1().min_w(0).items_center().gap(8).px(current === null ? 10 : 0)
          .child(node)
          .child(div().flex_none().font_medium().text_color(here ? t.foreground : passed ? t.muted : current === null ? t.foreground : t.dim).child(stop.name))
          .child(i < LOOP.length - 1 ? div().flex_1().h(1).mx(6).bg(passed ? alpha(t.ansi2, "80") : t.border) : div().flex_1());
      }));
  }

  // One segment a step: done green, skipped faint, the one in hand accent, to do a border line.
  renderBar(t, book, run) {
    const at = run ? progress(run, book.steps.length) : null;
    return h_flex().gap(3).children(book.steps.map((_, i) => {
      const s = run?.steps?.[i + 1]?.status;
      const color = s === "done" ? t.ansi2 : s === "skipped" ? alpha(t.dim, "80") : at?.current === i + 1 ? t.accent : t.border;
      return div().flex_1().h(5).rounded(3).bg(color);
    }));
  }

  // A playbook's steps as a timeline: a node per step on a rail, its label and step, and the
  // agent's note under it. ✓ done, – skipped, the one in hand ringed and tagged "now".
  renderSteps(t, book, run) {
    const at = run ? progress(run, book.steps.length) : null;
    const last = book.steps.length - 1;
    return v_flex().children(book.steps.map(([label, step], i) => {
      const n = i + 1;
      const status = run?.steps?.[n]?.status ?? (at?.current === n ? "now" : null);
      const note = run?.steps?.[n]?.note;
      const now = status === "now";
      const node = status === "done"
        ? div().size(16).rounded_full().bg(t.ansi2).flex().items_center().justify_center().text_size(10).text_color(t.canvas).child("✓")
        : status === "skipped"
          ? div().size(16).rounded_full().border_1().border_color(t.dim).flex().items_center().justify_center().text_size(10).text_color(t.dim).child("–")
          : now
            ? div().size(16).rounded_full().border(2).border_color(t.accent).flex().items_center().justify_center().child(div().size(6).rounded_full().bg(t.accent))
            : div().size(16).rounded_full().border_1().border_color(t.border).flex().items_center().justify_center().text_size(9.5).text_color(t.dim).child(String(n));
      const lineColor = status === "done" || status === "skipped" ? alpha(t.ansi2, "60") : t.border;
      return h_flex().items_stretch().gap(12)
        .child(v_flex().w(16).flex_none().items_center()
          .child(div().mt(2).child(node))
          .child(i < last ? div().w(1.5).flex_1().bg(lineColor) : div()))
        .child(v_flex().flex_1().min_w(0).gap(3).pb(i < last ? 14 : 0)
          .child(h_flex().gap(8).items_center()
            .child(div().font_medium().text_color(now ? t.foreground : status === "done" ? t.foreground : status === "skipped" ? t.dim : t.muted).child(label))
            .when(now, (el) => el.child(div().px(6).h(16).flex().items_center().rounded(4).bg(alpha(t.accent, "33")).text_size(10).text_color(t.accent).child("now"))))
          .child(div().text_size(12).text_color(status === "skipped" ? t.dim : t.muted).whitespace_normal().child(step))
          .when(Boolean(note), (el) => el.child(div().mt(2).pl(8).border_l(2).border_color(t.border).text_size(11.5).text_color(t.muted).whitespace_normal().child(note))));
    }));
  }

  renderEnds(t, book) {
    return h_flex().gap(8).items_start().text_size(12)
      .child(div().flex_none().text_color(t.ansi2).child("Ends with"))
      .child(div().flex_1().min_w(0).text_color(t.muted).whitespace_normal().child(book.ends));
  }

  renderNoPlaybook(t) {
    return v_flex().gap(10).p(14).rounded(8).border_1().border_color(t.border).bg(t.canvas)
      .child(div().text_color(t.muted).whitespace_normal().child("No playbook yet. Start the card with a word to pick one, or let poteto-mode pick and report it with `kanban playbook`."))
      .child(h_flex().flex_wrap().gap(6).children(PLAYBOOK_LIST.filter((b) => b.words.length).map((b) =>
        h_flex().gap(6).px(8).h(22).items_center().rounded(5).border_1().border_color(t.border).text_size(11.5)
          .child(div().text_color(t.foreground).child(`${b.words[0]}:`)).child(div().text_color(t.dim).child(b.playbook)))));
  }

  keys(t, pairs) {
    const cap = (key) => div().h(18).min_w(18).px(5).flex().items_center().justify_center().rounded(4)
      .border_1().border_color(t.border).bg(t.background).text_size(10.5).text_color(t.muted).child(key);
    return h_flex().gap(14).items_center().children(pairs.map(([key, label]) =>
      h_flex().gap(5).items_center().child(cap(key)).child(label)));
  }
}
