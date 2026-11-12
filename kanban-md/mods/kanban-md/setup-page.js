// The Setup page: what agents work with for this board's project, beside what they work with
// everywhere. Two columns of sections (instructions, settings, skills, …), a row per file or
// entry; what a worktree won't have is marked. A row reads in place of the columns, and can be
// edited, deleted (to ~/kanban/.trash) or opened in the editor; new skills, commands and
// subagents start from a template. Each column is a virtual list, so the selected row can be
// scrolled into view.
import { div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, InputState, Input, TextareaState, Textarea, VirtualListScrollHandle } from "gpui-base";
import { exec, home, appHome, readTextFile, writeTextFile, notify, settings } from "herdr";
import { alpha, sectionLabel } from "./ui.js";
import { overlaps, setupSummary, changesOf, newDefinition, NEW_KINDS, valueAt, setAt, deleteAt, withoutIndexLine } from "./setup.js";
import { projectSetup, everywhereSetup } from "./claude.js";
import { markdownBlocks } from "./markdown.js";

const MAX_BLOCKS = 1500; // the reader stops there; the editor has the rest
const TRASH = `${home()}/kanban/.trash`;

// Each kind of row: its key in a setup, its section's name, and one of it in words.
export const SECTIONS = [
  ["instructions", "Instructions", "instructions file"], ["memory", "Memory", "memory"], ["settings", "Settings", "settings file"],
  ["permissions", "Permissions", "permission rule"], ["env", "Environment", "environment variable"],
  ["skills", "Skills", "skill"], ["commands", "Commands", "command"], ["agents", "Subagents", "subagent"],
  ["styles", "Output styles", "output style"], ["hooks", "Hooks", "hook"], ["servers", "MCP servers", "MCP server"], ["plugins", "Plugins", "plugin"],
];
const one = (kind) => SECTIONS.find(([k]) => k === kind)[2];
const CHANGED = "the file changed meanwhile; o opens it in your editor";
const SECTION_H = 36;
const ROW_H = 50;
const SIDES = [["project", "This project"], ["everywhere", "Everywhere"]];

// Every item in page order, the project's then everywhere's: [{ side, kind, item }]. The
// selection is an index into this.
export function setupItems(setup) {
  if (!setup) return [];
  return SIDES.flatMap(([side]) => SECTIONS.flatMap(([kind]) =>
    (setup[side]?.[kind] ?? []).map((item) => ({ side, kind, item }))));
}

// A column's rows: a heading per section that has items, then its items, each with its index
// in setupItems: [{ section, count } | { side, kind, item, index }].
export function columnRows(items, side) {
  const rows = [];
  for (const [kind, label] of SECTIONS) {
    const inSection = items.map((entry, index) => ({ ...entry, index })).filter((e) => e.side === side && e.kind === kind);
    if (!inSection.length) continue;
    rows.push({ section: label, count: inSection.length }, ...inSection);
  }
  return rows;
}

export class SetupPage {
  // `board`: { root() the board's repository or null, focus() gives the board the keyboard,
  // ask(ask, cx) puts a question on the hint line }.
  constructor(board) {
    this.board = board;
    this.setup = null; // { root, project, everywhere }: a side is undefined while it's read, project null without a repository
    this.everywhere = undefined; // kept between visits: it's the same on every board
    this.index = 0; // the selected row, in setupItems
    this.reading = null; // { index, text }: a row read in place of the columns, text null while it's read
    this.editing = null; // { path, original, json }: the read row's file, being edited
    this.creating = null; // { side, kind }: a new skill, command or subagent being named
    this.editor = "zed";
    this.scrolls = SIDES.map(() => VirtualListScrollHandle.new());
    this.text = TextareaState.new({ placeholder: "" });
    this.text.set_soft_wrap(true);
    this.name = InputState.new({ placeholder: "Its name" });
    this.name.on("submit", (_e, cx) => this.create(cx));
  }

  items() {
    return setupItems(this.setup);
  }

