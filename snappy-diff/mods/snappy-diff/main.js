// snappy diff for Herdr: review a branch like a pull request, without leaving the window.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { props, closeOverlay, focused, notify, agents, panes, hc, settings, theme } from "herdr";
import * as git from "./git.js";
import { parsePatch, skippedFiles, firstChange } from "./patch.js";
import { languageOf } from "./syntax.js";
import { fileRows, wrapCount, wrapLines, segments } from "./rows.js";
import { treeRows, fileMatches, breakdown } from "./tree.js";
import { findMoves, isMoved } from "./moved.js";
import { reviewKey, rangeKey, sinceReview, emptyReview, isViewed, changedSinceViewed, toggleViewed, linesText, withStatus, reviewPrompt } from "./review.js";
import { DEFAULT_PREFS, readPrefs, writePrefs, readReview, writeReview, readLastReviewed, writeLastReviewed } from "./store.js";

const ICONS = "mods/snappy-diff/icons";
const CODE_SIZE = 12.5;
const LINE_H = 20;
const HEADER_H = 40;
const HUNK_H = 28;
const NOTICE_H = 40;
const TREE_ROW_H = 28;
const SIDEBAR_W = 288;
const SCROLLBAR_W = 12;
const COMMENT_LINE_H = 18;
const TOOLBAR_H = 48;
const MENU_LIST_H = 320;
const EDITOR_H = 96;
const REFRESH_MS = 2000; // uncommitted changes move under our feet
// Fixed-width parts of a file header, from the right edge, so a click can tell them apart.
const HEADER_PARTS = { viewed: 92, stats: 120, comments: 44, editor: 32 };
const HEADER_PAD = 14;
const RIGHT_MENUS = new Set(["settings", "agent", "kinds"]);
const EDITORS = { zed: "Zed", vscode: "VS Code", cursor: "Cursor" };
const SYNTAX = { keyword: "ansi5", string: "ansi2", number: "ansi3", constant: "ansi3", function: "ansi4", type: "ansi6", property: "ansi4" };

