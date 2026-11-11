// Markdown as blocks to draw, enough for instructions and skills: frontmatter, headings, list
// items, code and paragraphs. Pure.
//
// [{ type: "frontmatter" | "code", lines } | { type: "heading", level, text } |
//  { type: "item", depth, text } | { type: "text", text } | { type: "quote", text } | { type: "gap" }]
export function markdownBlocks(text) {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      blocks.push({ type: "frontmatter", lines: lines.slice(1, end) });
      i = end + 1;
    }
  }
  for (; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const code = [];
      while (++i < lines.length && !lines[i].trimStart().startsWith(fence[1])) code.push(lines[i]);
      blocks.push({ type: "code", lines: code });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const item = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);
    if (heading) blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
    else if (item) blocks.push({ type: "item", depth: Math.floor(item[1].length / 2), text: item[2] });
    else if (quote) blocks.push({ type: "quote", text: quote[1] });
    else if (!line.trim()) { if (blocks.length && blocks.at(-1).type !== "gap") blocks.push({ type: "gap" }); }
    else if (blocks.at(-1)?.type === "text") blocks.at(-1).text += ` ${line.trim()}`;
    else blocks.push({ type: "text", text: line.trim() });
  }
  return blocks;
}