  // Shown again: the list, read afresh.
  show(cx) {
    this.reading = null;
    this.editing = null;
    this.creating = null;
    cx.spawn((cx) => this.load(cx));
  }

  // The project's setup in a few words, for a card's details, when it's the board's.
  summary() {
    return this.setup?.root === this.board.root() ? setupSummary(this.setup.project) : null;
  }

  // Reads both sides; each shows as soon as it's read, until then what was read last time.
  async load(cx) {
    const root = this.board.root();
    const kept = this.setup?.root === root ? this.setup.project : undefined;
    this.setup = { root, project: root ? kept : null, everywhere: this.everywhere };
    cx.notify();
    const show = (side, value) => {
      if (this.setup?.root !== root) return; // the board changed meanwhile
      this.setup = { ...this.setup, [side]: value };
      this.index = Math.min(this.index, Math.max(0, this.items().length - 1));
      cx.notify();
    };
    await Promise.all([
      pickedEditor().then((editor) => { this.editor = editor; }),
      root && projectSetup(root).then((project) => show("project", project)),
      everywhereSetup().then((everywhere) => { this.everywhere = everywhere; show("everywhere", everywhere); }),
    ]);
  }

  // Keys

  // Handles a key on the page; false leaves it to the board (esc on the list goes back to it).
  key(key, action, cx) {
    if (this.editing) return this.editKey(key, cx);
    if (this.creating) return this.createKey(key, cx);
    const items = this.items();
    const entry = this.reading ? items[this.reading.index] : items[this.index];
    const can = entry ? changesOf(entry) : {};
    const act = {
      o: () => this.openInEditor(entry, cx),
      e: can.edit ? () => cx.spawn((cx) => this.edit(cx)) : null,
      d: can.remove ? () => this.askRemove(entry, cx) : null,
      t: can.toggle ? () => cx.spawn((cx) => this.toggle(entry, cx)) : null,
      n: () => this.startNew(cx),
    }[key];
    if (act) {
      act();
      return true;
    }
    if (this.reading) {
      if (key === "escape") this.reading = null;
      else if (action === "up" || action === "down") this.read(clamp(this.index + (action === "up" ? -1 : 1), items.length), cx);
      else return false;
      cx.notify();
      return true;
    }
    if (key === "enter") {
      this.read(this.index, cx);
      return true;
    }
    if (!items.length || !["up", "down", "left", "right"].includes(action)) return false;
    if (action === "up" || action === "down") {
      this.index = clamp(this.index + (action === "up" ? -1 : 1), items.length);
    } else {
      const side = action === "left" ? "project" : "everywhere";
      const first = items.findIndex((e) => e.side === side);
      if (first >= 0 && items[this.index]?.side !== side) this.index = first;
    }
    const selected = items[this.index];
    this.scrolls[selected.side === "project" ? 0 : 1].scroll_to_item(columnRows(items, selected.side).findIndex((r) => r.index === this.index), "center");
    cx.notify();
    return true;
  }

  // The keys the hint line shows for the page as it is.
  hints() {
    if (this.editing) return [["⌘S", "save"], ["esc", "stop editing"]];
    if (this.creating) return [["↵", "create"], ["tab", "kind"], ["⇧tab", "where"], ["esc", "cancel"]];
    const entry = this.items()[this.reading ? this.reading.index : this.index];
    const plan = entry ? changesOf(entry) : {};
    const can = [
      ...(plan.edit ? [["e", "edit"]] : []),
      ...(plan.remove ? [["d", removeWord(plan.remove)]] : []),
      ...(plan.toggle ? [["t", plan.toggle.on ? "turn off" : "turn on"]] : []),
      ["o", "open in your editor"], ["n", "new"],
    ];
    return this.reading
      ? [["↑↓", "previous, next"], ...can, ["esc", "back to the list"]]
      : [["↵", "read"], ...can, ["←→", "project or everywhere"], ["esc", "back to the board"]];
  }

