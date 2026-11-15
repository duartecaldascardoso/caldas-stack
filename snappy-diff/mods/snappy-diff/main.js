// snappy diff for Herdr: review a branch like a pull request, without leaving the window.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { props, closeOverlay, focused, notify, agents, panes, hc, appHome, exec, run, settings, theme } from "herdr";
import * as fs from "fs/promises";
import * as git from "./git.js";
import { parsePatch, skippedFiles, firstChange } from "./patch.js";
import { languageOf } from "./syntax.js";
import { fileRows, wrapCount, wrapLines } from "./rows.js";
import { treeRows, fileMatches, breakdown } from "./tree.js";
import { findMoves } from "./moved.js";
import { reviewOrder, pullRequestList } from "./insights.js";
import { reviewKey, rangeKey, sinceReview, emptyReview, isViewed, toggleViewed, linesText, withStatus, reviewPrompt, reviewPayload, openThreads, threadsAsComments } from "./review.js";
import { DEFAULT_PREFS, readPrefs, writePrefs, readReview, writeReview, readLastReviewed, writeLastReviewed } from "./store.js";
import { CODE_SIZE, LINE_H, HEADER_H, COMMENT_LINE_H, HEADER_PARTS, EDITORS, unzoom, unzoomBounds, icon, alpha, plural, badge } from "./ui.js";
import { rowView, headerView } from "./lines.js";
import { overviewView } from "./overview.js";
import { paletteResults, paletteView } from "./palette.js";

