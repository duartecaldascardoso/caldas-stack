import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLUMNS, emptyLanes, parse, serialize, boardName,
  addCard, editCard, removeCard, shiftCard, reorderCard, cardLinks, withoutLinks, withLink,
} from "../mods/kanban-md/board.js";

const lanes = (...cards) => COLUMNS.map((_, i) => cards[i] ?? []);

test("parse reads cards under each column heading", () => {
  const text = "# demo\n\n## Ideas\n- one\n- two\n\n## work\n* three\n";
  assert.deepEqual(parse(text), lanes(["one", "two"], [], ["three"]));
});

test("parse ignores unknown headings, their cards and stray lines", () => {
  const text = "intro\n## Later\n- lost\n## Done\nnote\n-   kept  \n";
  assert.deepEqual(parse(text), lanes([], [], [], [], ["kept"]));
});

test("parse of a missing file is an empty board", () => {
  assert.deepEqual(parse(null), emptyLanes());
});

test("serialize writes every column and round-trips", () => {
  const board = lanes(["a"], [], ["b", "c"]);
  const text = serialize("demo", board);
  assert.equal(text, "# demo\n\n## Ideas\n- a\n\n## Plan\n\n## Work\n- b\n- c\n\n## Review\n\n## Ship\n");
  assert.deepEqual(parse(text), board);
});

test("boards with the old column names open, and save with the new ones", () => {
  const old = "# demo\n\n## Todo\n- a\n\n## WIP\n- b\n\n## Test\n- c\n\n## Done\n- d\n";
  const board = lanes([], ["a"], ["b"], ["c"], ["d"]);
  assert.deepEqual(parse(old), board);
  assert.equal(serialize("demo", parse(old)), serialize("demo", board));
});

test("boardName strips path separators and leading dots", () => {
  assert.equal(boardName("  my/board  "), "my-board");
  assert.equal(boardName("..hidden"), "hidden");
  assert.equal(boardName("   "), null);
});

test("addCard appends and selects the new card; blank text does nothing", () => {
  assert.deepEqual(addCard(lanes(["a"]), 0, " b "), { lanes: lanes(["a", "b"]), col: 0, row: 1 });
  assert.equal(addCard(lanes(), 0, "  "), null);
});

test("editCard replaces text, deletes on empty, and skips no-op edits", () => {
  assert.deepEqual(editCard(lanes(["a"]), 0, 0, "b").lanes, lanes(["b"]));
  assert.deepEqual(editCard(lanes(["a"]), 0, 0, "").lanes, lanes([]));
  assert.equal(editCard(lanes(["a"]), 0, 0, "a"), null);
});

test("removeCard keeps the cursor inside the lane", () => {
  assert.deepEqual(removeCard(lanes(["a", "b"]), 0, 1), { lanes: lanes(["a"]), col: 0, row: 0 });
  assert.equal(removeCard(lanes([]), 0, 0), null);
});

test("shiftCard moves to the end of the neighbouring column and stops at the edges", () => {
  assert.deepEqual(shiftCard(lanes(["a"], ["b"]), 0, 0, 1), { lanes: lanes([], ["b", "a"]), col: 1, row: 1 });
  assert.equal(shiftCard(lanes(["a"]), 0, 0, -1), null);
  assert.equal(shiftCard(lanes([], [], [], [], ["z"]), 4, 0, 1), null);
});

test("reorderCard swaps neighbours and stops at the ends", () => {
  assert.deepEqual(reorderCard(lanes(["a", "b"]), 0, 0, 1), { lanes: lanes(["b", "a"]), col: 0, row: 1 });
  assert.equal(reorderCard(lanes(["a", "b"]), 0, 0, -1), null);
});

test("edits never mutate the lanes they are given", () => {
  const before = lanes(["a", "b"], ["c"]);
  const copy = structuredClone(before);
  addCard(before, 0, "x");
  editCard(before, 0, 0, "y");
  removeCard(before, 0, 0);
  shiftCard(before, 0, 0, 1);
  reorderCard(before, 0, 0, 1);
  assert.deepEqual(before, copy);
});

test("cardLinks finds numbers and a branch in a card's text", () => {
  assert.deepEqual(cardLinks("Fix login #42"), { refs: [{ n: 42, kind: null, token: "#42" }], branch: null, branchToken: null });
  assert.deepEqual(cardLinks("UK NHS numbers issue #34 @feature/nhs").refs, [{ n: 34, kind: "issue", token: "issue #34" }]);
  assert.equal(cardLinks("UK NHS numbers issue #34 @feature/nhs").branch, "feature/nhs");
  assert.deepEqual(cardLinks("Whole view (#46, PR #47)").refs.map((r) => [r.n, r.kind]), [[46, null], [47, "pr"]]);
  assert.deepEqual(cardLinks("See https://github.com/o/r/issues/7 and https://github.com/o/r/pull/8/files").refs.map((r) => [r.n, r.kind]),
    [[7, "issue"], [8, "pr"]]);
  assert.equal(cardLinks("Issue#3 is not a link, nor is mail@x"), null);
});

test("withoutLinks drops the links at the end; withLink adds one", () => {
  assert.equal(withoutLinks("UK NHS numbers issue #34 @feature/nhs #51"), "UK NHS numbers");
  assert.equal(withoutLinks("whole document view (#46, PR #47)"), "whole document view (#46, PR #47)");
  assert.equal(withoutLinks("No link"), "No link");
  assert.equal(withLink("Pricing", "@feature/pricing"), "Pricing @feature/pricing");
  assert.equal(withLink("Pricing @old", "@feature/pricing"), "Pricing @feature/pricing");
  assert.equal(withLink("Pricing issue #3", "#9"), "Pricing issue #3 #9");
  assert.equal(withLink("Pricing #9", "#9"), "Pricing #9");
});

test("notes close the file, are kept as written, and never become cards", async () => {
  const { notesOf } = await import("../mods/kanban-md/board.js");
  const text = "# demo\n\n## Plan\n- A card\n\n## Notes\n\nWhy we split the API:\n\n## Decisions\n- not a card\n";
  assert.deepEqual(parse(text), lanes([], ["A card"]));
  assert.equal(notesOf(text), "Why we split the API:\n\n## Decisions\n- not a card");
  assert.equal(notesOf("# demo\n\n## Plan\n- x\n"), "");
  const written = serialize("demo", parse(text), notesOf(text));
  assert.equal(notesOf(written), notesOf(text));
  assert.deepEqual(parse(written), parse(text));
  assert.doesNotMatch(serialize("demo", parse(text), "  \n"), /## Notes/);
});

test("importIssues adds open issues to Ideas once", async () => {
  const { importIssues } = await import("../mods/kanban-md/board.js");
  const board = lanes(["Old idea"], ["UK NHS numbers #34"], [], [], ["Done thing issue #30"]);
  const { lanes: next, added } = importIssues(board, [
    { number: 34, title: "UK NHS numbers" }, { number: 37, title: "Page-pinned  facts\n" }, { number: 30, title: "Done thing" },
  ]);
  assert.deepEqual(added, ["Page-pinned facts issue #37"]);
  assert.deepEqual(next[0], ["Old idea", "Page-pinned facts issue #37"]);
  assert.deepEqual(next[1], board[1]);
  assert.deepEqual(importIssues(next, [{ number: 37, title: "x" }]).added, []);
});