  // Reading

  // Shows a row's content in place of the list: what setup.js wrote about it (a hook, an MCP
  // server), else its file. A plugin shows its README, else its manifest; JSON shows as code.
  read(index, cx) {
    const entry = this.items()[index];
    if (!entry) return;
    this.index = index;
    this.reading = { index, text: entry.item.detail ?? null };
    this.board.focus();
    cx.notify();
    if (entry.item.detail !== undefined) return;
    cx.spawn(async (cx) => {
      const root = entry.item.path;
      const isPlugin = entry.kind === "plugins";
      const paths = isPlugin ? [`${root}/README.md`, `${root}/.claude-plugin/plugin.json`, `${root}/plugin.json`] : [root];
      let found = null;
      for (const path of paths) {
        const text = await readTextFile(path).catch(() => null);
        if (text !== null) { found = { path, text }; break; }
      }
      // A plugin starts with what Claude Code says it adds and costs: its components and tokens.
      const details = isPlugin ? await exec("claude", ["plugin", "details", entry.item.plugin.id]).catch(() => null) : null;
      if (this.reading?.index !== index) return;
      const text = !found ? "Nothing to read here." : found.path.endsWith(".json") ? fenced(found.text) : found.text;
      this.reading = { index, text: details?.code === 0 ? `${fenced(details.stdout.trim())}\n\n${text}` : text };
      cx.notify();
    });
  }

  // Opens a row's file in the editor picked in snappy-diff's settings, as snappy-diff does.
  openInEditor(entry, cx) {
    if (entry?.item.path) cx.open_url(`${this.editor}://file${encodeURI(entry.item.path)}`);
  }

  // Editing: the read row's file in a text area, saved only if it didn't change on disk meanwhile
  // and, for JSON, only when it parses.

  async edit(cx) {
    const index = this.reading?.index ?? this.index;
    const entry = this.items()[index];
    const plan = entry && changesOf(entry).edit;
    if (!plan) return;
    const session = await this.editSession(plan, entry);
    if (typeof session === "string") { notify({ title: `Can't edit ${entry.item.name}`, body: session, level: "error" }); return; }
    if (!this.reading) this.read(index, cx);
    this.editing = { ...session, index };
    this.text.set_value(session.shown);
    this.text.focus();
    cx.notify();
  }

  // What editing shows and how saving writes it back: { name, path, shown, commit(text) }, commit
  // resolving to null when saved, else why not. Or, as a string, why it can't be edited.
  async editSession(plan, entry) {
    if (plan.how === "file") {
      const original = await readTextFile(plan.path).catch(() => null);
      if (original === null) return "Couldn't read the file.";
      return {
        name: plan.path.split("/").pop(), path: plan.path, shown: original,
        commit: async (text) => (plan.path.endsWith(".json") && parseError(text)) || writeTextFile(plan.path, text, original).then(() => null, () => CHANGED),
      };
    }
    if (plan.how === "json") {
      // One entry of a JSON file: a rule or a variable as its text, the rest as JSON.
      const original = await readTextFile(plan.file).catch(() => null);
      const value = valueAt(parsed(original), plan.at);
      if (value === undefined) return "It's no longer in its file.";
      const isText = typeof value === "string";
      return {
        name: entry.item.name, path: plan.file, shown: isText ? value : JSON.stringify(value, null, 2),
        commit: async (text) => {
          if (!isText && parseError(text)) return parseError(text);
          const next = setAt(original, plan.at, isText ? text.trim() : JSON.parse(text));
          return writeTextFile(plan.file, next, original).then(() => null, () => CHANGED);
        },
      };
    }
    if (plan.how === "mcp") {
      // Claude Code rewrites ~/.claude.json itself, so the server is replaced through `claude mcp`,
      // putting the old one back if the new one is refused.
      const root = this.setup?.root;
      const config = parsed(await readTextFile(`${home()}/.claude.json`).catch(() => null));
      const value = (plan.scope === "local" ? config?.projects?.[root] : config)?.mcpServers?.[plan.name];
      if (!value) return "Claude Code no longer has it.";
      return {
        name: plan.name, path: `${home()}/.claude.json`, shown: JSON.stringify(value, null, 2),
        commit: async (text) => {
          if (parseError(text)) return parseError(text);
          const mcp = (args) => claude(["mcp", ...args, "-s", plan.scope], root);
          const removed = await mcp(["remove", plan.name]);
          if (removed) return removed;
          const added = await mcp(["add-json", plan.name, JSON.stringify(JSON.parse(text))]);
          if (added) await mcp(["add-json", plan.name, JSON.stringify(value)]);
          return added;
        },
      };
    }
    return "This can't be edited here.";
  }