const icon = (name, size = 14) => svg(`${ICONS}/${name}.svg`).size(size).flex_none();
const alpha = (color, hex) => (/^#[0-9a-f]{6}$/i.test(color) ? color + hex : color);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A badge for a file's type, in place of an icon set: TS, {}, #, M↓ and the like.
function badge(name, t) {
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const table = {
    ts: ["TS", t.ansi4], tsx: ["TS", t.ansi4], mts: ["TS", t.ansi4], js: ["JS", t.ansi3], jsx: ["JS", t.ansi3], mjs: ["JS", t.ansi3],
    json: ["{}", t.ansi3], rs: ["RS", t.ansi1], py: ["PY", t.ansi4], go: ["GO", t.ansi6], md: ["M↓", t.ansi4], mdx: ["M↓", t.ansi4],
    css: ["#", t.ansi5], scss: ["#", t.ansi5], html: ["<>", t.ansi1], svg: ["<>", t.ansi3], yml: ["Y", t.ansi1], yaml: ["Y", t.ansi1],
    toml: ["T", t.ansi1], sh: ["$", t.ansi2], lock: ["≡", t.muted], sql: ["DB", t.ansi6],
  };
  const [label, color] = table[ext] ?? ["·", t.muted];
  return div().w(18).flex_none().text_size(9.5).font_semibold().text_color(color).child(label);
}

export default class SnappyDiff extends View {
  init(_props, cx) {
    this.prefs = DEFAULT_PREFS;
    this.source = null;
    this.refs = [];
    this.commits = [];
    this.files = [];
    this.text = "";
    this.rev = 0;
    this.loading = true;
    this.error = null;
    this.ms = null;
    this.reviewKey = "";
    this.review = emptyReview();
    this.comments = [];
    this.open = new Map(); // file id -> expanded, where someone chose
    this.closedDirs = new Set();
    this.filter = "";
    this.items = [];
    this.sizes = [];
    this.fileStarts = [];
    this.rowsCache = new Map();
    this.topIndex = 0;
    this.mainW = 0;
    this.charW = CODE_SIZE * 0.6;
    this.press = null; // where the last press over the diff landed, for row clicks
    this.menu = null; // "base" | "head" | "commit" | "settings"
    this.menuIndex = 0;
    this.palette = null; // "all" | "lines"
    this.paletteIndex = 0;
    this.editing = null; // the comment being written: { id, file, side, start, end }
    this.pr = null; // the pull request under review, with the head ref it was fetched to
    this.lastReviewed = {}; // range -> the head commit last reviewed there

    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.treeScroll = VirtualListScrollHandle.new();
    this.only = null; // a file opened from go-to or search, shown alone
    this.expanded = new Map(); // file id -> { lines, gaps }: separators opened to their lines
    this.moves = findMoves([]);
    this.filterInput = this.input("Filter files, or is:tests", (value) => { this.filter = value; });
    // Typing goes to the filter only while it has the keyboard.
    this.filterInput.on("focus", (_e, cx) => { this.filtering = true; cx.notify(); });
    this.filterInput.on("blur", (_e, cx) => { this.filtering = false; cx.notify(); });
    this.menuInput = this.input("Filter…", () => { this.menuIndex = 0; });
    this.paletteInput = this.input("", () => { this.paletteIndex = 0; });
    this.commentInput = InputState.new({ placeholder: "Leave a comment" });
    this.commentInput.on("submit", (_e, cx) => this.saveComment(cx));
    this.handle.focus();
    cx.timer.after(300, () => { if (!this.menu && !this.palette && !this.editing) this.handle.focus(); });

    cx.spawn((cx) => this.start(cx));
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  input(placeholder, onChange) {
    const state = InputState.new({ placeholder });
    state.on("change", (_e, cx) => { onChange(state.value()); cx.notify(); });
    return state;
  }

  // Loading

  async start(cx) {
    [this.prefs, this.lastReviewed] = await Promise.all([readPrefs(), readLastReviewed()]);
    // Whoever opened it can name what to show: { repo, base, head } or { repo, pr }. Otherwise
    // the focused terminal's repository.
    const given = props() ?? {};
    const dir = given.repo ?? focused()?.cwd;
    const repo = dir && await git.toplevel(dir);
    if (!repo) {
      this.loading = false;
      this.error = "Not in a git repository. Open this from a terminal inside one.";
      return cx.notify();
    }
    const [base, branch, dirty, refs] = await Promise.all([git.defaultBase(repo), git.currentBranch(repo), git.isDirty(repo), git.refs(repo)]);
    this.refs = refs;
    this.branch = branch;
    if (given.pr) return this.openPullRequest(repo, given.pr, cx);
    // With uncommitted work, show it on top of the branch; otherwise the branch, like a PR.
    const head = given.head ?? (dirty || base === git.EMPTY_TREE ? "" : branch);
    await this.load({ repo, base: given.base ?? base, head, commit: null, ignoreWhitespace: false }, cx);
    // The branch's pull request, looked up after the diff shows so it never slows it down.
    // It knows the real base: switch to it unless someone already moved on.
    if (!head || given.base || base === git.EMPTY_TREE) return;
    const pr = await git.pullRequest(repo);
    if (!pr || pr.headRefName !== head) return;
    this.pr = { ...pr, head };
    const prBase = `origin/${pr.baseRefName}`;
    if (this.source.head === head && this.source.base === base && prBase !== base && this.refs.includes(prBase)) await this.load({ ...this.source, base: prBase }, cx);
    cx.notify();
  }

  async openPullRequest(repo, number, cx) {
    this.error = null;
    this.loadingMessage = `Fetching pull request #${number}…`;
    cx.notify();
    const pr = await git.pullRequest(repo, number);
    if (!pr) {
      this.loading = false;
      this.error = `Couldn't find pull request #${number}. Is the GitHub CLI (gh) installed and signed in?`;
      return cx.notify();
    }
    try {
      const { base, head } = await git.fetchPullRequest(repo, pr);
      this.pr = { ...pr, head };
      this.refs = await git.refs(repo);
      await this.load({ repo, base, head, commit: null, ignoreWhitespace: false }, cx);
    } catch (e) {
      this.loading = false;
      this.error = String(e.message ?? e);
      cx.notify();
    }
  }

  async load(source, cx) {
    const rev = ++this.rev;
    const started = Date.now();
    this.source = source;
    this.loading = true;
    this.error = null;
    cx.notify();
    try {
      const [{ text, skipped }, commits] = await Promise.all([git.diff(source), git.commits(source.repo, source.base, source.head)]);
      if (rev !== this.rev) return;
      const key = reviewKey(source);
      const sameReview = key === this.reviewKey && this.files.length > 0 && source.since === this.shownSince;
      if (key !== this.reviewKey) {
        this.review = await readReview(key);
        this.reviewKey = key;
        this.open = new Map();
        this.scroll.scroll_to_item(0, "top");
      }
      const before = this.openCommentIds();
      this.text = text;
      this.files = [...parsePatch(text, rev), ...skippedFiles(skipped, rev)];
      this.moves = findMoves(this.files);
      this.shownSince = source.since ?? null;
      if (key !== this.reviewKey || !this.files.some((f) => f.id === this.only)) this.only = null;
      this.commits = commits;
      this.ms = Date.now() - started;
      if (sameReview) this.noticeAddressed(before);
    } catch (e) {
      if (rev !== this.rev) return;
      this.files = [];
      this.error = String(e.message ?? e);
    }
    this.loading = false;
    this.rebuild();
    cx.notify();
  }

  refresh(cx) {
    const source = this.source;
    if (!source || source.head || source.commit || this.loading || this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const { text, skipped } = await git.diff(source);
        if (source !== this.source || text === this.text) return;
        const before = this.openCommentIds();
        this.text = text;
        const rev = ++this.rev;
        this.files = [...parsePatch(text, rev, this.files), ...skippedFiles(skipped, rev)];
        this.moves = findMoves(this.files);
        if (!this.files.some((f) => f.id === this.only)) this.only = null;
        this.noticeAddressed(before);
        this.rebuild();
        cx.notify();
      } catch {
        // Keep the last good diff; the next tick tries again.
      } finally {
        this.busy = false;
      }
    });
  }

  reload(change, cx) {
    this.menu = null;
    this.handle.focus();
    const moved = ["base", "head", "commit"].some((k) => k in change);
    cx.spawn((cx) => this.load({ ...this.source, ...(moved ? { since: null } : {}), ...change }, cx));
  }

  setPref(key, value, cx) {
    this.prefs = { ...this.prefs, [key]: value };
    writePrefs(this.prefs);
    this.rebuild();
    cx.notify();
  }

  // The rows the diff view draws

  isCollapsed(file) {
    return this.open.has(file.id) ? !this.open.get(file.id) : isViewed(this.review, file) || file.generated || file.large;
  }

  metrics() {
    const width = Math.max(320, this.mainW - SCROLLBAR_W);
    const digits = Math.max(3, ...this.files.map((f) => String(Math.max(...f.hunks.map((h) => Math.max(h.oldStart + h.oldCount, h.newStart + h.newCount)), 1)).length));
    const number = digits * this.charW + 20;
    if (this.prefs.diffStyle === "split") {
      const side = Math.floor(width / 2);
      return { width, side, number, cols: Math.max(10, Math.floor((side - number - 16) / this.charW)) };
    }
    return { width, side: width, number, cols: Math.max(10, Math.floor((width - 2 * number - 24) / this.charW)) };
  }

  rowsFor(file) {
    const open = this.expanded.get(file.id);
    const key = `${file.id}|${file.rev}|${this.prefs.diffStyle}|${open ? [...open.gaps].join(",") : ""}`;
    if (!this.rowsCache.has(key)) this.rowsCache.set(key, fileRows(file, this.prefs.diffStyle, languageOf(file.name), open));
    return this.rowsCache.get(key);
  }

  // Opens a separator: loads the file's text once, then shows the lines it hid.
  expandGap(file, hunk, cx) {
    const open = this.expanded.get(file.id);
    if (open?.lines) {
      this.expanded.set(file.id, { ...open, gaps: new Set([...open.gaps, hunk]) });
      this.rebuild();
      return cx.notify();
    }
    cx.spawn(async (cx) => {
      const text = await git.fileText(this.source.repo, file, !this.source.head && !this.source.commit).catch(() => null);
      if (text == null) {
        notify({ title: "Couldn't load the hidden lines", body: file.name, level: "warning", timeout: 2500 });
        return;
      }
      this.expanded.set(file.id, { lines: text.replaceAll("\t", "    ").split("\n"), gaps: new Set([hunk]) });
      this.rebuild();
      cx.notify();
    });
  }

  rebuild() {
    this.comments = withStatus(this.review.comments, this.files);
    const m = this.metrics();
    const commentCols = Math.max(20, Math.floor((m.width - 120) / 7));
    const items = [];
    const sizes = [];
    const push = (item, size) => { items.push(item); sizes.push(size); };
    this.fileStarts = [];
    this.headerIndex = new Map();
    for (const f of this.only ? this.files.filter((file) => file.id === this.only) : this.files) {
      this.fileStarts.push(items.length);
      this.headerIndex.set(f.id, items.length);
      push({ t: "file", f }, HEADER_H);
      if (this.isCollapsed(f)) continue;
      const notes = new Map();
      for (const c of this.comments) if (c.file === f.id && !c.outdated) notes.set(`${c.side}:${c.end}`, [...(notes.get(`${c.side}:${c.end}`) ?? []), c]);
      for (const row of this.rowsFor(f)) {
        if (row.t === "hunk") { push({ ...row, f }, HUNK_H); continue; }
        if (row.t === "notice") { push({ ...row, f }, NOTICE_H); continue; }
        const lines = row.t === "split"
          ? Math.max(row.left ? wrapCount(row.left.text, m.cols) : 1, row.right ? wrapCount(row.right.text, m.cols) : 1)
          : wrapCount(row.cell.text, m.cols);
        push({ ...row, f }, lines * LINE_H);
        // Comments and the open editor go under the last line they are on.
        for (const [side, n] of this.rowSides(row)) {
          for (const c of notes.get(`${side}:${n}`) ?? []) {
            if (c.id === this.editing?.id) continue;
            push({ t: "comment", c, f }, 52 + wrapCount(c.text, commentCols) * COMMENT_LINE_H);
          }
          const e = this.editing;
          if (e && e.file === f.id && e.side === side && e.end === n) push({ t: "editor", e, f }, EDITOR_H);
        }
      }
    }
    this.items = items;
    this.sizes = sizes;
  }

  // The [side, line number] pairs a row shows, for anchoring comments.
  rowSides(row) {
    if (row.t === "split") {
      const sides = [];
      if (row.left && row.left.kind !== "ctx") sides.push(["old", row.left.n]);
      if (row.right) sides.push(["new", row.right.n]);
      return sides;
    }
    return row.cell.kind === "del" ? [["old", row.old]] : [["new", row.new]];
  }

  activeFile() {
    let lo = 0;
    let hi = this.fileStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.fileStarts[mid] <= this.topIndex) lo = mid;
      else hi = mid - 1;
    }
    return this.only ? this.files.find((f) => f.id === this.only) : this.files[lo];
  }

  // Moving around

  // Shows one file on its own, as opening it from go-to or search does.
  focusFile(id, cx) {
    this.only = id;
    this.open.set(id, true);
    this.rebuild();
    this.topIndex = 0;
    this.scroll.scroll_to_item(0, "top");
    this.followTree(id);
    cx.notify();
  }

  showAll(cx) {
    const id = this.only;
    this.only = null;
    this.rebuild();
    if (id) this.jumpToFile(id, cx);
    cx.notify();
  }

  jumpToFile(id, cx) {
    if (this.only) return this.focusFile(id, cx);
    const file = this.files.find((f) => f.id === id);
    if (!file) return;
    if (this.isCollapsed(file)) this.open.set(id, true);
    this.rebuild();
    const index = this.headerIndex.get(id);
    this.topIndex = index;
    this.scroll.scroll_to_item(index, "top");
    this.followTree(id);
    cx.notify();
  }

  jumpToLine(id, side, n, cx) {
    this.open.set(id, true);
    this.rebuild();
    const index = this.items.findIndex((item, i) => i >= this.headerIndex.get(id) && item.f.id === id && this.rowSides(item.t === "split" || item.t === "unified" ? item : { t: "unified", cell: { kind: "ctx" }, new: -1 }).some(([s, m]) => (s === side || item.t === "split") && m === n));
    if (index >= 0) { this.topIndex = index; this.scroll.scroll_to_item(index, "center"); }
    cx.notify();
  }

  // The files j and k move between: what the sidebar filter shows.
  shown() {
    return this.filter.trim() ? this.files.filter((f) => fileMatches(f, this.filter)) : this.files;
  }

  step(by, cx) {
    const order = new Map(this.files.map((f, i) => [f.id, i]));
    const at = order.get(this.activeFile()?.id) ?? -1;
    const shown = this.shown();
    const next = by > 0 ? shown.find((f) => order.get(f.id) > at) : shown.findLast((f) => order.get(f.id) < at);
    if (next) this.jumpToFile(next.id, cx);
  }

  reviewNext(cx) {
    const pending = this.shown().filter((f) => !isViewed(this.review, f));
    const active = this.activeFile()?.id;
    const next = pending.find((f) => f.id !== active) ?? pending[0];
    if (next) this.jumpToFile(next.id, cx);
  }

  followTree(id) {
    const index = this.tree().findIndex((row) => row.kind === "file" && row.id === id);
    if (index >= 0) this.treeScroll.scroll_to_item(index, "center");
  }

  tree() {
    return treeRows(this.shown(), this.closedDirs);
  }

  // Review

  setReview(review) {
    this.review = review;
    writeReview(this.reviewKey, review);
    this.markReviewed();
  }

  // Reviewing anything (a viewed mark, a comment) remembers the branch tip you reviewed, so
  // commits pushed on top later can be reviewed on their own.
  markReviewed() {
    const key = this.source && rangeKey(this.source);
    const tip = this.commits[0]?.sha;
    if (!key || !tip || this.lastReviewed[key] === tip) return;
    this.lastReviewed = { ...this.lastReviewed, [key]: tip };
    writeLastReviewed(this.lastReviewed);
  }

  sinceReview() {
    const key = this.source && rangeKey(this.source);
    return key ? sinceReview(this.lastReviewed[key], this.commits) : null;
  }

  toggleViewed(file, cx, advance = false) {
    const wasViewed = isViewed(this.review, file);
    this.setReview(toggleViewed(this.review, file));
    this.open.delete(file.id); // follows its viewed state again: collapses once viewed
    this.rebuild();
    if (advance && !wasViewed) this.step(1, cx);
    cx.notify();
  }

  toggleCollapsed(file, cx) {
    this.open.set(file.id, this.isCollapsed(file));
    this.rebuild();
    cx.notify();
  }

  toggleAll(cx) {
    const expand = this.files.every((f) => this.isCollapsed(f));
    for (const f of this.files) this.open.set(f.id, expand);
    this.rebuild();
    cx.notify();
  }

  startComment(file, side, n, extend, cx) {
    const anchor = extend && this.anchor?.file === file.id && this.anchor.side === side ? this.anchor.n : n;
    this.anchor = { file: file.id, side, n };
    this.editing = { id: crypto.randomUUID(), file: file.id, side, start: Math.min(anchor, n), end: Math.max(anchor, n) };
    this.commentInput.set_value("");
    this.commentInput.focus();
    this.rebuild();
    cx.notify();
  }

  editComment(comment, cx) {
    this.editing = { id: comment.id, file: comment.file, side: comment.side, start: comment.start, end: comment.end };
    this.commentInput.set_value(comment.text);
    this.commentInput.focus();
    this.rebuild();
    cx.notify();
  }

  saveComment(cx) {
    const e = this.editing;
    const text = this.commentInput.value().trim();
    if (!e) return;
    if (text) {
      const file = this.files.find((f) => f.id === e.file);
      const comment = { ...e, text, code: file ? linesText(file, e.side, e.start, e.end) : null };
      this.setReview({ ...this.review, comments: [...this.review.comments.filter((c) => c.id !== e.id), comment] });
    }
    this.cancelComment(cx);
  }

  cancelComment(cx) {
    this.editing = null;
    this.handle.focus();
    this.rebuild();
    cx.notify();
  }

  deleteComment(id, cx) {
    this.setReview({ ...this.review, comments: this.review.comments.filter((c) => c.id !== id) });
    this.rebuild();
    cx.notify();
  }

  subject() {
    const s = this.source;
    if (s.commit) return `commit ${s.commit.slice(0, 7)}`;
    return s.head ? `the changes in \`${s.base}...${s.head}\`` : `my uncommitted changes (against \`${s.base}\`)`;
  }

  openCommentIds() {
    return new Set(withStatus(this.review.comments, this.files).filter((c) => !c.outdated).map((c) => c.id));
  }

  // When a refresh shows commented code changed (an agent at work, say), say so.
  noticeAddressed(before) {
    const now = this.openCommentIds();
    const addressed = [...before].filter((id) => !now.has(id)).length;
    if (!addressed) return;
    notify({ title: `${plural(addressed, "comment")} addressed`, body: "The code they were on has changed.", level: "success", timeout: 4000 });
  }

  // The agents that could take this review: those whose terminal is on the branch under
  // review, then any others inside the repository, most recently active first.
  reviewAgents() {
    const s = this.source;
    if (!s) return [];
    const branch = this.pr?.headRefName ?? (s.head ? s.head.replace(/^origin\//, "") : this.branch);
    const byPane = new Map(panes().map((p) => [p.pane, p]));
    return agents()
      .map((agent) => ({ agent, pane: byPane.get(agent.pane) }))
      .filter(({ pane }) => pane?.cwd && (pane.cwd === s.repo || pane.cwd.startsWith(`${s.repo}/`) || (branch && pane.branch === branch)))
      .sort((a, b) => (b.pane.branch === branch) - (a.pane.branch === branch) || b.agent.seq - a.agent.seq);
  }

  sendToAgent(cx, chosen) {
    const open = this.comments.filter((c) => !c.outdated);
    if (!open.length) return;
    const candidates = this.reviewAgents();
    if (!chosen && candidates.length > 1) return this.openMenu("agent", cx);
    const target = chosen ?? candidates[0];
    if (!target) {
      notify({ title: "No agent in this repository", body: "Start one here, or copy the review instead.", level: "warning" });
      return;
    }
    this.menu = null;
    this.handle.focus();
    const name = target.agent.tab_name || target.agent.title || target.agent.address;
    cx.spawn(async () => {
      const result = await hc(["send", target.agent.address, reviewPrompt(this.subject(), open, this.files)]);
      if (result.code === 0) notify({ title: `Sent ${plural(open.length, "comment")} to ${name}`, body: "You'll hear when the code they're on changes.", level: "success", timeout: 3000 });
      else notify({ title: `Couldn't send to ${name}`, body: (result.stderr || result.stdout).trim().split("\n").pop(), level: "error" });
    });
  }

  copyReview(cx) {
    const open = this.comments.filter((c) => !c.outdated);
    if (!open.length) return;
    cx.write_to_clipboard(reviewPrompt(this.subject(), open, this.files));
    notify({ title: "Review copied", body: `${plural(open.length, "comment")} as a prompt, ready to paste`, level: "success", timeout: 2500 });
  }

  openInEditor(file, cx) {
    if (!file || file.type === "deleted") return;
    const path = encodeURI(`${this.source.repo}/${file.name}`);
    cx.open_url(`${this.prefs.editor}://file${path}:${firstChange(file)}`);
  }

  close() {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  // Keys

  onKey(event, cx) {
    const k = event.keystroke;
    if (this.palette) return this.paletteKey(k, cx);
    if (this.menu) return this.menuKey(k, cx);
    if (this.editing) {
      if (k === "escape") { this.cancelComment(cx); cx.stop_propagation(); }
      return;
    }
    if (this.filtering) {
      if (k === "escape") { this.filterInput.set_value(""); this.filter = ""; this.filtering = false; this.handle.focus(); cx.notify(); cx.stop_propagation(); }
      if (k === "enter") { const first = this.shown()[0]; if (first) this.jumpToFile(first.id, cx); this.handle.focus(); cx.stop_propagation(); }
      return;
    }
    const actions = {
      "j": () => this.step(1, cx),
      "k": () => this.step(-1, cx),
      "n": () => this.reviewNext(cx),
      "v": () => { const f = this.activeFile(); if (f) this.toggleViewed(f, cx, true); },
      "o": () => this.openInEditor(this.activeFile(), cx),
      "x": () => { const f = this.activeFile(); if (f) this.toggleCollapsed(f, cx); },
      "/": () => { if (!this.prefs.sidebar) this.setPref("sidebar", true, cx); this.filterInput.focus(); },
      "cmd-b": () => this.setPref("sidebar", !this.prefs.sidebar, cx),
      "cmd-k": () => this.openPalette("all", cx),
      "cmd-f": () => this.openPalette("lines", cx),
      "shift-/": () => this.openMenu("settings", cx),
      "?": () => this.openMenu("settings", cx),
      "escape": () => (this.only ? this.showAll(cx) : this.close()),
    };
    if (actions[k]) { actions[k](); cx.stop_propagation(); }
  }

  // Pickers: base, head, commit and settings

  // Menus drop below the button that opened them: its window bounds come from the press, the
  // view's own from the same press reaching the root.
  openMenu(name, cx) {
    this.menu = this.menu === name ? null : name;
    const button = this.pressed;
    const view = this.viewBounds;
    this.menuAt = button && view
      ? (RIGHT_MENUS.has(name) ? { right: view.x + view.width - (button.x + button.width) } : { left: button.x - view.x })
      : { right: 10 };
    this.pressed = null;
    this.menuIndex = 0;
    this.menuInput.set_value("");
    if (this.menu && name !== "settings") this.menuInput.focus();
    else this.handle.focus();
    cx.notify();
  }

  menuOptions() {
    const s = this.source;
    const query = this.menuInput.value().toLowerCase();
    const refs = [...new Set([...this.refs, s.base, s.head].filter(Boolean))];
    const match = (o) => !query || o.label.toLowerCase().includes(query);
    if (this.menu === "base") return refs.map((r) => ({ label: r, current: r === s.base, pick: (cx) => this.reload({ base: r, commit: null }, cx) })).filter(match);
    if (this.menu === "head") {
      return [{ label: "Working tree", current: !s.head, pick: (cx) => this.reload({ head: "", commit: null }, cx) },
        ...refs.map((r) => ({ label: r, current: r === s.head, pick: (cx) => this.reload({ head: r, commit: null }, cx) }))].filter(match);
    }
    if (this.menu === "kinds") {
      return breakdown(this.files).map((k) => ({
        label: k.label, hint: `+${k.add.toLocaleString()} −${k.del.toLocaleString()}`,
        current: this.filter.trim() === `is:${k.id}`,
        pick: (cx) => {
          this.menu = null;
          this.filterInput.set_value(`is:${k.id}`);
          this.filter = `is:${k.id}`;
          if (!this.prefs.sidebar) this.setPref("sidebar", true, cx);
          this.handle.focus();
          cx.notify();
        },
      }));
    }
    if (this.menu === "agent") {
      return this.reviewAgents().map((candidate) => ({
        label: candidate.agent.tab_name || candidate.agent.title,
        hint: [candidate.agent.app, candidate.pane.branch, candidate.agent.status].filter(Boolean).join(" · "),
        pick: (cx) => this.sendToAgent(cx, candidate),
      })).filter(match);
    }
    if (this.menu === "commit") {
      return [{ label: `All ${this.commits.length} commits`, current: !s.commit, pick: (cx) => this.reload({ commit: null }, cx) },
        ...this.commits.map((c) => ({ label: `${c.sha.slice(0, 7)} ${c.subject}`, hint: `${c.author}, ${c.date}`, current: c.sha === s.commit, pick: (cx) => this.reload({ commit: c.sha }, cx) }))].filter(match);
    }
    const next = (list, value) => list[(list.indexOf(value) + 1) % list.length];
    return [
      { label: `Layout: ${this.prefs.diffStyle === "split" ? "Split" : "Unified"}`, pick: (cx) => this.setPref("diffStyle", next(["split", "unified"], this.prefs.diffStyle), cx) },
      { label: `Ignore whitespace: ${s.ignoreWhitespace ? "On" : "Off"}`, pick: (cx) => this.reload({ ignoreWhitespace: !s.ignoreWhitespace }, cx) },
      { label: `Open files in: ${EDITORS[this.prefs.editor]}`, pick: (cx) => this.setPref("editor", next(Object.keys(EDITORS), this.prefs.editor), cx) },
      { label: `Sidebar: ${this.prefs.sidebar ? "Shown" : "Hidden"}`, pick: (cx) => this.setPref("sidebar", !this.prefs.sidebar, cx) },
    ];
  }

  menuKey(k, cx) {
    const options = this.menuOptions();
    if (k === "escape") { this.menu = null; this.handle.focus(); }
    else if (k === "down") this.menuIndex = Math.min(options.length - 1, this.menuIndex + 1);
    else if (k === "up") this.menuIndex = Math.max(0, this.menuIndex - 1);
    else if (k === "enter") options[this.menuIndex]?.pick(cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // Go to (cmd-k) and search (cmd-f)

  openPalette(mode, cx) {
    this.palette = this.palette === mode ? null : mode;
    this.paletteIndex = 0;
    this.paletteInput.set_value("");
    if (this.palette) this.paletteInput.focus();
    else this.handle.focus();
    cx.notify();
  }

  paletteResults() {
    const query = this.paletteInput.value().trim();
    if (this.palette === "lines") {
      if (query.length < 2) return [];
      const needle = query.toLowerCase();
      const out = [];
      for (const f of this.files) {
        for (const h of f.hunks) {
          let old = h.oldStart;
          let next = h.newStart;
          for (const line of h.lines) {
            const side = line.kind === "-" ? "old" : "new";
            const n = side === "old" ? old : next;
            if (line.kind !== "+") old++;
            if (line.kind !== "-") next++;
            if (!line.text.toLowerCase().includes(needle)) continue;
            out.push({ label: line.text.trim(), hint: `${f.name}:${n}`, run: (cx) => { this.focusFile(f.id, cx); this.jumpToLine(f.id, side, n, cx); } });
            if (out.length >= 100) return out;
          }
        }
      }
      return out;
    }
    const s = this.source;
    const files = this.files.filter((f) => !query || fileMatches(f, query)).slice(0, 40)
      .map((f) => ({ label: f.name, hint: `+${f.add} −${f.del}`, run: (cx) => this.focusFile(f.id, cx) }));
    const commits = this.commits.filter((c) => !query || `${c.sha} ${c.subject}`.toLowerCase().includes(query.toLowerCase())).slice(0, 20)
      .map((c) => ({ label: `${c.sha.slice(0, 7)} ${c.subject}`, hint: "commit", run: (cx) => this.reload({ commit: c.sha }, cx) }));
    const actions = [
      ["Review next unviewed file", "n", (cx) => this.reviewNext(cx)],
      ["Mark file viewed", "v", (cx) => { const f = this.activeFile(); if (f) this.toggleViewed(f, cx, true); }],
      ["Open file in " + EDITORS[this.prefs.editor], "o", (cx) => this.openInEditor(this.activeFile(), cx)],
      ["Send comments to the agent", "", (cx) => this.sendToAgent(cx)],
      ["Copy comments as a prompt", "", (cx) => this.copyReview(cx)],
      ["Toggle sidebar", "⌘B", (cx) => this.setPref("sidebar", !this.prefs.sidebar, cx)],
      [this.prefs.diffStyle === "split" ? "Unified view" : "Split view", "", (cx) => this.setPref("diffStyle", this.prefs.diffStyle === "split" ? "unified" : "split", cx)],
      ["Collapse or expand all files", "", (cx) => this.toggleAll(cx)],
      [`${s.ignoreWhitespace ? "Show" : "Ignore"} whitespace changes`, "", (cx) => this.reload({ ignoreWhitespace: !s.ignoreWhitespace }, cx)],
      ["Reload", "", (cx) => this.reload({}, cx)],
    ].filter(([label]) => !query || label.toLowerCase().includes(query.toLowerCase()))
      .map(([label, hint, run]) => ({ label, hint: hint || "action", run }));
    return [...files, ...commits, ...actions];
  }

  paletteKey(k, cx) {
    const results = this.paletteResults();
    if (k === "escape") { this.palette = null; this.handle.focus(); }
    else if (k === "down") this.paletteIndex = Math.min(results.length - 1, this.paletteIndex + 1);
    else if (k === "up") this.paletteIndex = Math.max(0, this.paletteIndex - 1);
    else if (k === "enter") this.pickResult(results[this.paletteIndex], cx);
    else if (k === "cmd-k" || k === "cmd-f") this.openPalette(k === "cmd-k" ? "all" : "lines", cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  pickResult(result, cx) {
    if (!result) return;
    this.palette = null;
    this.handle.focus();
    result.run(cx);
  }

  // Clicks on diff rows: one handler for the list, told apart by where the press landed.

  // Which part of a file header a press `fromRight` px from its right edge landed on.
  headerPart(fromRight) {
    const x = fromRight - HEADER_PAD;
    const editorAt = HEADER_PARTS.viewed + HEADER_PARTS.stats + HEADER_PARTS.comments;
    if (x < HEADER_PARTS.viewed) return "viewed";
    if (x >= editorAt && x < editorAt + HEADER_PARTS.editor) return "editor";
    return "header";
  }

  pressHeader(file, part, cx) {
    if (part === "viewed") return this.toggleViewed(file, cx);
    if (part === "editor") return this.openInEditor(file, cx);
    return this.toggleCollapsed(file, cx);
  }

  clickRow(key, cx) {
    const item = this.items[Number(key)];
    const press = this.press;
    if (!item || !press) return;
    const m = this.metrics();
    const fromRight = this.mainW - press.x;
    const f = item.f;
    if (item.t === "file") return this.pressHeader(f, this.headerPart(fromRight), cx);
    if (item.t === "hunk") return this.expandGap(f, item.hunk, cx);
    // Comment cards: 16px row padding, a 1px border and 10px card padding before the buttons,
    // which are fixed-width and right-aligned (renderComment, renderEditor).
    const inCard = fromRight - 27;
    if (item.t === "comment") {
      if (inCard >= 0 && inCard < 54) return this.deleteComment(item.c.id, cx);
      if (inCard >= 54 && inCard < 108) return this.editComment(item.c, cx);
      return;
    }
    if (item.t === "editor") {
      if (inCard >= 0 && inCard < 84) return this.saveComment(cx);
      if (inCard >= 84 && inCard < 162) return this.cancelComment(cx);
      return;
    }
    if (item.t === "split") {
      const left = press.x < m.side;
      const x = left ? press.x : press.x - m.side;
      const cell = left ? item.left : item.right;
      if (cell && x < m.number) this.startComment(f, left && cell.kind !== "ctx" ? "old" : "new", cell.n, press.shift, cx);
    } else if (item.t === "unified" && press.x < 2 * m.number) {
      const side = item.cell.kind === "del" ? "old" : "new";
      this.startComment(f, side, side === "old" ? item.old : item.new, press.shift, cx);
    }
  }

  // View

  render(cx) {
    const t = theme();
    const code = settings().font_family;
    const active = this.activeFile();
    return v_flex().id("snappy").track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .size_full().relative().bg(t.background).text_color(t.foreground).text_size(13)
      .child(this.renderToolbar(t))
      .child(h_flex().flex_1().min_h(0)
        .when(this.prefs.sidebar, (el) => el.child(this.renderSidebar(t, active)))
        .child(this.renderMain(t, code, active)))
      .on_mouse_down("left", (e) => { if (e.bounds) this.viewBounds = e.bounds; })
      .when(Boolean(this.menu) && Boolean(this.source), (el) => el.child(this.renderMenu(t)))
      .when(Boolean(this.palette), (el) => el.child(this.renderPalette(t)))
      // Measures the code font's character width, which wrapping is computed from.
      .child(div().id("probe").absolute().top(-100).left(0).opacity(0).whitespace_nowrap().text_size(CODE_SIZE)
        .when(Boolean(code), (el) => el.font_family(code))
        .on_size_change((size, cx) => {
          const width = size.width / 100;
          if (width > 0 && Math.abs(width - this.charW) > 0.01) { this.charW = width; this.rebuild(); cx.notify(); }
        })
        .child("0".repeat(100)));
  }

  // Remembers where a menu's button is, for the menu to drop below it.
  pressAt(event) {
    if (event.bounds) this.pressed = event.bounds;
  }

  button(id, content, onClick, { active = false } = {}) {
    const t = theme();
    return h_flex().id(id).h(28).px(8).gap(6).items_center().rounded(6).cursor_pointer().flex_none()
      .on_mouse_down("left", (e) => this.pressAt(e))
      .text_color(active ? t.foreground : t.muted).when(active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => onClick(cx))
      .children(Array.isArray(content) ? content : [content]);
  }

  renderToolbar(t) {
    const s = this.source;
    const files = this.files;
    const add = files.reduce((n, f) => n + f.add, 0);
    const del = files.reduce((n, f) => n + f.del, 0);
    const viewed = files.filter((f) => isViewed(this.review, f)).length;
    const openComments = this.comments.filter((c) => !c.outdated).length;
    const picker = (name, label, mono = true) => {
      const trigger = h_flex().id(`pick-${name}`).h(28).px(10).gap(8).items_center().rounded(6).border_1().border_color(t.border)
        .cursor_pointer().hover((st) => st.bg(t.hover)).flex_none()
        .on_mouse_down("left", (e) => this.pressAt(e))
        .on_click((_e, cx) => this.openMenu(name, cx))
        .child(div().max_w(220).truncate().text_size(12.5).when(mono, (el) => el.font_family(settings().font_family)).child(label))
        .child(div().text_color(t.dim).child(icon("chevron-down", 12)));
      return trigger;
    };
    return h_flex().id("toolbar").h(TOOLBAR_H).flex_none().px(10).gap(6).items_center().border_b_1().border_color(t.border).bg(t.background)
      .child(this.button("sidebar", icon("panel"), (cx) => this.setPref("sidebar", !this.prefs.sidebar, cx)))
      .child(div().mr(4).text_size(14).font_semibold().whitespace_nowrap().child("snappy diff"))
      .when(Boolean(s), (el) => el
        .child(picker("base", s.base === git.EMPTY_TREE ? "No commits yet" : s.base, s.base !== git.EMPTY_TREE))
        .child(this.button("swap", icon("swap"), (cx) => s.head && this.reload({ base: s.head, head: s.base, commit: null }, cx)))
        .child(picker("head", s.head || "Working tree", Boolean(s.head)))
        .when(this.commits.length > 1, (el) => el.child(picker("commit", s.commit ? `${s.commit.slice(0, 7)} ${this.commits.find((c) => c.sha === s.commit)?.subject ?? ""}` : `All ${this.commits.length} commits`, false)))
        .child(this.button("reload", icon("reload"), (cx) => this.reload({}, cx)))
        .child(this.button("whitespace", icon("pilcrow"), (cx) => this.reload({ ignoreWhitespace: !s.ignoreWhitespace }, cx), { active: s.ignoreWhitespace }))
        .when(Boolean(s.since), (el) => el.child(h_flex().id("since").h(28).px(10).gap(6).items_center().rounded(6).cursor_pointer()
          .bg(alpha(t.accent, "26")).text_size(12).text_color(t.foreground).hover((st) => st.bg(alpha(t.accent, "38")))
          .on_click((_e, cx) => this.reload({ since: null }, cx))
          .child(icon("history", 12)).child("Since your review").child(div().text_color(t.muted).child(icon("x", 11)))))
        .when(!s.since && Boolean(this.sinceReview()), (el) => {
          const since = this.sinceReview();
          return el.child(h_flex().id("since").h(28).px(10).gap(6).items_center().rounded(6).border_1().border_color(t.accent).cursor_pointer()
            .text_size(12).text_color(t.foreground).hover((st) => st.bg(t.hover))
            .on_click((_e, cx) => this.reload({ since: since.sha }, cx))
            .child(icon("history", 12)).child(`${plural(since.count, "new commit")} since your review`));
        })
        .when(Boolean(this.pr) && this.pr.head === s.head && !s.commit, (el) => el.child(h_flex().id("pr").h(28).px(8).gap(6).items_center().rounded(6).cursor_pointer()
          .min_w(0).text_size(12).text_color(t.muted).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => cx.open_url(this.pr.url))
          .child(div().font_medium().text_color(t.foreground).child(`#${this.pr.number}`))
          .child(div().max_w(260).truncate().child(this.pr.title)))))
      .child(div().flex_1())
      .when(files.length > 0, (el) => el.child(h_flex().gap(10).mr(4).text_size(12).text_color(t.muted).whitespace_nowrap()
        .child(`${viewed}/${files.length} viewed`)
        .child(h_flex().id("kinds").gap(4).px(4).rounded(4).cursor_pointer().hover((st) => st.bg(t.hover))
          .on_mouse_down("left", (e) => this.pressAt(e)).on_click((_e, cx) => this.openMenu("kinds", cx))
          .child(div().text_color(t.ansi2).child(`+${add.toLocaleString()}`)).child(div().text_color(t.ansi1).child(`−${del.toLocaleString()}`)))
        .when(this.ms != null, (el) => el.child(`${this.ms} ms`))))
      .when(openComments > 0, (el) => el
        .child(h_flex().id("send-agent").h(28).px(10).gap(6).items_center().rounded_l(6).border_1().border_color(t.border)
          .cursor_pointer().text_size(12).hover((st) => st.bg(t.hover))
          .on_mouse_down("left", (e) => this.pressAt(e)).on_click((_e, cx) => this.sendToAgent(cx))
          .child(icon("send", 13)).child(`Send to agent (${openComments})`))
        .child(h_flex().id("copy-review").h(28).w(28).justify_center().items_center().border_1().border_l_0().border_color(t.border)
          .cursor_pointer().text_color(t.muted).hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.copyReview(cx))
          .child(icon("copy", 12)))
        .child(h_flex().id("clear-comments").h(28).w(28).justify_center().items_center().rounded_r(6).border_1().border_l_0().border_color(t.border)
          .cursor_pointer().text_color(t.muted).hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.setReview({ ...this.review, comments: [] }) || (this.rebuild(), cx.notify()))
          .child(icon("x", 12))))
      .child(this.button("collapse", icon(files.length && files.every((f) => this.isCollapsed(f)) ? "expand" : "collapse"), (cx) => this.toggleAll(cx)))
      .child(this.button("style", icon(this.prefs.diffStyle === "split" ? "split" : "unified"), (cx) => this.setPref("diffStyle", this.prefs.diffStyle === "split" ? "unified" : "split", cx)))
      .child(this.button("settings", icon("settings"), (cx) => this.openMenu("settings", cx), { active: this.menu === "settings" }));
  }

  renderMenu(t) {
    const options = this.menuOptions().slice(0, 200);
    const searchable = this.menu !== "settings" && this.menu !== "kinds";
    const at = this.menuAt ?? { right: 10 };
    const panel = v_flex().id("menu").absolute().top(TOOLBAR_H + 2).w(this.menu === "commit" ? 420 : 300).p(4).gap(2)
      .rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .when(at.left != null, (el) => el.left(at.left)).when(at.right != null, (el) => el.right(at.right))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(searchable, (el) => el.child(div().p(4).child(Input.new(this.menuInput).h(30).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12.5))))
      .when(!options.length, (el) => el.child(div().px(10).py(8).text_size(12).text_color(t.dim).child("Nothing matches.")))
      .child(v_flex().id("menu-options").max_h(MENU_LIST_H).overflow_y_scrollbar().gap(1).children(options.map((o, i) =>
        h_flex().id(`option-${i}`).min_h(28).px(8).py(4).gap(8).items_center().rounded(5).cursor_pointer()
          .when(i === this.menuIndex, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => o.pick(cx))
          .child(div().w(14).flex_none().text_color(t.foreground).when(Boolean(o.current), (el) => el.child(icon("check", 12))))
          .child(v_flex().min_w(0).flex_1()
            .child(div().truncate().text_size(12.5).when(searchable && this.menu !== "commit", (el) => el.font_family(settings().font_family)).child(o.label))
            .when(Boolean(o.hint), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(o.hint)))))));
    // A clear backdrop over the rest of the view: a press there closes the menu.
    return div().absolute().inset_0()
      .on_mouse_down("left", (_e, cx) => { this.menu = null; this.handle.focus(); cx.notify(); })
      .child(panel);
  }

  renderSidebar(t, active) {
    const rows = this.tree();
    const shown = this.shown().length;
    const keycap = (k) => div().h(18).min_w(18).px(4).flex().items_center().justify_center().rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(t.muted).child(k);
    return v_flex().id("sidebar").w(SIDEBAR_W).flex_none().h_full().border_r_1().border_color(t.border)
      .child(v_flex().p(8).gap(6)
        .child(h_flex().id("goto").h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.openPalette("all", cx))
          .child(icon("search", 13)).child(div().flex_1().child("Go to…")).child(h_flex().gap(3).child(keycap("⌘")).child(keycap("K"))))
        .child(h_flex().h(32).px(8).gap(8).items_center().rounded(6).border_1().border_color(this.filtering ? t.accent : t.input)
          .child(div().text_color(t.dim).child(icon("search", 13)))
          .child(div().flex_1().min_w(0)
            .child(Input.new(this.filterInput).w_full().text_size(12)))
          .when(Boolean(this.filter), (el) => el.child(div().text_size(11).text_color(t.dim).child(`${shown}/${this.files.length}`)))))
      .child(div().flex_1().min_h(0).relative()
        .on_mouse_down("left", () => this.handle.focus())
        .child(v_virtual_list("tree", rows.length, TREE_ROW_H, (i) => rows[i].kind === "dir" ? `d:${rows[i].path}` : `f:${rows[i].id}`,
          (range) => rows.slice(range.start, range.end).map((row) => this.treeRow(t, row, active)))
          .track_scroll(this.treeScroll).size_full()
          .on_item_click((key, cx) => {
            if (key.startsWith("d:")) {
              const path = key.slice(2);
              if (this.closedDirs.has(path)) this.closedDirs.delete(path); else this.closedDirs.add(path);
              cx.notify();
            } else this.jumpToFile(key.slice(2), cx);
          }))
        .child(Scrollbar.vertical("tree").absolute().inset_0()));
  }

  treeRow(t, row, active) {
    const indent = 10 + row.depth * 14;
    const base = h_flex().h(TREE_ROW_H).mx(6).pl(indent).pr(10).gap(6).items_center().rounded(5).text_size(12.5);
    if (row.kind === "dir") {
      return base.text_color(t.foreground)
        .child(div().text_color(t.dim).child(icon(row.open ? "chevron-down" : "chevron-right", 12)))
        .child(div().flex_1().min_w(0).truncate().child(row.name))
        .child(div().size(5).rounded(3).bg(t.dim));
    }
    const file = this.files.find((f) => f.id === row.id);
    const viewed = file && isViewed(this.review, file);
    const color = { A: t.ansi2, M: t.ansi3, D: t.ansi1, R: t.muted }[row.status];
    return base.when(active?.id === row.id, (el) => el.bg(t.selected))
      .child(div().w(12).flex_none())
      .child(badge(row.name, t))
      .child(div().flex_1().min_w(0).truncate().text_color(viewed ? t.dim : t.foreground).child(row.name))
      .child(div().text_size(11).font_semibold().text_color(color).child(row.status));
  }

  renderMain(t, code, active) {
    const pinned = this.pinnedFile();
    return v_flex().id("main").flex_1().min_w(0).h_full().relative()
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.mainW) > 1) { this.mainW = size.width; this.rebuild(); cx.notify(); } })
      .when(!this.files.length, (el) => el.child(this.renderEmpty(t)))
      .when(Boolean(this.only), (el) => el.child(h_flex().id("only").h(32).flex_none().px(16).gap(8).items_center()
        .border_b_1().border_color(t.border).bg(alpha(t.accent, "14")).text_size(12).text_color(t.muted)
        .child("Showing one file")
        .child(div().flex_1())
        .child(h_flex().id("show-all").h(24).px(8).gap(6).items_center().rounded(5).cursor_pointer().text_color(t.foreground)
          .hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.showAll(cx))
          .child(this.files.length === 1 ? "Show the whole diff" : `Show all ${this.files.length} files`).child(div().text_color(t.dim).child("esc")))))
      .when(this.files.length > 0, (el) => el
        .child(div().id("diff-wrap").flex_1().min_h(0).relative()
          .on_mouse_down("left", (e) => {
            if (e.local_position) this.press = { x: e.local_position.x, shift: e.modifiers.shift };
            if (!this.editing) this.handle.focus();
          })
          .on_scroll_wheel((_e, cx) => { cx.notify(); cx.timer.after(60, (cx) => cx.notify()); })
          .child(v_virtual_list("diff", this.items.length, this.sizes, (i) => String(i), (range) => {
            this.topIndex = range.start;
            return this.items.slice(range.start, range.end).map((item, i) => this.renderItem(t, code, item, range.start + i));
          }).track_scroll(this.scroll).size_full().on_item_click((key, cx) => this.clickRow(key, cx)))
          .child(Scrollbar.vertical("diff").absolute().inset_0())
          .when(Boolean(pinned), (el) => el.child(div().absolute().top(0).left(0).right(0)
            .child(this.renderHeader(t, pinned, true))))));
  }

  pinnedFile() {
    const item = this.items[this.topIndex];
    if (!item || item.t === "file") return null;
    return item.f;
  }

  renderEmpty(t) {
    const s = this.source;
    const message = this.error ?? (this.loading ? this.loadingMessage ?? "Loading…"
      : s ? (s.commit ? "This commit changes nothing." : s.head ? `No changes between ${s.base} and ${s.head}.` : `No changes against ${s.base}.`) : "");
    return v_flex().size_full().items_center().justify_center().gap(6).p(24)
      .child(div().text_size(14).text_color(this.error ? t.ansi1 : t.muted).child(message))
      .when(Boolean(s) && !this.error && !this.loading, (el) => el.child(div().text_size(12).text_color(t.dim).child("Pick another base or head above.")));
  }

  renderItem(t, code, item, index) {
    if (item.t === "file") return this.renderHeader(t, item.f, false, index);
    const h = this.sizes[index];
    const row = h_flex().h(h).w_full().font_family(code).text_size(CODE_SIZE);
    if (item.t === "hunk") {
      return row.items_center().px(16).gap(10).bg(alpha(t.foreground, "08")).text_color(t.dim)
        .cursor_pointer().hover((st) => st.bg(alpha(t.foreground, "10")))
        .child(icon("expand", 12))
        .child(plural(item.hidden, "unmodified line"))
        .when(Boolean(item.context), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(item.context)));
    }
    if (item.t === "notice") return row.items_center().px(16).text_color(t.dim).child(item.text);
    if (item.t === "comment") return this.renderComment(t, item.c);
    if (item.t === "editor") return this.renderEditor(t, item.e);
    const m = this.metrics();
    if (item.t === "split") {
      return row.child(this.renderCell(t, item.left, m, m.side, h, "old", item.f))
        .child(div().w(1).h_full().bg(t.border))
        .child(this.renderCell(t, item.right, m, m.width - m.side - 1, h, "new", item.f));
    }
    return row.child(this.renderUnified(t, item, m, h));
  }

  lineColors(t, kind) {
    if (kind === "add") return { bg: alpha(t.ansi2, "1c"), gutter: alpha(t.ansi2, "30"), mark: alpha(t.ansi2, "48"), bar: t.ansi2 };
    if (kind === "del") return { bg: alpha(t.ansi1, "1c"), gutter: alpha(t.ansi1, "30"), mark: alpha(t.ansi1, "48"), bar: t.ansi1 };
    return { bg: null, gutter: null, mark: null, bar: null };
  }

  // Moved code needs little reading: it is faded.
  moved(file, cell) {
    return cell.kind !== "ctx" && isMoved(this.moves, file.id, cell.kind === "del" ? "old" : "new", cell.n ?? (cell.kind === "del" ? cell.old : cell.new));
  }

  renderCell(t, cell, m, width, h, side, file) {
    if (!cell) {
      return div().w(width).h(h).flex_none().relative().overflow_hidden().bg(alpha(t.foreground, "05"))
        .child(svg(`${ICONS}/hatch.svg`).absolute().top(0).left(0).w(1200).h(1200).text_color(alpha(t.foreground, "1c")));
    }
    const colors = this.lineColors(t, cell.kind);
    const commented = this.editing && this.editing.file && cell.n >= this.editing.start && cell.n <= this.editing.end
      && this.editing.side === (side === "old" && cell.kind !== "ctx" ? "old" : "new");
    return h_flex().w(width).h(h).flex_none().items_start().when(Boolean(colors.bg), (el) => el.bg(colors.bg))
      .when(commented, (el) => el.bg(alpha(t.accent, "26")))
      .child(h_flex().w(m.number).h_full().flex_none().items_start().justify_end().pr(10).text_color(colors.bar ?? t.dim)
        .when(Boolean(colors.gutter), (el) => el.bg(colors.gutter).border_l_2().border_color(colors.bar))
        .child(div().h(LINE_H).flex().items_center().child(String(cell.n))))
      .child(this.renderText(t, cell, m.cols, colors).when(this.moved(file, cell), (el) => el.opacity(0.45)));
  }

  renderUnified(t, item, m, h) {
    const cell = item.cell;
    const colors = this.lineColors(t, cell.kind);
    const number = (n) => h_flex().w(m.number).h(LINE_H).flex_none().justify_end().pr(10).child(n == null ? "" : String(n));
    return h_flex().w_full().h(h).items_start().when(Boolean(colors.bg), (el) => el.bg(colors.bg))
      .child(h_flex().h_full().flex_none().items_start().text_color(colors.bar ?? t.dim)
        .when(Boolean(colors.gutter), (el) => el.bg(colors.gutter).border_l_2().border_color(colors.bar))
        .child(number(item.old)).child(number(item.new)))
      .child(div().w(16).flex_none().h(LINE_H).flex().items_center().justify_center().text_color(colors.bar ?? t.dim)
        .child(cell.kind === "add" ? "+" : cell.kind === "del" ? "-" : ""))
      .child(this.renderText(t, cell, m.cols, colors).when(this.moved(item.f, cell), (el) => el.opacity(0.45)));
  }

  // The cell's text, wrapped at `cols` characters, coloured by syntax and word change.
  renderText(t, cell, cols, colors) {
    const lines = [];
    for (const [start, end] of wrapLines(cell.text, cols)) {
      lines.push(h_flex().h(LINE_H).items_center().whitespace_nowrap().children(segments(cell, start, end).map((s) =>
        div().text_color(s.kind === "comment" ? t.dim : s.kind === "punctuation" ? t.muted : SYNTAX[s.kind] ? t[SYNTAX[s.kind]] : t.foreground)
          .when(s.marked && Boolean(colors.mark), (el) => el.bg(colors.mark).rounded(2))
          .child(s.text))));
    }
    return v_flex().flex_1().min_w(0).pl(6).children(lines);
  }

  renderHeader(t, f, pinned, index = -1) {
    const collapsed = this.isCollapsed(f);
    const viewed = isViewed(this.review, f);
    const count = this.comments.filter((c) => c.file === f.id && !c.outdated).length;
    const slash = f.name.lastIndexOf("/");
    const label = f.generated ? "generated" : f.large ? "large" : null;
    const tag = (text, outline) => div().ml(2).px(6).py(1).rounded(4).text_size(11).text_color(t.muted)
      .when(outline, (el) => el.border_1().border_color(t.border)).when(!outline, (el) => el.bg(t.raised)).child(text);
    const part = (width) => h_flex().w(width).h_full().flex_none().items_center().justify_end();
    const header = h_flex().h(HEADER_H).w_full().pl(14).pr(14).gap(8).items_center().bg(t.background).text_size(13)
      .when(index > 0 || pinned, (el) => el.border_t_1()).when(pinned || !collapsed, (el) => el.border_b_1()).border_color(t.border)
      .when(pinned, (el) => el.shadow_md())
      .child(div().text_color(t.muted).child(icon(collapsed ? "chevron-right" : "chevron-down", 14)))
      .child(badge(f.name, t))
      .child(h_flex().min_w(0).flex_1().gap(0).truncate()
        .when(slash > 0, (el) => el.child(div().text_color(t.muted).child(f.name.slice(0, slash + 1))))
        .child(div().text_color(viewed ? t.muted : t.foreground).child(f.name.slice(slash + 1)))
        .when(Boolean(f.prevName), (el) => el.child(div().ml(8).text_color(t.dim).child(`← ${f.prevName}`))))
      .when(Boolean(label), (el) => el.child(tag(label, false)))
      .when(changedSinceViewed(this.review, f), (el) => el.child(tag("changed since viewed", true)))
      .when((this.moves.perFile.get(f.id) ?? 0) > 0, (el) => el.child(div().ml(2).text_size(11.5).text_color(t.dim).child(`${this.moves.perFile.get(f.id)} moved`)))
      .child(part(HEADER_PARTS.editor).child(f.type === "deleted" ? div() : div().text_color(t.dim).child(icon("editor", 13))))
      .child(part(HEADER_PARTS.comments).gap(4).text_size(12).text_color(t.muted).when(count > 0, (el) => el.child(icon("comment", 13)).child(String(count))))
      .child(part(HEADER_PARTS.stats).gap(6).text_size(12)
        .child(div().text_color(t.ansi1).child(`−${f.del}`)).child(div().text_color(t.ansi2).child(`+${f.add}`)))
      .child(part(HEADER_PARTS.viewed).gap(6).text_size(12).text_color(t.muted)
        .child(div().size(14).rounded(3).border_1().border_color(viewed ? t.accent : t.input).when(viewed, (el) => el.bg(t.accent))
          .flex().items_center().justify_center().text_color(t.accent_foreground).when(viewed, (el) => el.child(icon("check", 10))))
        .child("Viewed"));
    if (!pinned) return header;
    // The pinned copy sits outside the list, so it can have handlers of its own.
    return header.id("pinned").cursor_pointer().on_mouse_down("left", (e, cx) => {
      cx.stop_propagation();
      if (e.bounds) this.pressHeader(f, this.headerPart(e.bounds.x + e.bounds.width - e.position.x), cx);
    });
  }

  renderComment(t, c) {
    return h_flex().w_full().px(16).py(8).bg(alpha(t.foreground, "05"))
      .child(v_flex().flex_1().min_w(0).p(10).gap(4).rounded(8).border_1().border_color(t.border).bg(t.popover)
        .child(h_flex().gap(8).text_size(11.5).text_color(t.dim)
          .child(icon("comment", 12))
          .child(div().flex_1().child(c.start === c.end ? `Line ${c.end}` : `Lines ${c.start}–${c.end}`))
          .child(div().w(46).flex().justify_end().text_color(t.muted).child("Edit"))
          .child(div().w(46).flex().justify_end().text_color(t.muted).child("Delete")))
        .child(div().text_size(13).text_color(t.foreground).child(c.text)));
  }

  renderEditor(t, e) {
    const lines = e.start === e.end ? `Line ${e.end}` : `Lines ${e.start}–${e.end}`;
    return h_flex().w_full().px(16).py(8).bg(alpha(t.accent, "14"))
      .child(v_flex().flex_1().p(10).gap(8).rounded(8).border_1().border_color(t.accent).bg(t.popover)
        .child(Input.new(this.commentInput).h(30).w_full().text_size(13).text_color(t.foreground))
        .child(h_flex().gap(8).items_center().text_size(11.5)
          .child(div().flex_1().text_color(t.dim).child(`${lines} · ↵ to save, esc to cancel`))
          .child(div().w(70).flex().justify_end().text_color(t.muted).child("Cancel"))
          .child(div().w(76).py(4).flex().justify_center().rounded(6).bg(t.solid).text_color(t.solid_foreground).child("Comment"))));
  }

  renderPalette(t) {
    const results = this.paletteResults();
    const placeholder = this.palette === "lines" ? "Search the code in this diff" : "Go to a file, commit or action";
    return div().absolute().inset_0().flex().justify_center().bg(alpha(t.background, "99"))
      .on_mouse_down("left", (_e, cx) => { this.palette = null; this.handle.focus(); cx.notify(); })
      .child(v_flex().id("palette").mt(80).w(600).max_h(460).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(h_flex().h(44).px(12).gap(10).items_center().border_b_1().border_color(t.border)
          .child(div().text_color(t.dim).child(icon("search", 15)))
          .child(div().flex_1().child(Input.new(this.paletteInput).w_full().text_size(14)))
          .child(div().text_size(11).text_color(t.dim).child(placeholder)))
        .child(v_flex().id("palette-results").max_h(400).overflow_y_scrollbar().p(6).gap(1)
          .when(!results.length, (el) => el.child(div().p(12).text_size(12.5).text_color(t.dim)
            .child(this.palette === "lines" ? "Type at least two characters." : "Nothing matches.")))
          .children(results.slice(0, 120).map((r, i) => h_flex().id(`result-${i}`).h(32).px(10).gap(10).items_center().rounded(6).cursor_pointer()
            .when(i === this.paletteIndex, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.pickResult(r, cx))
            .child(div().flex_1().min_w(0).truncate().text_size(13)
              .when(this.palette === "lines", (el) => el.font_family(settings().font_family)).child(r.label))
            .child(div().flex_none().text_size(11.5).text_color(t.dim).child(r.hint))))));
  }
}
