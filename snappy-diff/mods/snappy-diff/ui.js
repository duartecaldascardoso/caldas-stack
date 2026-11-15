// Small pieces snappy diff draws with, shared by the view and its panels. Colours come from the theme, `t`.
import { div, svg } from "gpui-kit";
import { settings } from "herdr";

export const ICONS = "mods/snappy-diff/icons";
export const CODE_SIZE = 12.5;
export const LINE_H = 20;
export const HEADER_H = 40;
export const COMMENT_LINE_H = 18;
export const EDITORS = { zed: "Zed", vscode: "VS Code", cursor: "Cursor" };
export const SYNTAX = { keyword: "ansi5", string: "ansi2", number: "ansi3", constant: "ansi3", function: "ansi4", type: "ansi6", property: "ansi4" };
// Fixed-width parts of a file header, from the right edge, so a click can tell them apart.
export const HEADER_PARTS = { viewed: 92, stats: 120, comments: 44, editor: 32 };

// Herdr scales a mod by the person's zoom after layout: sizes and positions it reports are on-screen
// pixels, while the lengths a mod sets are scaled. Measurements come back through this.
export const unzoom = (px) => px / (settings().zoom || 1);
export const unzoomBounds = (b) => ({ x: unzoom(b.x), y: unzoom(b.y), width: unzoom(b.width), height: unzoom(b.height) });
export const icon = (name, size = 14) => svg(`${ICONS}/${name}.svg`).size(size).flex_none();
export const alpha = (color, hex) => (/^#[0-9a-f]{6}$/i.test(color) ? color + hex : color);
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A badge for a file's type, in place of an icon set: TS, {}, #, M↓ and the like.
export function badge(name, t) {
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
