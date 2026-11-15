// Go to (cmd-k) and search (cmd-f): what they find, and the panel they show it in.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { props, settings } from "herdr";
import { show_fps_monitor, hide_fps_monitor, fps_monitor_visible } from "gpui-fps";
import { fileMatches } from "./tree.js";
import { EDITORS, icon, alpha } from "./ui.js";

export function paletteResults(view) {
  const query = view.paletteInput.value().trim();
  if (view.palette === "lines") {
    if (query.length < 2) return [];
    const needle = query.toLowerCase();
    const out = [];
    for (const f of view.files) {
      for (const h of f.hunks) {
        let old = h.oldStart;
        let next = h.newStart;
        for (const line of h.lines) {
          const side = line.kind === "-" ? "old" : "new";
          const n = side === "old" ? old : next;
          if (line.kind !== "+") old++;
          if (line.kind !== "-") next++;
          if (!line.text.toLowerCase().includes(needle)) continue;
          out.push({ label: line.text.trim(), hint: `${f.name}:${n}`, run: (cx) => { view.focusFile(f.id, cx); view.jumpToLine(f.id, side, n, cx); } });
          if (out.length >= 100) return out;
        }
      }
    }
    return out;
  }
  const s = view.source;
  const files = view.files.filter((f) => !query || fileMatches(f, query)).slice(0, 40)
    .map((f) => ({ label: f.name, hint: `+${f.add} −${f.del}`, run: (cx) => view.focusFile(f.id, cx) }));
  const commits = view.commits.filter((c) => !query || `${c.sha} ${c.subject}`.toLowerCase().includes(query.toLowerCase())).slice(0, 20)
    .map((c) => ({ label: `${c.sha.slice(0, 7)} ${c.subject}`, hint: "commit", run: (cx) => view.reload({ commit: c.sha }, cx) }));
  const actions = [
    ["Review next unviewed file", "n", (cx) => view.reviewNext(cx)],
    ["Mark file viewed", "v", (cx) => { const f = view.activeFile(); if (f) view.toggleViewed(f, cx, true); }],
    ["Open file in " + EDITORS[view.prefs.editor], "o", (cx) => view.openInEditor(view.activeFile(), cx)],
    ["Send comments to the agent", "", (cx) => view.sendToAgent(cx)],
    ["Copy comments as a prompt", "", (cx) => view.copyReview(cx)],
    ["Toggle sidebar", "⌘B", (cx) => view.setPref("sidebar", !view.prefs.sidebar, cx)],
    [view.prefs.diffStyle === "split" ? "Unified view" : "Split view", "", (cx) => view.setPref("diffStyle", view.prefs.diffStyle === "split" ? "unified" : "split", cx)],
    ["Collapse or expand all files", "", (cx) => view.toggleAll(cx)],
    [`${s.ignoreWhitespace ? "Show" : "Ignore"} whitespace changes`, "", (cx) => view.reload({ ignoreWhitespace: !s.ignoreWhitespace }, cx)],
    ["Reload", "", (cx) => view.reload({}, cx)],
    // Herdr's own frame-rate overlay, to see how the diff scrolls on view machine.
    [fps_monitor_visible() ? "Hide frame rate" : "Show frame rate", "", () => (fps_monitor_visible() ? hide_fps_monitor() : show_fps_monitor())],
    ...(props()?.overlay ? [["Open in a tab", "t", () => view.openInTab()]] : []),
    ["Overview", "", (cx) => view.openOverview(cx)],
    [`${view.prefs.wholeFiles ? "Folded" : "Whole"} files`, "", (cx) => view.setWholeFiles(!view.prefs.wholeFiles, cx)],
    ...(view.unsentComments().length ? [["Send comments to GitHub", "", (cx) => view.sendToGitHub(cx)]] : []),
  ].filter(([label]) => !query || label.toLowerCase().includes(query.toLowerCase()))
    .map(([label, hint, run]) => ({ label, hint: hint || "action", run }));
  const shownPr = view.prShown() ? view.pr.number : null;
  const prs = (view.prs ?? []).filter((p) => p.number !== shownPr)
    .filter((p) => !query || `#${p.number} ${p.title}`.toLowerCase().includes(query.toLowerCase())).slice(0, 20)
    .map((p) => ({ label: `#${p.number} ${p.title}`, hint: p.hint || "pull request", run: (cx) => cx.spawn((cx) => view.openPullRequest(view.source.repo, p.number, cx)) }));
  // With nothing typed, pull requests asking for your review come first.
  const asked = prs.filter((p) => p.hint.startsWith("your review"));
  return query ? [...files, ...prs, ...commits, ...actions] : [...asked, ...files, ...prs.filter((p) => !asked.includes(p)), ...commits, ...actions];
}

export function paletteView(view, t) {
  const results = paletteResults(view);
  const placeholder = view.palette === "lines" ? "Search the code in view diff" : "Go to a file, commit or action";
  return div().absolute().inset_0().flex().justify_center().bg(alpha(t.background, "99"))
    .on_mouse_down("left", (_e, cx) => { view.palette = null; view.handle.focus(); cx.notify(); })
    .child(v_flex().id("palette").mt(80).w(600).max_h(460).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().h(44).px(12).gap(10).items_center().border_b_1().border_color(t.border)
        .child(div().text_color(t.dim).child(icon("search", 15)))
        .child(div().flex_1().child(Input.new(view.paletteInput).w_full().text_size(14)))
        .child(div().text_size(11).text_color(t.dim).child(placeholder)))
      .child(v_flex().id("palette-results").max_h(400).overflow_y_scrollbar().p(6).gap(1)
        .when(!results.length, (el) => el.child(div().p(12).text_size(12.5).text_color(t.dim)
          .child(view.palette === "lines" ? "Type at least two characters." : "Nothing matches.")))
        .children(results.slice(0, 120).map((r, i) => h_flex().id(`result-${i}`).h(32).px(10).gap(10).items_center().rounded(6).cursor_pointer()
          .when(i === view.paletteIndex, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => view.pickResult(r, cx))
          .child(div().flex_1().min_w(0).truncate().text_size(13)
            .when(view.palette === "lines", (el) => el.font_family(settings().font_family)).child(r.label))
          .child(div().flex_none().text_size(11.5).text_color(t.dim).child(r.hint))))));
}