  editKey(key, cx) {
    if (key === "cmd-s") { cx.spawn((cx) => this.save(cx)); return true; }
    if (key !== "escape") return key === "cmd-k"; // typing goes to the text; go-to waits
    if (this.text.value() === this.editing.shown) {
      this.stopEditing(cx);
      return true;
    }
    // The answer mustn't be typed into the text: the board takes the keyboard while it asks.
    this.board.focus();
    this.board.ask({
      prompt: `Discard your changes to ${this.editing.name}?`, yes: "discard", danger: true,
      run: (cx) => this.stopEditing(cx), cancel: () => this.text.focus(),
    }, cx);
    return true;
  }

  async save(cx) {
    const { name, commit, index } = this.editing;
    const why = await commit(this.text.value());
    if (why) { notify({ title: `Not saved: ${why}`, level: "error" }); return; }
    notify({ title: `Saved ${name}`, level: "success", timeout: 2000 });
    this.stopEditing(cx);
    await this.reload({ index }, cx);
  }

  stopEditing(cx) {
    this.editing = null;
    this.board.focus();
    cx.notify();
  }

  // Reads the page again, then reads a row: the one whose file is `path`, or the one at `index`.
  async reload({ path, index }, cx) {
    await this.load(cx);
    const items = this.items();
    const at = path ? items.findIndex((e) => e.item.path === path) : Math.min(index, items.length - 1);
    if (at >= 0) this.read(at, cx);
    else this.reading = null;
    cx.notify();
  }

  // New: a skill, command or subagent from a template, in the selected row's column and of its
  // kind when it's one of those; tab changes the kind, shift-tab where.

  startNew(cx) {
    const entry = this.items()[this.index];
    const kinds = NEW_KINDS.map(([k]) => k);
    const side = !this.setup?.project ? "everywhere" : entry?.side ?? "project";
    this.creating = { side, kind: kinds.includes(entry?.kind) ? entry.kind : "skills" };
    this.reading = null;
    this.name.set_value("");
    this.name.focus();
    cx.notify();
  }

  createKey(key, cx) {
    if (key === "escape") { this.creating = null; this.board.focus(); }
    else if (key === "tab") this.creating.kind = cycle(NEW_KINDS.map(([k]) => k), this.creating.kind);
    else if (key === "shift-tab" && this.setup?.project) this.creating.side = cycle(SIDES.map(([s]) => s), this.creating.side);
    else return key === "cmd-k";
    cx.notify();
    return true;
  }