const HUNK_H = 28;
const NOTICE_H = 40;
const TREE_ROW_H = 28;
const SIDEBAR_W = 288;
const SCROLLBAR_W = 12;
const THREAD_LINES = 12; // a thread comment's lines shown before "more on GitHub"
const THREAD_CHROME = 16 + 2 + 20 + 26; // row padding, border, card padding, header
const TOOLBAR_H = 48;
const MENU_LIST_H = 320;
const EDITOR_H = 96;
const REFRESH_MS = 2000; // uncommitted changes move under our feet
const HEADER_PAD = 14;
const RIGHT_MENUS = new Set(["settings", "agent", "kinds"]);

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
    this.rowsCache = new Map(); // file id -> { key, rows }: its rows, until the file, style or open separators change
    this.bodies = new Map(); // file id -> { key, items, sizes }: those rows as list items, at a width
    this.byId = new Map(); // file id -> file
    this.treeCache = null; // { files, filter, closed, rows }
    this.topIndex = 0;
    this.topKey = null; // the file at the top of the list as last drawn, and whether its header shows
    this.topCheck = false; // a comparison of the top waiting for the frame to end
    this.mainW = 0;
    this.charW = CODE_SIZE * 0.6;
    this.m = this.metrics(); // the layout's numbers, worked out once per rebuild
    this.press = null; // where the last press over the diff landed, for row clicks
    this.menu = null; // "base" | "head" | "commit" | "settings"
    this.menuIndex = 0;
    this.palette = null; // "all" | "lines"
    this.paletteIndex = 0;
    this.editing = null; // the comment being written: { id, file, side, start, end }
    this.pr = null; // the pull request under review, with the head ref it was fetched to
    this.lastReviewed = {}; // range -> the head commit last reviewed there
    this.threads = []; // the pull request's open review threads on GitHub
    this.overview = false;
    this.overviewPrefix = ""; // the folder the overview's "where" panel is in
    this.churn = new Map(); // path -> commits of the range that touched it

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
    else this.loadThreads(cx);
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
    if (this.prefs.wholeFiles) this.loadWholeFiles(cx);
    this.loadThreads(cx);
  }

  // The open review threads of the pull request on screen, from GitHub.
  loadThreads(cx) {
    if (!this.prShown()) {
      if (this.threads.length) { this.threads = []; this.rebuild(); cx.notify(); }
      return;
    }
    const { repo } = this.source;
    const number = this.pr.number;
    cx.spawn(async (cx) => {
      const threads = openThreads(await git.reviewThreads(repo, number));
      if (!this.prShown() || this.pr.number !== number) return;
      this.threads = threads;
      this.rebuild();
      cx.notify();
    });
  }

  resolveThread(thread, cx) {
    cx.spawn(async (cx) => {
      if (!(await git.resolveThread(this.source.repo, thread.id))) {
        notify({ title: "Couldn't resolve the thread", body: "Is the GitHub CLI (gh) signed in with access to this repository?", level: "error" });
        return;
      }
      this.threads = this.threads.filter((t) => t.id !== thread.id);
      this.rebuild();
      cx.notify();
    });
  }

  // A thread card's lines, in the code font at `cols` characters: each comment's author, then its
  // text, long ones cut short.
  threadLines(thread, cols) {
    const lines = [];
    thread.comments.forEach((comment, i) => {
      if (i) lines.push({ kind: "gap", text: "" });
      lines.push({ kind: "author", text: `@${comment.author}` });
      const body = comment.body.split("\n").flatMap((para) => wrapLines(para, cols).map(([a, b]) => para.slice(a, b)));
      for (const text of body.slice(0, THREAD_LINES)) lines.push({ kind: "text", text });
      if (body.length > THREAD_LINES) lines.push({ kind: "more", text: `… ${body.length - THREAD_LINES} more lines on GitHub` });
    });
    return lines;
  }

  threadCols() {
    return Math.max(20, Math.floor((this.m.width - 64) / this.charW));
  }

  // Whole files: every file's text, with every separator open. Files too big, binary, new or
  // deleted are left as they are.
  loadWholeFiles(cx) {
    const worktree = !this.source.head && !this.source.commit;
    const wanted = this.files.filter((f) => !f.binary && !f.tooLarge && !f.large && f.hunks.length && f.type !== "new" && f.type !== "deleted")
      .filter((f) => !this.expanded.get(f.id)?.lines);
    const openAll = (f, lines) => this.expanded.set(f.id, { lines, gaps: new Set(f.hunks.map((_, i) => i).concat(f.hunks.length)) });
    for (const f of this.files) { const known = this.expanded.get(f.id); if (known?.lines) openAll(f, known.lines); }
    cx.spawn(async (cx) => {
      for (let i = 0; i < wanted.length; i += 8) {
        await Promise.all(wanted.slice(i, i + 8).map(async (f) => {
          const text = await git.fileText(this.source.repo, f, worktree).catch(() => null);
          if (text != null) openAll(f, text.replaceAll("\t", "    ").split("\n"));
        }));
      }
      this.rebuild();
      cx.notify();
    });
  }

  setWholeFiles(on, cx) {
    this.setPref("wholeFiles", on, cx);
    if (on) return this.loadWholeFiles(cx);
    this.expanded = new Map();
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
    const key = `${file.rev}|${this.prefs.diffStyle}|${open ? [...open.gaps].join(",") : ""}`;
    const cached = this.rowsCache.get(file.id);
    if (cached?.key === key) return cached.rows;
    const rows = fileRows(file, this.prefs.diffStyle, languageOf(file.name), open);
    this.rowsCache.set(file.id, { key, rows });
    return rows;
  }

  // A file's rows as list items with their heights at `cols` characters a line: kept until the
  // rows or the width change, so a rebuild only lays out what did.
  bodyFor(file, cols) {
    const rows = this.rowsFor(file);
    const cached = this.bodies.get(file.id);
    if (cached?.rows === rows && cached.cols === cols) return cached;
    const items = [];
    const sizes = [];
    for (const row of rows) {
      items.push({ ...row, f: file });
      if (row.t === "hunk") sizes.push(HUNK_H);
      else if (row.t === "notice") sizes.push(NOTICE_H);
      else if (row.t === "split") sizes.push(Math.max(row.left ? wrapCount(row.left.text, cols) : 1, row.right ? wrapCount(row.right.text, cols) : 1) * LINE_H);
      else sizes.push(wrapCount(row.cell.text, cols) * LINE_H);
    }
    const body = { rows, cols, items, sizes };
    this.bodies.set(file.id, body);
    return body;
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

  // The list the diff view draws: each file's header, then its rows with comments, review
  // threads and the open editor under the lines they're on. Files without any reuse their laid
  // out rows as they are (bodyFor), which is most of a big diff.
  rebuild() {
    this.comments = withStatus(this.review.comments, this.files);
    this.byId = new Map(this.files.map((f) => [f.id, f]));
    const m = (this.m = this.metrics());
    const commentCols = Math.max(20, Math.floor((m.width - 120) / 7));
    const items = [];
    const sizes = [];
    const push = (item, size) => { items.push(item); sizes.push(size); };
    const group = (list, fileOf, at) => {
      const out = new Map();
      for (const x of list) {
        const byLine = out.get(fileOf(x)) ?? new Map();
        byLine.set(at(x), [...(byLine.get(at(x)) ?? []), x]);
        out.set(fileOf(x), byLine);
      }
      return out;
    };
    const notesOf = group(this.comments.filter((c) => !c.outdated), (c) => c.file, (c) => `${c.side}:${c.end}`);
    const threadsOf = group(this.threads, (th) => th.path, (th) => `${th.side}:${th.end}`);
    this.fileStarts = [];
    this.headerIndex = new Map();
    const shown = this.only ? this.files.filter((file) => file.id === this.only) : this.files;
    for (const f of shown) {
      this.fileStarts.push(items.length);
      this.headerIndex.set(f.id, items.length);
      push({ t: "file", f }, HEADER_H);
      if (this.isCollapsed(f)) continue;
      const body = this.bodyFor(f, m.cols);
      const notes = notesOf.get(f.id);
      const threads = threadsOf.get(f.name);
      if (!notes && !threads && this.editing?.file !== f.id) {
        for (let i = 0; i < body.items.length; i++) push(body.items[i], body.sizes[i]);
        continue;
      }
      body.items.forEach((item, i) => {
        push(item, body.sizes[i]);
        if (item.t !== "split" && item.t !== "unified") return;
        // Comments and the open editor go under the last line they are on.
        for (const [side, n] of this.rowSides(item)) {
          for (const th of threads?.get(`${side}:${n}`) ?? []) {
            push({ t: "thread", th, f }, THREAD_CHROME + this.threadLines(th, this.threadCols()).length * COMMENT_LINE_H);
          }
          for (const c of notes?.get(`${side}:${n}`) ?? []) {
            if (c.id === this.editing?.id) continue;
            push({ t: "comment", c, f }, 52 + wrapCount(c.text, commentCols) * COMMENT_LINE_H);
          }
          const e = this.editing;
          if (e && e.file === f.id && e.side === side && e.end === n) push({ t: "editor", e, f }, EDITOR_H);
        }
      });
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

  // The most important file not yet viewed: contracts, tests, code, config, docs.
  reviewNext(cx) {
    const pending = reviewOrder(this.shown()).filter((f) => !isViewed(this.review, f));
    const active = this.activeFile()?.id;
    const next = pending.find((f) => f.id !== active) ?? pending[0];
    if (next) this.jumpToFile(next.id, cx);
  }

  followTree(id) {
    const index = this.tree().findIndex((row) => row.kind === "file" && row.id === id);
    if (index >= 0) this.treeScroll.scroll_to_item(index, "center");
  }

  // The sidebar's rows, kept until the files, the filter or the folded folders change.
  tree() {
    const closed = [...this.closedDirs].join("\n");
    const c = this.treeCache;
    if (c?.files === this.files && c.filter === this.filter && c.closed === closed) return c.rows;
    const rows = treeRows(this.shown(), this.closedDirs);
    this.treeCache = { files: this.files, filter: this.filter, closed, rows };
    return rows;
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

  // Scrolls to the next GitHub thread below the top of the view, round to the first.
  nextThread(cx) {
    const at = this.items.map((item, i) => (item.t === "thread" ? i : -1)).filter((i) => i >= 0);
    if (!at.length) {
      // A thread on a folded file: unfold the files that have threads, then look again.
      for (const th of this.threads) { const f = this.files.find((x) => x.name === th.path); if (f) this.open.set(f.id, true); }
      this.rebuild();
      return cx.notify();
    }
    const next = at.find((i) => i > this.topIndex + 1) ?? at[0];
    this.topIndex = next;
    this.scroll.scroll_to_item(next, "center");
    cx.notify();
  }

  // Your open comments and GitHub's open threads: what an agent is asked to address.
  reviewItems() {
    return [...this.comments.filter((c) => !c.outdated), ...threadsAsComments(this.threads, this.files)];
  }

  sendToAgent(cx, chosen) {
    const open = this.reviewItems();
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

  // Comments for the pull request: open ones not posted yet.
  unsentComments() {
    return this.prShown() ? this.comments.filter((c) => !c.outdated && !c.sent) : [];
  }

  prShown() {
    return Boolean(this.pr) && this.pr.head === this.source?.head && !this.source.commit && !this.source.since;
  }

  // Posts the comments to the pull request as one review, through gh, and marks them sent.
  sendToGitHub(cx) {
    const comments = this.unsentComments();
    if (!comments.length || this.posting) return;
    this.posting = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const file = `${appHome()}/data/snappy-diff/github-review.json`;
      try {
        await fs.mkdir(`${appHome()}/data/snappy-diff`, { recursive: true });
        await fs.writeFile(file, JSON.stringify(reviewPayload(this.pr.headRefOid, comments, this.files)));
        const result = await exec("gh", ["api", `repos/{owner}/{repo}/pulls/${this.pr.number}/reviews`, "--method", "POST", "--input", file], { cwd: this.source.repo });
        if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split("\n").pop());
        const sent = new Set(comments.map((c) => c.id));
        this.setReview({ ...this.review, comments: this.review.comments.map((c) => (sent.has(c.id) ? { ...c, sent: true } : c)) });
        this.rebuild();
        notify({ title: `Posted ${plural(comments.length, "comment")} on #${this.pr.number}`, body: this.pr.title, level: "success", timeout: 3000 });
      } catch (e) {
        notify({ title: "Couldn't post the review", body: String(e.message ?? e), level: "error" });
      } finally {
        this.posting = false;
        cx.notify();
      }
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

  // t: the review out of the pop-up into its own tab, to keep it open beside the agent. Comments
  // and viewed files are kept per branch, so it picks up where it was.
  openInTab() {
    const s = this.source;
    if (!s || !props()?.overlay) return;
    const pr = this.prShown() ? this.pr : null;
    run("tab.new", {
      name: (pr ? `#${pr.number} ${pr.title}` : s.head || "Working tree").slice(0, 30),
      mod: "snappy-diff",
      props: pr ? { repo: s.repo, pr: pr.number } : { repo: s.repo, base: s.base, head: s.head },
    });
    this.close();
  }

  // Overview: the diff at a glance.

  openOverview(cx) {
    this.overview = !this.overview;
    this.overviewPrefix = "";
    this.menu = null;
    this.handle.focus();
    cx.notify();
    if (this.overview && this.source?.head) {
      cx.spawn(async (cx) => {
        this.churn = await git.churn(this.source.repo, this.source.since || this.source.base, this.source.head);
        cx.notify();
      });
    }
  }

  // Keys

  onKey(event, cx) {
    const k = event.keystroke;
    if (this.palette) return this.paletteKey(k, cx);
    if (this.overview && k === "escape") { this.overview = false; cx.notify(); return cx.stop_propagation(); }
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
      "t": () => this.openInTab(),
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
      { label: `Whole files: ${this.prefs.wholeFiles ? "On" : "Off"}`, pick: (cx) => this.setWholeFiles(!this.prefs.wholeFiles, cx) },
      ...(this.files.length ? [
        { label: this.files.every((f) => this.isCollapsed(f)) ? "Expand all files" : "Collapse all files", pick: (cx) => { this.menu = null; this.toggleAll(cx); } },
        { label: "Overview", pick: (cx) => this.openOverview(cx) },
      ] : []),
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

  // The repository's open pull requests, for go-to: fetched when it opens, at most once a minute.
  loadPullRequests(cx) {
    const repo = this.source?.repo;
    if (!repo || (this.prsAt && Date.now() - this.prsAt < 60000 && this.prsRepo === repo)) return;
    this.prsAt = Date.now();
    this.prsRepo = repo;
    cx.spawn(async (cx) => {
      const gh = (args) => exec("gh", args, { cwd: repo }).catch(() => null);
      const [list, me] = await Promise.all([
        gh(["pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,author,isDraft,reviewRequests"]),
        this.me ? null : gh(["api", "user", "--jq", ".login"]),
      ]);
      if (me?.code === 0) this.me = me.stdout.trim();
      try { this.prs = list?.code === 0 ? pullRequestList(JSON.parse(list.stdout), this.me) : []; } catch { this.prs = []; }
      cx.notify();
    });
  }

  openPalette(mode, cx) {
    if (mode === "all") this.loadPullRequests(cx);
    this.palette = this.palette === mode ? null : mode;
    this.paletteIndex = 0;
    this.paletteInput.set_value("");
    if (this.palette) this.paletteInput.focus();
    else this.handle.focus();
    cx.notify();
  }

  paletteKey(k, cx) {
    const results = paletteResults(this);
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
    const m = this.m;
    const fromRight = this.mainW - press.x;
    const f = item.f;
    if (item.t === "file") return this.pressHeader(f, this.headerPart(fromRight), cx);
    if (item.t === "hunk") return this.expandGap(f, item.hunk, cx);
    // Comment cards: 16px row padding, a 1px border and 10px card padding before the buttons,
    // which are fixed-width and right-aligned (renderComment, renderEditor).
    const inCard = fromRight - 27;
    if (item.t === "thread") {
      if (inCard >= 0 && inCard < 70) return this.resolveThread(item.th, cx);
      return;
    }
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
      .on_mouse_down("left", (e) => { if (e.bounds) this.viewBounds = unzoomBounds(e.bounds); })
      .when(Boolean(this.menu) && Boolean(this.source), (el) => el.child(this.renderMenu(t)))
      .when(this.overview, (el) => el.child(overviewView(this, t)))
      .when(Boolean(this.palette), (el) => el.child(paletteView(this, t)))
      // Measures the code font's character width, which wrapping is computed from.
      .child(div().id("probe").absolute().top(-100).left(0).opacity(0).whitespace_nowrap().text_size(CODE_SIZE)
        .when(Boolean(code), (el) => el.font_family(code))
        .on_size_change((size, cx) => {
          const width = unzoom(size.width) / 100;
          if (width > 0 && Math.abs(width - this.charW) > 0.01) { this.charW = width; this.rebuild(); cx.notify(); }
        })
        .child("0".repeat(100)));
  }

  // Remembers where a menu's button is, for the menu to drop below it.
  pressAt(event) {
    if (event.bounds) this.pressed = unzoomBounds(event.bounds);
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
    const openComments = this.reviewItems().length;
    // Borderless: the range reads as text, and only shows it's a button under the pointer.
    const picker = (name, label, mono = true) => h_flex().id(`pick-${name}`).h(28).px(6).gap(4).items_center().rounded(6)
      .cursor_pointer().hover((st) => st.bg(t.hover)).flex_none()
      .on_mouse_down("left", (e) => this.pressAt(e))
      .on_click((_e, cx) => this.openMenu(name, cx))
      .when(this.menu === name, (el) => el.bg(t.hover))
      .child(div().max_w(220).truncate().text_size(12.5).when(mono, (el) => el.font_family(settings().font_family)).child(label))
      .child(div().text_color(t.dim).child(icon("chevron-down", 11)));
    return h_flex().id("toolbar").h(TOOLBAR_H).flex_none().px(10).gap(4).items_center().border_b_1().border_color(t.border).bg(t.background)
      .child(this.button("sidebar", icon("panel"), (cx) => this.setPref("sidebar", !this.prefs.sidebar, cx)))
      .when(Boolean(s), (el) => el
        .child(picker("base", s.base === git.EMPTY_TREE ? "No commits yet" : s.base, s.base !== git.EMPTY_TREE))
        .child(h_flex().id("swap").h(28).w(20).justify_center().items_center().rounded(6).cursor_pointer().flex_none().text_color(t.dim)
          .hover((st) => st.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => s.head && this.reload({ base: s.head, head: s.base, commit: null }, cx))
          .child(icon("swap", 12)))
        .child(picker("head", s.head || "Working tree", Boolean(s.head)))
        .when(this.commits.length > 1, (el) => el.child(div().mx(2).text_color(t.dim).child("·"))
          .child(picker("commit", s.commit ? `${s.commit.slice(0, 7)} ${this.commits.find((c) => c.sha === s.commit)?.subject ?? ""}` : `All ${this.commits.length} commits`, false)))
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
      .when(files.length > 0, (el) => el.child(h_flex().gap(8).mr(4).text_size(12).text_color(t.dim).whitespace_nowrap()
        .child(`${viewed}/${files.length}`)
        .child(h_flex().id("kinds").gap(4).px(4).rounded(4).cursor_pointer().hover((st) => st.bg(t.hover))
          .on_mouse_down("left", (e) => this.pressAt(e)).on_click((_e, cx) => this.openMenu("kinds", cx))
          .child(div().text_color(t.ansi2).child(`+${add.toLocaleString()}`)).child(div().text_color(t.ansi1).child(`−${del.toLocaleString()}`)))))
      .when(this.threads.length > 0, (el) => el.child(h_flex().id("threads").h(28).px(10).gap(6).items_center().rounded(6).cursor_pointer()
        .text_size(12).text_color(t.foreground).bg(alpha(t.ansi4, "22")).hover((st) => st.bg(alpha(t.ansi4, "33")))
        .on_click((_e, cx) => this.nextThread(cx))
        .child(icon("comment", 12)).child(plural(this.threads.length, "thread"))))
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
      .when(this.unsentComments().length > 0, (el) => el.child(h_flex().id("github").h(28).px(10).gap(6).items_center().rounded(6).border_1().border_color(t.border)
        .cursor_pointer().text_size(12).hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.sendToGitHub(cx))
        .child(icon("pull", 13)).child(this.posting ? "Sending…" : `GitHub (${this.unsentComments().length})`)))
      .when(Boolean(s), (el) => el.child(this.button("goto", icon("search"), (cx) => this.openPalette("all", cx), { active: this.palette === "all" })))
      .child(this.button("settings", icon("settings"), (cx) => this.openMenu("settings", cx), { active: this.menu === "settings" }))
      .when(Boolean(s && props()?.overlay), (el) => el.child(this.button("pop-out", icon("pop-out"), () => this.openInTab())));
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
    return v_flex().id("sidebar").w(SIDEBAR_W).flex_none().h_full().border_r_1().border_color(t.border)
      .child(div().p(8)
        .child(h_flex().h(30).px(8).gap(8).items_center().rounded(6).border_1().border_color(this.filtering ? t.accent : "#00000000")
          .when(!this.filtering, (el) => el.bg(alpha(t.foreground, "08")))
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
        .child(div().flex_1().min_w(0).truncate().child(row.name));
    }
    const file = this.byId.get(row.id);
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
      .on_size_change((size, cx) => {
        const width = unzoom(size.width);
        if (Math.abs(width - this.mainW) > 1) { this.mainW = width; this.rebuild(); cx.notify(); }
      })
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
            if (e.local_position) this.press = { x: unzoom(e.local_position.x), shift: e.modifiers.shift };
            if (!this.editing) this.handle.focus();
          })
          // The list scrolls by itself, drawing the rows that come into view; the rest of the view
          // only follows when the file at the top changes (the pinned header, the sidebar).
          .child(v_virtual_list("diff", this.items.length, this.sizes, (i) => String(i), (range, cx) => {
            // The renderer runs twice a frame, measuring then placing, so the top is compared once
            // the frame is done, when the placing pass has had the last word.
            this.topIndex = range.start;
            if (!this.topCheck) {
              this.topCheck = true;
              cx.timer.after(0, (cx) => {
                this.topCheck = false;
                const top = `${this.activeFile()?.id}|${this.items[this.topIndex]?.t === "file"}`;
                if (top !== this.topKey) { this.topKey = top; cx.notify(); }
              });
            }
            return this.items.slice(range.start, range.end).map((item, i) => rowView(this, t, code, item, range.start + i));
          }).track_scroll(this.scroll).size_full().on_item_click((key, cx) => this.clickRow(key, cx)))
          .child(Scrollbar.vertical("diff").absolute().inset_0())
          .when(Boolean(pinned), (el) => el.child(div().absolute().top(0).left(0).right(0)
            .child(headerView(this, t, pinned, true))))));
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

}
