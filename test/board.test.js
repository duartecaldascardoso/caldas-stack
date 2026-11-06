import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLUMNS, emptyLanes, parse, serialize, boardName,
  addCard, editCard, removeCard, shiftCard, reorderCard,
} from "../mods/kanban-md/board.js";

const lanes = (...cards) => COLUMNS.map((_, i) => cards[i] ?? []);

test("parse reads cards under each column heading", () => {
  const text = "# demo\n\n## Ideas\n- one\n- two\n\n## wip\n* three\n";
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
  assert.equal(text, "# demo\n\n## Ideas\n- a\n\n## Todo\n\n## WIP\n- b\n- c\n\n## Test\n\n## Done\n");
  assert.deepEqual(parse(text), board);
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
