import { test } from "node:test";
import assert from "node:assert/strict";
import { prStatus, issueStatus, columnFor, describe, numberFromUrl } from "../mods/kanban-md/links.js";

test("prStatus reads state, checks and review from gh", () => {
  assert.deepEqual(prStatus({ state: "OPEN", isDraft: false, reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }, { state: "SUCCESS" }] }),
    { kind: "pr", state: "open", checks: "passing", review: "approved", branch: null, conflicts: false });
  assert.deepEqual(prStatus({ state: "OPEN", isDraft: true, reviewDecision: "", statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }] }),
    { kind: "pr", state: "draft", checks: "pending", review: null, branch: null, conflicts: false });
  assert.deepEqual(prStatus({ state: "MERGED", statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }], reviewDecision: "CHANGES_REQUESTED" }),
    { kind: "pr", state: "merged", checks: "failing", review: "changes", branch: null, conflicts: false });
  assert.equal(prStatus({ state: "OPEN", headRefName: "feature/x" }).branch, "feature/x");
  assert.equal(prStatus({ state: "OPEN", mergeable: "CONFLICTING" }).conflicts, true);
  assert.equal(prStatus({ state: "CLOSED", statusCheckRollup: [] }).checks, null);
});

test("columnFor ships merged cards and moves open ones to review", () => {
  const open = { state: "open" };
  assert.equal(columnFor({ state: "merged" }, 2), 4);
  assert.equal(columnFor({ state: "merged" }, 4), null);
  assert.equal(columnFor(open, 1), 3);
  assert.equal(columnFor(open, 3), null);
  assert.equal(columnFor(open, 4), null); // shipped by hand stays shipped
  assert.equal(columnFor({ state: "draft" }, 2), null);
  assert.equal(columnFor({ state: "closed" }, 2), null);
});

test("describe and numberFromUrl", () => {
  assert.equal(describe(42, { state: "open", checks: "passing", review: "approved" }), "#42 open · checks passing · approved");
  assert.equal(describe(7, { state: "draft", checks: null, review: null }), "#7 draft");
  assert.equal(describe(8, { state: "open", conflicts: true, checks: "failing", review: null }), "#8 open · conflicts · checks failing");
  assert.equal(numberFromUrl("https://github.com/o/r/pull/12\n"), 12);
  assert.equal(numberFromUrl("nothing"), null);
});

test("issues: their state, and done once completed", () => {
  const open = issueStatus({ state: "OPEN", url: "u" });
  const done = issueStatus({ state: "CLOSED", stateReason: "COMPLETED" });
  const dropped = issueStatus({ state: "CLOSED", stateReason: "NOT_PLANNED" });
  assert.deepEqual(open, { kind: "issue", state: "open", completed: false, url: "u" });
  assert.equal(columnFor(open, 1), null);
  assert.equal(columnFor(done, 1), 4);
  assert.equal(columnFor(done, 4), null);
  assert.equal(columnFor(dropped, 1), null);
  assert.equal(describe(34, open), "issue #34 open");
  assert.equal(describe(34, dropped), "issue #34 closed, not planned");
});
