// kanban-md: plain-text kanban boards for Herdr, one markdown file per board in ~/kanban.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { home, props, closeOverlay, readTextFile, writeTextFile, exec, focused, settings, theme } from "herdr";
import {
  COLUMNS, emptyLanes, parse, serialize, boardName,
  addCard, editCard, removeCard, shiftCard, reorderCard,
} from "./board.js";

const DIR = `${home()}/kanban`;
const TRASH = `${DIR}/.trash`;
const DEFAULT_BOARD = "main";
const POLL_MS = 3000; // picks up edits made to the files elsewhere
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
    this.lanes = emptyLanes();
    this.raw = null; // the file as last read or written, to detect edits made elsewhere
    this.col = 0;
    this.rows = COLUMNS.map(() => 0);
    this.history = {}; // board -> { undo: [lanes], redo: [lanes] }
    this.editing = null; // { kind: "card", col, row } (row null: a new card) or { kind: "board" }
    this.confirmingDelete = false;

    this.input = InputState.new({ placeholder: "" });
    this.input.on("submit", (_e, cx) => this.commitEdit(cx));
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(300, () => { if (!this.editing) this.handle.focus(); });

    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", DIR]);
      this.project = await this.detectProject();
      await this.refresh(cx);
      if (this.boards.includes(this.project)) this.openBoard(this.project, cx);
    });
    cx.timer.every(POLL_MS, (cx) => { if (!this.editing) cx.spawn((cx) => this.refresh(cx)); });
  }

  // Files

  async detectProject() {
    const cwd = focused()?.cwd;
    if (!cwd) return null;
    const git = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).catch(() => null);
    const root = git?.code === 0 ? git.stdout.trim() : cwd;
    if (root === home() || root === "/") return null;
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
    cx.spawn((cx) => this.refresh(cx));
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
      case "close": return props()?.overlay && closeOverlay(props().overlay);
      default: {
        const column = action.match(/^column-(\d)$/);
        if (column) this.moveCursor(Number(column[1]) - 1 - col, 0, cx);
      }
    }
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
        .child(text));
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
    if (this.editing) return div().text_color(t.dim).child("enter save · esc cancel");
    const offer = this.project && !this.boards.includes(this.project) ? `p board for ${this.project} · ` : "";
    return div().text_color(t.dim).child(offer + HINT);
  }
}