  create(cx) {
    const { side, kind } = this.creating ?? {};
    const base = side === "project" ? `${this.setup?.root}/.claude` : `${home()}/.claude`;
    const made = kind && newDefinition(base, kind, this.name.value());
    if (!made) return;
    this.creating = null;
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", made.path.slice(0, made.path.lastIndexOf("/"))]);
      const written = await writeTextFile(made.path, made.text, null).then(() => true, () => false);
      if (!written) { notify({ title: "It exists already", body: made.path, level: "warning" }); this.board.focus(); return; }
      await this.reload({ path: made.path }, cx);
      await this.edit(cx);
    });
  }

  // Delete: to ~/kanban/.trash, like a deleted board, after asking.

  // Delete, remove or uninstall, after asking: files go to ~/kanban/.trash like a deleted board,
  // an entry leaves its JSON file, servers and plugins go through Claude Code.

  askRemove(entry, cx) {
    const plan = changesOf(entry).remove;
    const { name } = entry.item;
    const prompt = {
      file: `Delete the ${one(entry.kind)} "${name}"? It moves to ~/kanban/.trash.`,
      json: `Remove the ${one(entry.kind)} "${name}" from ${plan.file?.split("/").pop()}?`,
      mcp: `Remove the MCP server "${name}"${plan.scope === "local" ? " from this project" : " everywhere"}?`,
      plugin: plan.scope === "user" ? `Uninstall ${name}? Every project loses it.` : `Remove ${name} from this project?`,
    }[plan.how];
    this.board.ask({ prompt, yes: removeWord(plan), danger: true, run: (cx) => cx.spawn((cx) => this.remove(entry, plan, cx)) }, cx);
  }

  async remove(entry, plan, cx) {
    const why = await this.removed(plan);
    if (why) { notify({ title: `Couldn't ${removeWord(plan)} ${entry.item.name}`, body: why, level: "error" }); return; }
    notify({ title: `${DONE[removeWord(plan)]} ${entry.item.name}`, body: plan.how === "file" ? "It's in ~/kanban/.trash." : undefined, level: "success", timeout: 3000 });
    this.reading = null;
    await this.load(cx);
  }

  // Carries out a removal: null when done, else why not.
  async removed(plan) {
    if (plan.how === "file") {
      await exec("mkdir", ["-p", TRASH]);
      const moved = await exec("mv", [plan.path, `${TRASH}/setup-${Date.now()}-${plan.path.split("/").pop()}`]).catch(() => null);
      if (moved?.code !== 0) return (moved?.stderr ?? "").trim() || "mv failed";
      if (!plan.index) return null;
      // A memory's line in MEMORY.md goes with it.
      const index = await readTextFile(plan.index).catch(() => null);
      return index === null ? null : writeTextFile(plan.index, withoutIndexLine(index, plan.path.split("/").pop()), index).then(() => null, () => null);
    }
    if (plan.how === "json") {
      const original = await readTextFile(plan.file).catch(() => null);
      if (original === null) return "Couldn't read its file.";
      return writeTextFile(plan.file, deleteAt(original, plan.at), original).then(() => null, () => CHANGED);
    }
    if (plan.how === "mcp") return claude(["mcp", "remove", plan.name, "-s", plan.scope], this.setup?.root);
    return claude(["plugin", "uninstall", plan.id, "-s", plan.scope], this.setup?.root);
  }

  // t on a plugin: off or on at its scope, through `claude plugin`.
  async toggle(entry, cx) {
    const { id, scope, on } = changesOf(entry).toggle;
    const why = await claude(["plugin", on ? "disable" : "enable", id, "-s", scope], this.setup?.root);
    if (why) { notify({ title: `Couldn't turn ${entry.item.name} ${on ? "off" : "on"}`, body: why, level: "error" }); return; }
    notify({ title: `Turned ${entry.item.name} ${on ? "off" : "on"}`, body: "New Claude Code sessions pick it up.", level: "success", timeout: 3000 });
    await this.reload({ index: this.index }, cx);
  }

  // Drawing

  render(t) {
    if (this.reading) return this.renderReader(t);
    return v_flex().flex_1().min_h(0).gap(10)
      .when(Boolean(this.creating), (el) => el.child(this.renderCreating(t)))
      .child(this.renderColumns(t));
  }

  renderColumns(t) {
    const { setup } = this;
    const items = this.items();
    const shared = setup?.project && setup.everywhere ? overlaps(setup.project, setup.everywhere) : {};
    const column = (side, c, title, where) => {
      const rows = columnRows(items, side);
      const local = rows.some((r) => r.item?.local);
      const empty = setup?.[side] === undefined ? "Reading…"
        : setup[side] === null ? "No repository for this board yet. Open the board from a terminal inside the project once."
        : `Nothing ${side === "project" ? "project-specific: no CLAUDE.md, AGENTS.md, .mcp.json or .claude folder. n makes a skill, command or subagent" : "set up"}.`;
      return v_flex().flex_1().min_w(0).h_full().rounded(10).border_1().border_color(t.border).bg(t.background)
        .child(h_flex().px(16).pt(12).pb(10).gap(8).items_center().border_b_1().border_color(t.border)
          .child(div().size(8).rounded(4).bg(side === "project" ? t.accent : t.ansi5))
          .child(div().text_size(12.5).font_semibold().child(title))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(where)))
        .when(!rows.length, (el) => el.child(div().p(16).text_size(12).text_color(t.dim).whitespace_normal().child(empty)))
        .when(rows.length > 0, (el) => el.child(div().flex_1().min_h(0).relative().px(8)
          .child(v_virtual_list(`setup-${side}`, rows.length, rows.map((r) => (r.section ? SECTION_H : ROW_H)),
            (i) => (rows[i].section ? `section-${i}` : `row-${rows[i].index}`),
            (range) => rows.slice(range.start, range.end).map((r) => (r.section ? sectionRow(t, r) : itemRow(t, r, r.index === this.index, shared[r.kind]?.has(r.item.name) && side === "project"))))
            .track_scroll(this.scrolls[c]).size_full()
            .on_item_click((key, cx) => key.startsWith("row-") && this.read(Number(key.slice(4)), cx)))
          .child(Scrollbar.vertical(`setup-${side}`).absolute().inset_0())))
        .when(local, (el) => el.child(h_flex().px(16).py(10).gap(8).items_start().border_t_1().border_color(t.border).text_size(11.5).text_color(t.muted)
          .child(div().mt(4).size(7).flex_none().rounded(4).bg(t.ansi3))
          .child(div().flex_1().whitespace_normal()
            .child("Agents started from cards work in a worktree, which holds only committed files: they won't have what's marked."))));
    };
    return h_flex().flex_1().min_h(0).gap(12)
      .child(column("project", 0, "This project", setup?.root ?? ""))
      .child(column("everywhere", 1, "Everywhere", "~/.claude"));
  }

  // The bar naming a new skill, command or subagent: its kind and where, then the name.
  renderCreating(t) {
    const { side, kind } = this.creating;
    const choice = (id, label, on, pick) => h_flex().id(id).h(24).px(9).items_center().rounded(6).cursor_pointer().text_size(12)
      .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.raised)).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { pick(); this.name.focus(); cx.notify(); })
      .child(label);
    const group = (children) => h_flex().p(2).gap(2).rounded(8).border_1().border_color(t.border).bg(t.canvas).children(children);
    return h_flex().px(14).py(10).gap(10).items_center().rounded(10).border_1().border_color(t.accent).bg(t.background)
      .child(div().text_size(12.5).font_semibold().child("New"))
      .child(group(NEW_KINDS.map(([k, label]) => choice(`new-${k}`, label, k === kind, () => { this.creating.kind = k; }))))
      .child(group(SIDES.filter(([s]) => s === "everywhere" || this.setup?.project).map(([s, label]) => choice(`new-${s}`, label, s === side, () => { this.creating.side = s; }))))
      .child(div().flex_1().h(30).px(10).flex().items_center().rounded(7).border_1().border_color(t.border).bg(t.canvas)
        .child(Input.new(this.name).w_full().text_color(t.foreground)));
  }

  // One row read, or edited, in place of the columns: a header with what it is and what can be
  // done with it, then its text drawn as markdown, or the text area.
  renderReader(t) {
    const index = this.reading.index;
    const entry = this.items()[index];
    if (!entry) return div();
    const { item, kind, side } = entry;
    const section = SECTIONS.find(([k]) => k === kind)[1];
    const text = this.reading.text;
    const blocks = text == null ? [] : markdownBlocks(text);
    const tag = (label, color) => div().flex_none().px(6).h(18).flex().items_center().rounded(5).text_size(10.5)
      .bg(alpha(color, "22")).text_color(color).child(label);
    const button = (id, label, key, run, color = t.muted) => h_flex().id(id).h(26).px(9).gap(6).items_center().rounded(6).cursor_pointer().flex_none()
      .border_1().border_color(t.border).text_size(12).text_color(color).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => run(cx))
      .child(label).child(div().text_size(10.5).text_color(t.dim).child(key));
    const editing = this.editing;
    const plan = changesOf(entry);
    const font = settings().font_family;
    const actions = editing
      ? [button("save", "Save", "⌘S", (cx) => cx.spawn((cx) => this.save(cx)), t.foreground), button("cancel", "Cancel", "esc", (cx) => this.editKey("escape", cx))]
      : [
        ...(plan.edit ? [button("edit", "Edit", "e", (cx) => cx.spawn((cx) => this.edit(cx)))] : []),
        ...(plan.toggle ? [button("toggle", plan.toggle.on ? "Turn off" : "Turn on", "t", (cx) => cx.spawn((cx) => this.toggle(entry, cx)))] : []),
        ...(item.path ? [button("editor", "Open in editor", "o", (cx) => { this.openInEditor(entry, cx); this.board.focus(); })] : []),
        ...(plan.remove ? [button("remove", capitalized(removeWord(plan.remove)), "d", (cx) => this.askRemove(entry, cx), t.blocked)] : []),
      ];
    return v_flex().flex_1().min_h(0).rounded(10).border_1().border_color(editing ? t.accent : t.border).bg(t.background)
      .child(h_flex().px(20).pt(14).pb(12).gap(12).items_center().border_b_1().border_color(t.border)
        .child(v_flex().flex_1().min_w(0).gap(6)
          .child(h_flex().gap(10).items_center()
            .child(div().size(8).rounded(4).flex_none().bg(side === "project" ? t.accent : t.ansi5))
            .child(div().min_w(0).truncate().text_size(16).font_semibold().child(item.name))
            .when(Boolean(item.local), (el) => el.child(tag(item.local, t.ansi3)))
            .when(Boolean(editing), (el) => el.child(tag("editing", t.accent))))
          .child(h_flex().gap(8).items_center().text_size(11.5).text_color(t.dim)
            .child(div().flex_none().child(`${side === "project" ? "This project" : "Everywhere"} · ${section}${item.from ? ` · ${item.from}, read-only` : ""}`))
            .child(div().min_w(0).truncate().child(editing?.path ?? item.path ?? ""))))
        .children(actions))
      .child(editing
        ? div().flex_1().min_h(0).px(20).py(14).child(Textarea.new(this.text).size_full().text_size(12.5).text_color(t.foreground)
          .when(Boolean(font), (el) => el.font_family(font)))
        : v_flex().id(`reader-${index}`).flex_1().min_h(0).overflow_y_scroll().px(24).py(18).gap(2)
          .when(text == null, (el) => el.child(div().text_size(12).text_color(t.dim).child("Reading…")))
          .when(text != null && !blocks.length, (el) => el.child(div().text_size(12).text_color(t.dim).child("Empty.")))
          .children(blocks.slice(0, MAX_BLOCKS).map((block) => blockView(t, block)))
          .when(blocks.length > MAX_BLOCKS, (el) => el.child(div().pt(12).text_size(12).text_color(t.dim).child("The rest is in the file: o opens it."))));
  }
}

