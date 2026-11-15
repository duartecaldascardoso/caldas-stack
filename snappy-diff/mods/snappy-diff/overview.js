// Overview: the diff at a glance, in a panel over the view.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { settings } from "herdr";
import { areas, effort, hints } from "./insights.js";
import { breakdown } from "./tree.js";
import { isViewed } from "./review.js";
import { icon, alpha, plural, badge } from "./ui.js";

export function overviewView(view, t) {
  const files = view.files;
  const seen = (f) => isViewed(view.review, f);
  const work = effort(files, view.moves, seen);
  const kinds = breakdown(files);
  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  const count = (type) => files.filter((f) => (type === "rename" ? f.type.startsWith("rename") : f.type === type)).length;
  const viewed = files.filter(seen).length;
  const progress = work.lines ? Math.round((work.viewedLines / work.lines) * 100) : 100;
  const open = view.comments.filter((c) => !c.outdated).length;
  const addressed = view.comments.length - open;
  const prefix = view.overviewPrefix;
  const where = areas(files, prefix, seen);
  const largest = [...files].sort((a, b) => b.add + b.del - (a.add + a.del)).slice(0, 8);
  const flags = hints(files, view.churn);
  const s = view.source;
  const subject = s.commit ? `commit ${s.commit.slice(0, 7)}` : `${s.since ? s.since.slice(0, 7) : s.base}...${s.head || "working tree"}`;
  const leave = (cx) => { view.overview = false; view.handle.focus(); cx.notify(); };
  const n = (v) => v.toLocaleString();

  const bar = (a, d, max, width = 140) => h_flex().w(width).h(6).gap(2).flex_none()
    .when(a > 0, (el) => el.child(div().h_full().rounded(2).bg(t.ansi2).w(Math.max(2, Math.round((width * a) / max)))))
    .when(d > 0, (el) => el.child(div().h_full().rounded(2).bg(t.ansi1).w(Math.max(2, Math.round((width * d) / max)))));
  const tile = (label, value, note, extra) => v_flex().flex_1().min_w(0).p(12).gap(4).rounded(8).border_1().border_color(t.border).bg(t.background)
    .child(div().text_size(11.5).text_color(t.dim).child(label))
    .child(div().text_size(20).font_semibold().child(value))
    .when(Boolean(extra), (el) => el.child(extra))
    .child(div().text_size(11.5).text_color(t.dim).truncate().child(note));
  const panel = (title, aside, body) => v_flex().min_w(0).p(14).gap(10).rounded(8).border_1().border_color(t.border).bg(t.background)
    .child(h_flex().gap(8).items_center().child(div().flex_1().text_size(13).font_medium().child(title)).when(Boolean(aside), (el) => el.child(aside)))
    .child(body);
  const row = (id, onClick) => h_flex().id(id).h(30).px(8).gap(10).items_center().rounded(6).cursor_pointer().hover((st) => st.bg(t.hover))
    .on_click((_e, cx) => onClick(cx));
  const name = (path) => {
    const slash = path.lastIndexOf("/", path.length - 2);
    return h_flex().flex_1().min_w(0).truncate()
      .when(slash >= 0, (el) => el.child(div().text_color(t.muted).child(path.slice(0, slash + 1))))
      .child(div().child(path.slice(slash + 1)));
  };
  const maxArea = Math.max(1, ...where.map((a) => Math.max(a.add, a.del)));
  const maxFile = Math.max(1, ...largest.map((f) => Math.max(f.add, f.del)));
  const maxKind = Math.max(1, ...kinds.map((k) => Math.max(k.add, k.del)));
  const crumbs = prefix.split("/").filter(Boolean);

  const whereBody = v_flex().gap(1).children(where.map((a, i) => row(`area-${i}`, (cx) => {
    if (a.deeper) { view.overviewPrefix = a.path; cx.notify(); return; }
    leave(cx);
    view.focusFile(files.find((f) => f.name === a.path).id, cx);
  })
    .child(name(a.name + (a.deeper ? "/" : "")))
    .child(div().w(70).flex().justify_end().text_size(11.5).text_color(t.dim).child(plural(a.files, "file")))
    .child(bar(a.add, a.del, maxArea))
    .child(div().w(54).flex().justify_end().text_size(11.5).text_color(a.viewed === a.files ? t.ansi2 : t.dim).child(`${a.viewed}/${a.files}`))));
  const breadcrumb = h_flex().gap(4).text_size(11.5).text_color(t.dim)
    .child(div().id("crumb-root").cursor_pointer().hover((st) => st.text_color(t.foreground)).on_click((_e, cx) => { view.overviewPrefix = ""; cx.notify(); }).child("all"))
    .children(crumbs.map((part, i) => h_flex().gap(4).child("/").child(div().id(`crumb-${i}`).cursor_pointer().hover((st) => st.text_color(t.foreground))
      .on_click((_e, cx) => { view.overviewPrefix = `${crumbs.slice(0, i + 1).join("/")}/`; cx.notify(); }).child(part))));

  return div().absolute().inset_0().flex().justify_center().py(36).bg(alpha(t.background, "b3"))
    .on_mouse_down("left", (_e, cx) => leave(cx))
    .child(v_flex().id("overview").w(1040).h_full().rounded(12).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().px(20).py(14).gap(12).items_center().border_b_1().border_color(t.border)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(15).font_semibold().child("Overview"))
          .child(div().text_size(12).text_color(t.dim).font_family(settings().font_family).truncate().child(view.ms != null ? `${subject} · ${view.ms} ms` : subject)))
        .when(viewed < files.length, (el) => el.child(h_flex().id("review-next").h(30).px(12).gap(6).items_center().rounded(6).bg(t.solid)
          .text_color(t.solid_foreground).text_size(12.5).cursor_pointer().on_click((_e, cx) => { leave(cx); view.reviewNext(cx); })
          .child("Review next file")))
        .child(view.button("overview-close", icon("x"), (cx) => leave(cx))))
      .child(v_flex().id("overview-body").flex_1().min_h(0).overflow_y_scrollbar().p(18).gap(14)
        .child(h_flex().gap(10)
          .child(tile("Files", n(files.length), [count("new") && `${count("new")} new`, count("change") && `${count("change")} changed`, count("deleted") && `${count("deleted")} deleted`, count("rename") && `${count("rename")} renamed`].filter(Boolean).join(" · ")))
          .child(tile("Lines", h_flex().gap(8).child(div().text_color(t.ansi2).child(`+${n(add)}`)).child(div().text_color(t.ansi1).child(`−${n(del)}`)),
            [`${n(work.lines)} to read`, work.moved && `${n(work.moved)} moved`, work.skipped && `${n(work.skipped)} generated`].filter(Boolean).join(" · ")))
          .child(tile("Review time", work.minutes < 60 ? `~${work.minutes} min` : `~${Math.floor(work.minutes / 60)} h ${work.minutes % 60} min`, "at 400 lines an hour"))
          .child(tile("Reviewed", `${progress}%`, `${viewed} of ${plural(files.length, "file")} viewed`,
            div().h(4).w_full().rounded(2).bg(t.border).child(div().h_full().rounded(2).bg(t.ansi2).w(Math.round(2 * progress)))))
          .child(tile("Comments", n(open), addressed ? `${addressed} addressed` : open ? "open" : "none yet")))
        .child(h_flex().gap(12).items_start()
          .child(div().flex_1().min_w(0).child(panel("Where", breadcrumb, whereBody)))
          .child(div().w(330).flex_none().child(panel("Kinds", null, v_flex().gap(1).children(kinds.map((k) => row(`kind-${k.id}`, (cx) => {
            leave(cx);
            view.filterInput.set_value(`is:${k.id}`);
            view.filter = `is:${k.id}`;
            if (!view.prefs.sidebar) view.setPref("sidebar", true, cx);
            cx.notify();
          }).child(div().flex_1().child(k.label)).child(bar(k.add, k.del, maxKind, 110))
            .child(div().w(80).flex().justify_end().text_size(11.5).text_color(t.dim).child(`+${n(k.add)} −${n(k.del)}`))))))))
        .child(h_flex().gap(12).items_start()
          .child(div().flex_1().min_w(0).child(panel("Largest files", null, v_flex().gap(1).children(largest.map((f, i) => row(`large-${i}`, (cx) => { leave(cx); view.focusFile(f.id, cx); })
            .child(badge(f.name, t))
            .child(h_flex().flex_1().min_w(0).gap(8)
              .child(div().flex_none().child(f.name.split("/").pop()))
              .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(f.name.includes("/") ? f.name.slice(0, f.name.lastIndexOf("/")) : "")))
            .child(bar(f.add, f.del, maxFile, 110))
            .child(div().w(84).flex().justify_end().text_size(11.5).text_color(t.dim).child(`+${n(f.add)} −${n(f.del)}`)))))))
          .child(div().flex_1().min_w(0).child(panel("Worth a closer look", null, flags.length
            ? v_flex().gap(10).children(flags.map((h) => v_flex().gap(4)
              .child(h_flex().gap(8).items_center().child(div().size(6).rounded(3).bg(t.ansi3)).child(div().text_size(12.5).child(h.label)))
              .child(div().pl(14).text_size(11.5).text_color(t.dim).child(h.detail))
              .when(h.files.length > 0, (el) => el.child(h_flex().pl(14).gap(6).flex_wrap().children(h.files.slice(0, 6).map((f, i) =>
                div().id(`hint-${h.id}-${i}`).px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).cursor_pointer()
                  .hover((st) => st.text_color(t.foreground)).on_click((_e, cx) => { leave(cx); view.focusFile(f.id, cx); })
                  .child(f.name.split("/").pop())))))))
            : div().text_size(12).text_color(t.dim).child("Nothing stands out.")))))
        .when(view.commits.length > 0, (el) => {
          const maxCommit = Math.max(1, ...view.commits.map((c) => Math.max(c.add, c.del)));
          return el.child(panel("Commits", div().text_size(11.5).text_color(t.dim).child(`${plural(view.commits.length, "commit")} · ${plural(new Set(view.commits.map((c) => c.author)).size, "author")}`),
            v_flex().gap(1).children(view.commits.slice(0, 50).map((c, i) => row(`commit-${i}`, (cx) => { leave(cx); view.reload({ commit: c.sha }, cx); })
              .when(c.sha === s.commit, (r) => r.bg(t.selected))
              .child(div().w(64).flex_none().text_size(11.5).text_color(t.dim).font_family(settings().font_family).child(c.sha.slice(0, 7)))
              .child(div().flex_1().min_w(0).truncate().child(c.subject))
              .child(div().w(150).flex_none().truncate().text_size(11.5).text_color(t.dim).child(`${c.author}, ${c.date}`))
              .child(bar(c.add, c.del, maxCommit, 90))))));
        })));
}
