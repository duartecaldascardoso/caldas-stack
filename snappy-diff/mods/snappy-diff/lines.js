// The diff's rows: file headers, lines side by side or unified, and the comments, GitHub threads
// and comment editor under them. Each takes the view, whose layout (`view.m`) it draws to.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { segments, wrapLines } from "./rows.js";
import { isMoved } from "./moved.js";
import { isViewed, changedSinceViewed } from "./review.js";
import { ICONS, CODE_SIZE, LINE_H, HEADER_H, COMMENT_LINE_H, HEADER_PARTS, SYNTAX, unzoom, icon, alpha, plural, badge } from "./ui.js";

export function rowView(view, t, code, item, index) {
  if (item.t === "file") return headerView(view, t, item.f, false, index);
  const h = view.sizes[index];
  const row = h_flex().h(h).w_full().font_family(code).text_size(CODE_SIZE);
  if (item.t === "hunk") {
    return row.items_center().px(16).gap(10).bg(alpha(t.foreground, "08")).text_color(t.dim)
      .cursor_pointer().hover((st) => st.bg(alpha(t.foreground, "10")))
      .child(icon("expand", 12))
      .child(plural(item.hidden, "unmodified line"))
      .when(Boolean(item.context), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(item.context)));
  }
  if (item.t === "notice") return row.items_center().px(16).text_color(t.dim).child(item.text);
  if (item.t === "comment") return commentView(view, t, item.c);
  if (item.t === "thread") return threadView(view, t, item.th, code);
  if (item.t === "editor") return editorView(view, t, item.e);
  const m = view.m;
  if (item.t === "split") {
    return row.child(cellView(view, t, item.left, m, m.side, h, "old", item.f))
      .child(div().w(1).h_full().bg(t.border))
      .child(cellView(view, t, item.right, m, m.width - m.side - 1, h, "new", item.f));
  }
  return row.child(unifiedView(view, t, item, m, h));
}

export function lineColors(view, t, kind) {
  if (kind === "add") return { bg: alpha(t.ansi2, "1c"), gutter: alpha(t.ansi2, "30"), mark: alpha(t.ansi2, "48"), bar: t.ansi2 };
  if (kind === "del") return { bg: alpha(t.ansi1, "1c"), gutter: alpha(t.ansi1, "30"), mark: alpha(t.ansi1, "48"), bar: t.ansi1 };
  return { bg: null, gutter: null, mark: null, bar: null };
}

// Moved code needs little reading: it is faded.
export function isMovedCell(view, file, cell) {
  return cell.kind !== "ctx" && isMoved(view.moves, file.id, cell.kind === "del" ? "old" : "new", cell.n ?? (cell.kind === "del" ? cell.old : cell.new));
}

export function cellView(view, t, cell, m, width, h, side, file) {
  if (!cell) {
    return div().w(width).h(h).flex_none().relative().overflow_hidden().bg(alpha(t.foreground, "05"))
      .child(svg(`${ICONS}/hatch.svg`).absolute().top(0).left(0).w(1200).h(1200).text_color(alpha(t.foreground, "1c")));
  }
  const colors = lineColors(view, t, cell.kind);
  const commented = view.editing && view.editing.file && cell.n >= view.editing.start && cell.n <= view.editing.end
    && view.editing.side === (side === "old" && cell.kind !== "ctx" ? "old" : "new");
  return h_flex().w(width).h(h).flex_none().items_start().when(Boolean(colors.bg), (el) => el.bg(colors.bg))
    .when(commented, (el) => el.bg(alpha(t.accent, "26")))
    .child(h_flex().w(m.number).h_full().flex_none().items_start().justify_end().pr(10).text_color(colors.bar ?? t.dim)
      .when(Boolean(colors.gutter), (el) => el.bg(colors.gutter).border_l_2().border_color(colors.bar))
      .child(div().h(LINE_H).flex().items_center().child(String(cell.n))))
    .child(textView(view, t, cell, m.cols, colors).when(isMovedCell(view, file, cell), (el) => el.opacity(0.45)));
}

export function unifiedView(view, t, item, m, h) {
  const cell = item.cell;
  const colors = lineColors(view, t, cell.kind);
  const number = (n) => h_flex().w(m.number).h(LINE_H).flex_none().justify_end().pr(10).child(n == null ? "" : String(n));
  return h_flex().w_full().h(h).items_start().when(Boolean(colors.bg), (el) => el.bg(colors.bg))
    .child(h_flex().h_full().flex_none().items_start().text_color(colors.bar ?? t.dim)
      .when(Boolean(colors.gutter), (el) => el.bg(colors.gutter).border_l_2().border_color(colors.bar))
      .child(number(item.old)).child(number(item.new)))
    .child(div().w(16).flex_none().h(LINE_H).flex().items_center().justify_center().text_color(colors.bar ?? t.dim)
      .child(cell.kind === "add" ? "+" : cell.kind === "del" ? "-" : ""))
    .child(textView(view, t, cell, m.cols, colors).when(isMovedCell(view, item.f, cell), (el) => el.opacity(0.45)));
}