// The editor picked in snappy-diff's settings: "zed" (its default), "vscode" or "cursor".
async function pickedEditor() {
  try { return JSON.parse(await readTextFile(`${appHome()}/data/snappy-diff/prefs.json`)).editor || "zed"; } catch { return "zed"; }
}

// Runs Claude Code's command line in the project (a local scope is the folder's): null when it
// worked, else the last line it printed.
async function claude(args, cwd) {
  const result = await exec("claude", args, { cwd: cwd ?? home() }).catch((e) => ({ code: 1, stderr: String(e.message ?? e) }));
  return result.code === 0 ? null : ((result.stderr || result.stdout || "").trim().split("\n").pop() || `claude ${args.join(" ")} failed`);
}

const parsed = (text) => { try { return JSON.parse(text ?? ""); } catch { return null; } };
const parseError = (text) => { try { JSON.parse(text); return null; } catch (e) { return `the JSON doesn't parse (${e.message})`; } };
const removeWord = (plan) => (plan.how === "plugin" && plan.scope === "user" ? "uninstall" : plan.how === "file" ? "delete" : "remove");
const capitalized = (word) => word[0].toUpperCase() + word.slice(1);
const DONE = { delete: "Deleted", remove: "Removed", uninstall: "Uninstalled" };
const clamp = (i, n) => Math.max(0, Math.min(n - 1, i));
const cycle = (list, value) => list[(list.indexOf(value) + 1) % list.length];
const fenced = (text) => `\`\`\`\n${text}\n\`\`\``;

