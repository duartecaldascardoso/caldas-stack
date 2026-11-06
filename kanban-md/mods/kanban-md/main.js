// kanban-md: plain-text kanban boards for Herdr, one markdown file per board in ~/kanban.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { home, props, openOverlay, closeOverlay, readTextFile, writeTextFile, exec, focused, notify, settings, theme } from "herdr";
import {
  COLUMNS, emptyLanes, parse, serialize, boardName,
  addCard, editCard, removeCard, shiftCard, reorderCard, cardLink, withoutLink,
} from "./board.js";
import { prStatus, columnFor, describe, numberFromUrl } from "./links.js";

const DIR = `${home()}/kanban`;
const TRASH = `${DIR}/.trash`;
const REPOS = `${DIR}/.repos.json`; // board name -> repository folder, learnt from project boards
const DEFAULT_BOARD = "main";
const POLL_MS = 3000; // picks up edits made to the files elsewhere
const STATUS_MS = 60000; // linked pull requests, through gh
const HISTORY_LIMIT = 200;

const KEYS = {
  "left": "left", "h": "left", "right": "right", "l": "right",
  "up": "up", "k": "up", "down": "down", "j": "down",
  "shift-left": "shift-left", "shift-h": "shift-left", "shift-right": "shift-right", "shift-l": "shift-right",
  "shift-up": "shift-up", "shift-k": "shift-up", "shift-down": "shift-down", "shift-j": "shift-down",
  "n": "new", "a": "new", "enter": "open-card", "e": "edit", "d": "delete", "x": "delete", "backspace": "delete",
  "cmd-z": "undo", "cmd-shift-z": "redo",
  "[": "prev-board", "shift-tab": "prev-board", "]": "next-board", "tab": "next-board",
  "b": "new-board", "p": "project-board", "shift-d": "delete-board", "escape": "close",
  "g": "open-diff", "shift-2": "link", "@": "link", "o": "open-pr",
  "1": "column-1", "2": "column-2", "3": "column-3", "4": "column-4", "5": "column-5",
};

const HINT = "←→↑↓ move · ⇧ moves card · n new · e edit · d delete · ⌘z undo · [ ] board · b new board · ⇧d delete board";

const fileOf = (board) => `${DIR}/${board}.md`;

function storedBoard() {
  try { return localStorage.getItem("board"); } catch { return null; }
}

function storeBoard(board) {
  try { localStorage.setItem("board", board); } catch { /* not kept: opens the first board next time */ }
}

