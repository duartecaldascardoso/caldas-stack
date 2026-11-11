import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownBlocks } from "../mods/kanban-md/markdown.js";

test("markdownBlocks reads frontmatter, headings, lists, code and paragraphs", () => {
  const text = "---\nname: deploy\n---\n# Deploy\n\nShips the app\nto production.\n\n- one\n  - nested\n1. first\n\n```sh\nnpm run deploy\n\n```\n> careful";
  assert.deepEqual(markdownBlocks(text), [
    { type: "frontmatter", lines: ["name: deploy"] },
    { type: "heading", level: 1, text: "Deploy" },
    { type: "gap" },
    { type: "text", text: "Ships the app to production." },
    { type: "gap" },
    { type: "item", depth: 0, text: "one" },
    { type: "item", depth: 1, text: "nested" },
    { type: "item", depth: 0, text: "first" },
    { type: "gap" },
    { type: "code", lines: ["npm run deploy", ""] },
    { type: "quote", text: "careful" },
  ]);
  assert.deepEqual(markdownBlocks(""), []);
});