// The cell's text, wrapped at `cols` characters, coloured by syntax and word change. Each
// coloured piece is placed at its own column: laid side by side, pieces push each other along,
// because every piece's width is rounded up to a whole pixel, and a line would outgrow the
// width it was wrapped to.
export function textView(view, t, cell, cols, colors) {
  const lines = [];
  for (const [start, end] of wrapLines(cell.text, cols)) {
    let column = 0;
    // Spaces between tokens need no element of their own: each piece is placed by its column.
    const pieces = [];
    for (const s of segments(cell, start, end)) {
      if (s.marked || s.text.trim()) pieces.push({ ...s, left: column * view.charW });
      column += s.text.length;
    }
    lines.push(div().relative().h(LINE_H).w_full().children(pieces.map((s) => {
      return div().absolute().top(0).left(s.left).h(LINE_H).flex().items_center().whitespace_nowrap()
        .text_color(s.kind === "comment" ? t.dim : s.kind === "punctuation" ? t.muted : SYNTAX[s.kind] ? t[SYNTAX[s.kind]] : t.foreground)
        .when(s.marked && Boolean(colors.mark), (el) => el.bg(colors.mark).rounded(2))
        .child(s.text);
    })));
  }
  return v_flex().flex_1().min_w(0).pl(6).children(lines);
}

export function headerView(view, t, f, pinned, index = -1) {
  const collapsed = view.isCollapsed(f);
  const viewed = isViewed(view.review, f);
  const count = view.comments.filter((c) => c.file === f.id && !c.outdated).length;
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
    .when(changedSinceViewed(view.review, f), (el) => el.child(tag("changed since viewed", true)))
    .when((view.moves.perFile.get(f.id) ?? 0) > 0, (el) => el.child(div().ml(2).text_size(11.5).text_color(t.dim).child(`${view.moves.perFile.get(f.id)} moved`)))
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
    if (e.bounds) view.pressHeader(f, view.headerPart(unzoom(e.bounds.x + e.bounds.width - e.position.x)), cx);
  });
}

// A GitHub review thread under its line: whose it is, the conversation, and Resolve.
export function threadView(view, t, thread, code) {
  const lines = view.threadLines(thread, view.threadCols());
  const range = thread.start === thread.end ? `Line ${thread.end}` : `Lines ${thread.start}–${thread.end}`;
  return h_flex().w_full().px(16).py(8).bg(alpha(t.ansi4, "0d"))
    .child(v_flex().flex_1().min_w(0).p(10).rounded(8).border_1().border_color(alpha(t.ansi4, "66")).bg(t.popover)
      .child(h_flex().h(26).gap(8).items_center().text_size(11.5).text_color(t.dim)
        .child(div().text_color(t.ansi4).child(icon("pull", 12)))
        .child(div().text_color(t.foreground).child("GitHub"))
        .child(div().flex_1().child(`${range} · ${plural(thread.comments.length, "comment")}`))
        .child(div().w(64).flex().justify_end().text_color(t.muted).child("Resolve")))
      .children(lines.map((line) => div().h(COMMENT_LINE_H).flex().items_center().whitespace_nowrap().text_size(12.5)
        .when(Boolean(code), (el) => el.font_family(code))
        .text_color(line.kind === "author" ? t.ansi4 : line.kind === "more" ? t.dim : t.foreground)
        .child(line.text))));
}

export function commentView(view, t, c) {
  return h_flex().w_full().px(16).py(8).bg(alpha(t.foreground, "05"))
    .child(v_flex().flex_1().min_w(0).p(10).gap(4).rounded(8).border_1().border_color(t.border).bg(t.popover)
      .child(h_flex().gap(8).text_size(11.5).text_color(t.dim)
        .child(icon("comment", 12))
        .child(div().flex_1().child(c.start === c.end ? `Line ${c.end}` : `Lines ${c.start}–${c.end}`))
        .when(Boolean(c.sent), (el) => el.child(div().px(6).rounded(4).bg(t.raised).text_color(t.muted).child("on GitHub")))
        .child(div().w(46).flex().justify_end().text_color(t.muted).child("Edit"))
        .child(div().w(46).flex().justify_end().text_color(t.muted).child("Delete")))
      .child(div().text_size(13).text_color(t.foreground).child(c.text)));
}

export function editorView(view, t, e) {
  const lines = e.start === e.end ? `Line ${e.end}` : `Lines ${e.start}–${e.end}`;
  return h_flex().w_full().px(16).py(8).bg(alpha(t.accent, "14"))
    .child(v_flex().flex_1().p(10).gap(8).rounded(8).border_1().border_color(t.accent).bg(t.popover)
      .child(Input.new(view.commentInput).h(30).w_full().text_size(13).text_color(t.foreground))
      .child(h_flex().gap(8).items_center().text_size(11.5)
        .child(div().flex_1().text_color(t.dim).child(`${lines} · ↵ to save, esc to cancel`))
        .child(div().w(70).flex().justify_end().text_color(t.muted).child("Cancel"))
        .child(div().w(76).py(4).flex().justify_center().rounded(6).bg(t.solid).text_color(t.solid_foreground).child("Comment"))));
}