export default class Kanban extends View {
  init(_props, cx) {
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
    this.statuses = new Map(); // "<repo>#<number>" -> prStatus

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
    });
    cx.timer.every(POLL_MS, (cx) => { if (!this.editing) cx.spawn((cx) => this.refresh(cx)); });
    cx.timer.every(STATUS_MS, (cx) => { if (!this.editing) cx.spawn((cx) => this.syncStatuses(cx)); });
  }

  // Files

  async detectProject() {
    const cwd = focused()?.cwd;
    if (!cwd) return null;
    const git = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).catch(() => null);
    const root = git?.code === 0 ? git.stdout.trim() : cwd;
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
    if (text === null || text !== this.raw) {
      this.raw = text;
      this.lanes = parse(text);
      this.clampRows();
    }
    cx.notify();
  }

  save(cx) {
    const board = this.board;
    const text = serialize(board, this.lanes);
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

  openDiff(card) {
    const link = card && cardLink(card);
    if (!link) return;
    const repo = this.repoFor(this.board);
    if (!repo) {
      notify({ title: "No repository for this board", body: "Open the board from a terminal inside the project once.", level: "warning" });
      return;
    }
    openOverlay({
      mod: "snappy-diff", kind: "dialog", modal: true, width: 0.96, height: 0.92,
      props: link.pr ? { repo, pr: link.pr } : { repo, head: link.branch },
    });
  }

  // Links the selected card to the branch its board's repository is on: its pull request
  // when it has one, the branch itself otherwise.
  linkBranch(cx) {
    const { lanes, col } = this;
    const row = this.rows[col];
    const card = lanes[col][row];
    const repo = this.repoFor(this.board);
    if (card == null || !repo) return;
    cx.spawn(async (cx) => {
      const branch = (await exec("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      const pr = await exec("gh", ["pr", "view", "--json", "number", "-q", ".number"], { cwd: repo }).catch(() => null);
      const token = pr?.code === 0 && pr.stdout.trim() ? `#${pr.stdout.trim()}` : `@${branch}`;
      const old = cardLink(card)?.token;
      this.apply(editCard(this.lanes, col, row, old ? card.replace(old, token) : `${card} ${token}`), cx);
    });
  }

  // Pull requests: their state on the card, cards that follow it, and opening one.

  statusOf(card) {
    const link = card && cardLink(card);
    const repo = this.repoFor(this.board);
    return link?.pr && repo ? this.statuses.get(`${repo}#${link.pr}`) ?? null : null;
  }

  // Asks gh about every pull request on the open board, then moves the cards that should
  // follow: merged to done, open to test.
  async syncStatuses(cx) {
    const repo = await this.findRepo(this.board);
    if (!repo) return;
    const numbers = [...new Set(this.lanes.flat().map((card) => cardLink(card)?.pr).filter(Boolean))];
    await Promise.all(numbers.map(async (n) => {
      const result = await exec("gh", ["pr", "view", String(n), "--json", "state,isDraft,reviewDecision,statusCheckRollup"], { cwd: repo }).catch(() => null);
      if (result?.code !== 0) return;
      try { this.statuses.set(`${repo}#${n}`, prStatus(JSON.parse(result.stdout))); } catch { /* not JSON: skip it */ }
    }));
    this.followStatuses(cx);
    cx.notify();
  }

  followStatuses(cx) {
    const moves = [];
    const lanes = this.lanes.map((lane) => [...lane]);
    const columns = { test: COLUMNS.indexOf("Test"), done: COLUMNS.indexOf("Done") };
    this.lanes.forEach((lane, col) => lane.forEach((card) => {
      const status = this.statusOf(card);
      const to = status && columnFor(status, col, columns);
      if (to == null) return;
      lanes[col].splice(lanes[col].indexOf(card), 1);
      lanes[to].push(card);
      moves.push(`#${cardLink(card).pr} → ${COLUMNS[to].toLowerCase()}`);
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
  // card. Asks first, since both are seen by others.
  askPullRequest(cx) {
    const { col } = this;
    const row = this.rows[col];
    const card = this.lanes[col][row];
    if (card == null) return;
    const link = cardLink(card);
    if (link?.pr) { notify({ title: `Already linked to #${link.pr}`, level: "info", timeout: 2500 }); return; }
    const repo = this.repoFor(this.board);
    if (!repo) return;
    cx.spawn(async (cx) => {
      const branch = link?.branch ?? (await exec("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      if (!branch || branch === "HEAD" || ["main", "master"].includes(branch)) {
        notify({ title: "No branch to open a pull request from", body: "Link the card to a branch, or switch to one.", level: "warning" });
        return;
      }
      this.confirmingPr = { col, row, branch, repo, title: withoutLink(card) };
      cx.notify();
    });
  }

  openPullRequest({ col, row, branch, repo, title }, cx) {
    cx.spawn(async (cx) => {
      const lastLine = (text) => text.trim().split("\n").pop();
      const push = await exec("git", ["-C", repo, "push", "-u", "origin", branch]);
      if (push.code !== 0) { notify({ title: `Couldn't push ${branch}`, body: lastLine(push.stderr), level: "error" }); return; }
      const create = await exec("gh", ["pr", "create", "--head", branch, "--title", title, "--body", ""], { cwd: repo });
      const number = create.code === 0 && numberFromUrl(create.stdout);
      if (!number) { notify({ title: "Couldn't open the pull request", body: lastLine(create.stderr), level: "error" }); return; }
      notify({ title: `Opened pull request #${number}`, body: title, level: "success", timeout: 4000 });
      const card = this.lanes[col][row];
      if (card == null || withoutLink(card) !== title) return; // the board moved on; the pull request still exists
      const old = cardLink(card)?.token;
      this.apply(editCard(this.lanes, col, row, old ? card.replace(old, `#${number}`) : `${card} #${number}`), cx);
      await this.syncStatuses(cx);
    });
  }

  // View

  render() {
    const t = theme();
    const font = settings().font_family;
    return v_flex().id("kanban").track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .size_full().px(20).pt(14).pb(12).gap(14).bg(t.popover).text_color(t.foreground).text_size(13)
      .when(Boolean(font), (el) => el.font_family(font))
      .child(this.renderBoards(t))
      .child(h_flex().flex_1().min_h(0).gap(16).children(COLUMNS.map((name, c) => this.renderColumn(t, name, c))))
      .child(h_flex().text_size(11).child(this.renderHint(t)));
  }

  renderBoards(t) {
    const editingName = this.editing?.kind === "board";
    const tab = (board) => {
      const active = board === this.board;
      return div().id(`board-${board}`).px(8).py(4).rounded(5).cursor_pointer()
        .text_color(active ? t.foreground : t.dim).when(active, (el) => el.bg(t.raised))
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.openBoard(board, cx); this.handle.focus(); })
        .child(board === this.project ? `${board} ·` : board);
    };
    const add = div().id("board-new").px(8).py(4).rounded(5).cursor_pointer()
      .text_color(t.dim).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.startEdit({ kind: "board" }, "", cx))
      .child("+");
    return h_flex().items_center().gap(2)
      .children(this.boards.map(tab))
      .child(editingName ? div().w(160).ml(4).child(this.renderInput(t, "new-board")) : add);
  }

  renderColumn(t, name, c) {
    const active = c === this.col;
    const cards = this.lanes[c];
    const adding = this.editing?.kind === "card" && this.editing.col === c && this.editing.row === null;
    return v_flex().id(`col-${c}`).flex_1().min_w(0).h_full().gap(8)
      .on_click((_e, cx) => { if (!active) { this.col = c; this.handle.focus(); cx.notify(); } })
      .child(h_flex().px(12).pb(6).items_baseline().gap(6).border_b_1().border_color(active ? t.accent : t.border)
        .child(div().text_size(12).text_color(active ? t.foreground : t.dim).child(name.toLowerCase()))
        .child(div().text_size(11).text_color(t.dim).child(cards.length ? String(cards.length) : "")))
      .child(v_flex().id(`cards-${c}`).flex_1().min_h(0).overflow_y_scrollbar().gap(2)
        .children(cards.map((text, r) => this.renderCard(t, c, r, text)))
        .when(adding, (el) => el.child(this.renderInput(t, `new-${c}`))));
  }

  renderCard(t, c, r, text) {
    const editing = this.editing;
    if (editing?.kind === "card" && editing.col === c && editing.row === r) return this.renderInput(t, `edit-${c}-${r}`);
    const selected = !editing && c === this.col && r === this.rows[c];
    const done = c === COLUMNS.length - 1;
    const link = cardLink(text);
    return h_flex().id(`card-${c}-${r}`).rounded(6).bg(selected ? t.selected : t.popover)
      .cursor_pointer().hover((s) => s.bg(selected ? t.selected : t.hover))
      .on_click((event, cx) => {
        this.col = c;
        this.rows[c] = r;
        if (event.click_count > 1) this.startEdit({ kind: "card", col: c, row: r }, text, cx);
        else { this.handle.focus(); cx.notify(); }
      })
      .child(div().w(2).h_full().rounded(1).bg(selected ? t.accent : t.popover))
      .child(div().flex_1().min_w(0).px(10).py(7)
        .text_color(done ? t.dim : selected ? t.foreground : t.muted)
        .child(withoutLink(text)))
      .when(Boolean(link), (el) => el.child(this.renderLink(t, link, this.statusOf(text), done)));
  }

  // The card's pull request as a chip: a dot for its state, the number, then checks and review.
  renderLink(t, link, status, done) {
    const chip = h_flex().mr(8).px(7).py(2).gap(6).items_center().flex_none().rounded(5).bg(t.raised).text_size(11);
    if (link.branch) return chip.text_color(done ? t.dim : t.muted).child(`⎇ ${link.branch}`);
    const state = { open: t.ansi2, draft: t.dim, merged: t.ansi5, closed: t.ansi1 }[status?.state] ?? t.border;
    const checks = { passing: ["✓", t.ansi2], failing: ["✗", t.ansi1], pending: ["•", t.ansi3] }[status?.checks];
    const review = { approved: ["approved", t.ansi2], changes: ["changes", t.ansi1] }[status?.review];
    return chip
      .child(div().size(6).rounded(3).bg(state))
      .child(div().text_color(done ? t.dim : t.foreground).child(`#${link.pr}`))
      .when(Boolean(checks), (el) => el.child(div().text_color(checks[1]).child(checks[0])))
      .when(Boolean(review), (el) => el.child(div().text_color(review[1]).child(review[0])));
  }

  renderInput(t, id) {
    return div().id(id).h(32).px(10).flex().items_center().rounded(6).bg(t.background)
      .border_1().border_color(t.accent)
      .child(Input.new(this.input).w_full().text_color(t.foreground));
  }

  renderHint(t) {
    if (this.confirmingDelete) {
      return div().text_color(t.blocked).child(`Delete board "${this.board}"? y to confirm, any other key cancels`);
    }
    if (this.confirmingPr) {
      const { branch, title } = this.confirmingPr;
      return div().text_color(t.accent).child(`Push ${branch} and open a pull request "${title}"? y to confirm, any other key cancels`);
    }
    if (this.editing) return div().text_color(t.dim).child("enter save · esc cancel");
    const offer = this.project && !this.boards.includes(this.project) ? `p board for ${this.project} · ` : "";
    const card = this.lanes[this.col][this.rows[this.col]];
    const link = card != null ? cardLink(card) : null;
    const status = link?.pr && this.statusOf(card);
    const about = card == null ? ""
      : link?.pr ? `${status ? describe(link.pr, status) : `#${link.pr}`} · g open diff · `
      : link?.branch ? "g open diff · o open pull request · "
      : this.repoFor(this.board) ? "@ link branch · o open pull request · " : "";
    return div().text_color(t.dim).child(offer + about + HINT);
  }
}