const sectionRow = (t, { section, count }) => h_flex().h(SECTION_H).px(8).pt(12).gap(8).items_center()
  .child(sectionLabel(t, section)).child(div().text_size(10.5).text_color(t.dim).child(String(count)));

// A row: the name, its description on one line, and what to know about it on the right.
function itemRow(t, { item }, selected, alsoEverywhere) {
  const tag = (text, color) => div().flex_none().px(6).h(18).flex().items_center().rounded(5).text_size(10.5)
    .bg(alpha(color, "22")).text_color(color).child(text);
  return div().h(ROW_H).pb(4).child(v_flex().h_full().px(10).justify_center().gap(2).rounded(7).border_1().cursor_pointer()
    .border_color(selected ? t.accent : alpha(t.border, "00")).bg(selected ? t.selected : t.background)
    .hover((s) => s.bg(selected ? t.selected : t.hover))
    .child(h_flex().gap(8).items_center()
      .child(div().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(item.name))
      .child(div().flex_1())
      .when(Boolean(item.from), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(item.from)))
      .when(Boolean(alsoEverywhere), (el) => el.child(tag("also everywhere", t.ansi4)))
      .when(Boolean(item.local), (el) => el.child(tag(item.local, t.ansi3))))
    .child(div().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(item.description || " ")));
}

