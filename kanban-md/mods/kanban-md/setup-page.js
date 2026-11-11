// The Setup page: what agents work with for this board's project, beside what they work with
// everywhere. Two columns of sections (instructions, settings, skills, …), a row per file or
// entry; what a worktree won't have is marked. Each column is a virtual list, so the selected
// row can be scrolled into view.
import { div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar } from "gpui-base";
import { alpha, sectionLabel } from "./ui.js";
import { overlaps } from "./setup.js";

export const SECTIONS = [
  ["instructions", "Instructions"], ["settings", "Settings"], ["skills", "Skills"], ["commands", "Commands"],
  ["agents", "Subagents"], ["hooks", "Hooks"], ["servers", "MCP servers"], ["plugins", "Plugins"],
];
const SECTION_H = 36;
const ROW_H = 50;

// Every item in page order, the project's then everywhere's: [{ side, kind, item }]. The
// selection is an index into this.
export function setupItems(setup) {
  if (!setup) return [];
  return ["project", "everywhere"].flatMap((side) => SECTIONS.flatMap(([kind]) =>
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

// `setup`: { root, project, everywhere } (project null without a repository); `selected`: an
// index into setupItems; `scrolls`: a VirtualListScrollHandle per column; `pick(index, cx)`
// opens a row.
export function setupPage(t, { setup, selected, scrolls, pick }) {
  const items = setupItems(setup);
  const shared = setup?.project && setup.everywhere ? overlaps(setup.project, setup.everywhere) : {};
  const column = (side, c, title, where) => {
    const rows = columnRows(items, side);
    const local = rows.some((r) => r.item?.local);
    const empty = side === "project" && !setup?.project
      ? "No repository for this board yet. Open the board from a terminal inside the project once."
      : `Nothing ${side === "project" ? "project-specific: no CLAUDE.md, AGENTS.md, .mcp.json or .claude folder" : "set up"}.`;
    return v_flex().flex_1().min_w(0).h_full().rounded(10).border_1().border_color(t.border).bg(t.background)
      .child(h_flex().px(16).pt(12).pb(10).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().size(8).rounded(4).bg(side === "project" ? t.accent : t.ansi5))
        .child(div().text_size(12.5).font_semibold().child(title))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(where)))
      .when(!rows.length, (el) => el.child(div().p(16).text_size(12).text_color(t.dim).whitespace_normal().child(setup ? empty : "Reading…")))
      .when(rows.length > 0, (el) => el.child(div().flex_1().min_h(0).relative().px(8)
        .child(v_virtual_list(`setup-${side}`, rows.length, rows.map((r) => (r.section ? SECTION_H : ROW_H)),
          (i) => (rows[i].section ? `section-${i}` : `row-${rows[i].index}`),
          (range) => rows.slice(range.start, range.end).map((r) => (r.section ? sectionRow(t, r) : itemRow(t, r, r.index === selected, shared[r.kind]?.has(r.item.name) && side === "project"))))
          .track_scroll(scrolls[c]).size_full()
          .on_item_click((key, cx) => key.startsWith("row-") && pick(Number(key.slice(4)), cx)))
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
