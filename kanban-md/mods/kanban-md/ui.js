// Small pieces the board and its panels draw with. Every colour comes from the theme, `t`.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { settings } from "herdr";
import { CHIPS_H, CHIP_GAP, CHIPS_ROW_GAP, chipLayout } from "./cards.js";

// A theme colour at an alpha ("66"), when it is a plain hex colour.
export const alpha = (color, hex) => (/^#[0-9a-f]{6}$/i.test(color) ? color + hex : color);

// Herdr scales a mod by the person's zoom after layout: sizes it reports are on-screen pixels,
// while the lengths a mod sets are scaled. Measurements come back through this.
export const unzoom = (px) => px / (settings().zoom || 1);

// A key as a keycap.
export const keycap = (t, key) => div().h(18).min_w(18).px(5).flex().flex_none().items_center().justify_center().rounded(4)
  .border_1().border_color(t.border).bg(t.background).text_size(10.5).text_color(t.muted).child(key);

// Keys as keycaps, each with what it does: [[key, label]].
export function keycaps(t, pairs) {
  return h_flex().gap(14).items_center().children(pairs.map(([key, label]) =>
    h_flex().gap(5).items_center().child(keycap(t, key)).child(label)));
}

// A small uppercase heading over a section.
export const sectionLabel = (t, text) => div().text_size(10.5).font_medium().text_color(t.dim).child(text.toUpperCase());

// Herdr's own marks, as its agents sidebar draws them: a turning ring while working, "Needs you"
// when blocked, a filled dot when done, a hollow ring when idle.
export function agentMark(t, agent) {
  if (agent.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
  if (agent.status === "blocked") {
    return div().flex_none().px(6).h(18).rounded(5).bg(alpha(t.blocked, "26")).text_size(10.5).font_semibold()
      .text_color(t.blocked).flex().items_center().child("Needs you");
  }
  if (agent.status === "idle") return div().size(7).mx(2).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  return div().size(7).mx(2).flex_none().rounded(4).bg(t.done);
}

// Chips from chipsOf, in rows of `available` px.
export function chipRowsView(t, chips, available) {
  const draw = ({ mark, texts }) => h_flex().h(CHIPS_H).max_w(available).px(7).gap(6).items_center().flex_none().rounded(5)
    .bg(t.background).border_1().border_color(t.border).text_size(11)
    .when(Boolean(mark), (el) => el.child(mark.ring
      ? div().size(7).flex_none().rounded(4).border(1.5).border_color(mark.color)
      : div().size(6).flex_none().rounded(3).bg(mark.color)))
    .children(texts.map(([text, color]) => div().min_w(0).truncate().text_color(color).child(text)));
  return v_flex().gap(CHIPS_ROW_GAP).children(chipLayout(chips.map((c) => c.width), available).map((row) =>
    h_flex().h(CHIPS_H).gap(CHIP_GAP).items_center().children(row.map((i) => draw(chips[i])))));
}