const plain = (text) => text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");

function blockView(t, block) {
  const font = settings().font_family;
  const mono = (el) => (font ? el.font_family(font) : el);
  switch (block.type) {
    case "frontmatter":
    case "code":
      return mono(v_flex().my(4).px(12).py(10).rounded(7).border_1().border_color(t.border).bg(t.canvas)
        .text_size(11.5).text_color(block.type === "frontmatter" ? t.dim : t.foreground)
        .children(block.lines.map((line) => div().min_h(17).whitespace_normal().child(line || " "))));
    case "heading":
      return div().pt(block.level <= 2 ? 10 : 6).pb(2).font_semibold().text_color(t.foreground)
        .text_size(block.level === 1 ? 17 : block.level === 2 ? 15 : 13.5).whitespace_normal().child(plain(block.text));
    case "item":
      return h_flex().items_start().gap(8).pl(block.depth * 16).text_size(12.5)
        .child(div().flex_none().text_color(t.dim).child("•"))
        .child(div().flex_1().min_w(0).text_color(t.muted).whitespace_normal().child(plain(block.text)));
    case "quote":
      return div().pl(10).border_l(2).border_color(t.border).text_size(12.5).text_color(t.dim).whitespace_normal().child(plain(block.text));
    case "gap":
      return div().h(8);
    default:
      return div().text_size(12.5).text_color(t.muted).whitespace_normal().child(plain(block.text));
  }
}
