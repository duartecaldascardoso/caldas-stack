import { test } from "node:test";
import assert from "node:assert/strict";
import { prStatus, columnFor, describe, numberFromUrl } from "../mods/kanban-md/links.js";

test("prStatus reads state, checks and review from gh", () => {
  assert.deepEqual(prStatus({ state: "OPEN", isDraft: false, reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }, { state: "SUCCESS" }] }),
    { state: "open", checks: "passing", review: "approved", branch: null });
  assert.deepEqual(prStatus({ state: "OPEN", isDraft: true, reviewDecision: "", statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }] }),
    { state: "draft", checks: "pending", review: null, branch: null });
  assert.deepEqual(prStatus({ state: "MERGED", statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }], reviewDecision: "CHANGES_REQUESTED" }),
    { state: "merged", checks: "failing", review: "changes", branch: null });
  assert.equal(prStatus({ state: "OPEN", headRefName: "feature/x" }).branch, "feature/x");
  assert.equal(prStatus({ state: "CLOSED", statusCheckRollup: [] }).checks, null);
});

test("columnFor moves merged cards to done and open ones to test", () => {
  const open = { state: "open" };
  assert.equal(columnFor({ state: "merged" }, 2), 4);
  assert.equal(columnFor({ state: "merged" }, 4), null);
  assert.equal(columnFor(open, 1), 3);
  assert.equal(columnFor(open, 3), null);
  assert.equal(columnFor(open, 4), null); // done by hand stays done
  assert.equal(columnFor({ state: "draft" }, 2), null);
  assert.equal(columnFor({ state: "closed" }, 2), null);
});

test("describe and numberFromUrl", () => {
  assert.equal(describe(42, { state: "open", checks: "passing", review: "approved" }), "#42 open · checks passing · approved");
  assert.equal(describe(7, { state: "draft", checks: null, review: null }), "#7 draft");
  assert.equal(numberFromUrl("https://github.com/o/r/pull/12\n"), 12);
  assert.equal(numberFromUrl("nothing"), null);
});
