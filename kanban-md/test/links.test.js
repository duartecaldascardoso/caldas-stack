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

test("failed checks become a message for the agent", async () => {
  const { failedChecks, ciPrompt } = await import("../mods/kanban-md/links.js");
  const failed = failedChecks([
    { name: "test", bucket: "fail", link: "https://github.com/o/r/actions/runs/123/job/9" },
    { name: "lint", bucket: "pass", link: "https://github.com/o/r/actions/runs/123/job/8" },
    { name: "vercel", bucket: "fail", link: "https://vercel.com/x" },
  ]);
  assert.deepEqual(failed, [{ name: "test", runId: "123" }]);
  const t = (msg) => `test\tUNKNOWN STEP\t2026-11-11T10:00:00.1234567Z ${msg}`;
  const log = [t("##[group]Run npm ci"), t("added 200 packages"), t("##[endgroup]"), t("##[group]Run npm test"),
    t("\u001b[36;1mnpm test\u001b[0m"), t("not ok 2 - adds"), t("##[error]Process completed with exit code 1."),
    t("Post job cleanup."), t("git config --unset-all")].join("\n");
  const prompt = ciPrompt(47, failed, log);
  assert.match(prompt, /^CI is failing on pull request #47 \(test\)\./);
  assert.match(prompt, /```\n##\[group\]Run npm test\nnpm test\nnot ok 2 - adds\n##\[error\]Process completed with exit code 1\.\n```/);
  assert.doesNotMatch(prompt, /cleanup|npm ci/);
  const long = ["##[group]Run make", ...Array.from({ length: 300 }, (_, i) => `line ${i}`), "##[error]boom"].join("\n");
  const lines = ciPrompt(1, failed, long).split("\n");
  assert.ok(lines.includes("##[group]Run make") && lines.includes("##[error]boom") && lines.some((l) => /^… \d+ lines …$/.test(l)));
});
