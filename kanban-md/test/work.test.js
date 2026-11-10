import { test } from "node:test";
import assert from "node:assert/strict";
import { branchFor, worktreePath, cardBranch, agentsByBranch, finished, playbookOf, taskFor, hasPstack, babysitFor, babysitTask } from "../mods/kanban-md/work.js";

test("branchFor makes a branch name from a card", () => {
  assert.equal(branchFor("Pricing page v2!"), "feature/pricing-page-v2");
  assert.equal(branchFor("Café menu — night"), "feature/cafe-menu-night");
  assert.equal(branchFor("!!!"), "feature/card");
  assert.ok(branchFor("a ".repeat(60)).length <= "feature/".length + 48);
});

test("branchFor puts a playbook's work on its own branch prefix", () => {
  assert.equal(branchFor("Bug: login fails"), "fix/login-fails");
  assert.equal(branchFor("perf: slow board"), "perf/slow-board");
  assert.equal(branchFor("Spike: drag cards"), "spike/drag-cards");
  assert.equal(branchFor("Note: not a playbook"), "feature/note-not-a-playbook");
});

test("playbookOf reads a playbook prefix, and leaves other text alone", () => {
  assert.deepEqual(playbookOf("Bug: login fails"), { playbook: "Bug fix", branch: "fix", title: "login fails" });
  assert.deepEqual(playbookOf("REFACTOR : split main.js"), { playbook: "Refactoring", branch: "refactor", title: "split main.js" });
  assert.deepEqual(playbookOf("Ship it: launch post"), { playbook: null, branch: "feature", title: "Ship it: launch post" });
  assert.deepEqual(playbookOf("bug:"), { playbook: null, branch: "feature", title: "bug:" });
  assert.equal(playbookOf("Investigate: why sync drops cards").playbook, "Investigation");
});

test("taskFor runs the card through poteto-mode only with pstack", () => {
  assert.equal(taskFor("Bug: login fails", 12, false), "login fails (GitHub issue #12)");
  assert.equal(taskFor("Bug: login fails", 12, true), "/pstack:poteto-mode Bug fix playbook. login fails (GitHub issue #12)");
  assert.equal(taskFor("Pricing page", null, true), "/pstack:poteto-mode Pricing page");
});

test("babysitFor drives a blocked pull request and checks on the rest", () => {
  assert.deepEqual(babysitFor(4, { kind: "pr", state: "open", checks: "failing", review: "changes", conflicts: true }),
    { number: 4, mode: "drive", blockers: ["conflicts", "changes requested", "checks failing"] });
  assert.deepEqual(babysitFor(5, { kind: "pr", state: "draft", checks: "passing", review: null }), { number: 5, mode: "check", blockers: [] });
  assert.equal(babysitFor(6, { kind: "pr", state: "merged" }), null);
  assert.equal(babysitFor(7, { kind: "issue", state: "open" }), null);
  assert.equal(babysitFor(8, null), null);
});

test("babysitTask runs the Babysit playbook with pstack, and spells out its rules without", () => {
  const drive = { number: 4, mode: "drive", blockers: ["checks failing"] };
  assert.equal(babysitTask(drive, "Bug: login fails", true), "/pstack:poteto-mode Babysit playbook, drive mode. Pull request #4 (checks failing): login fails");
  assert.match(babysitTask(drive, "Bug: login fails", false), /^Get pull request #4 merge-ready \(checks failing\): login fails\. .*don't merge\.$/);
  assert.match(babysitTask({ number: 5, mode: "check", blockers: [] }, "Pricing", false), /^Check on pull request #5: Pricing\. .*Change nothing\.$/);
});

test("hasPstack finds pstack among Claude Code's installed plugins", () => {
  assert.equal(hasPstack(JSON.stringify({ version: 2, plugins: { "pstack@cursor-plugins": [{}] } })), true);
  assert.equal(hasPstack(JSON.stringify({ "pstack@pstack-claude": [{}] })), true);
  assert.equal(hasPstack(JSON.stringify({ version: 2, plugins: { "typesafe@typesafe-ai": [{}] } })), false);
  assert.equal(hasPstack(null), false);
  assert.equal(hasPstack("not json"), false);
});

test("worktreePath follows Herdr's worktree layout", () => {
  assert.equal(worktreePath("/Users/me", "/Users/me/code/app", "feature/pricing"), "/Users/me/.herdr/worktrees/app/feature-pricing");
});

test("cardBranch prefers the card's own branch, then its pull request's", () => {
  assert.equal(cardBranch({ branch: "fix/x" }, { branch: "other" }), "fix/x");
  assert.equal(cardBranch({ pr: 4 }, { branch: "feature/y" }), "feature/y");
  assert.equal(cardBranch(null, null), null);
});

test("agentsByBranch joins agents to their pane's branch, most urgent first", () => {
  const agents = [
    { pane: "p1", status: "working", address: "t1", program: { name: "Codex" } },
    { pane: "p2", status: "blocked", address: "t2", program: { name: "Claude Code" } },
    { pane: "p3", status: "idle", address: "t3", app: "pi" },
    { pane: "p4", status: "working", address: "t4" },
  ];
  const panes = [{ pane: "p1", branch: "feature/pricing" }, { pane: "p2", branch: "feature/pricing" }, { pane: "p3", branch: "main" }, { pane: "p4", branch: null }];
  const by = agentsByBranch(agents, panes);
  assert.deepEqual(by.get("feature/pricing"), { status: "blocked", address: "t2", name: "Claude Code" });
  assert.equal(by.get("main").name, "pi");
  assert.equal(by.size, 2);
});

test("finished lists branches whose agent went from working to done or idle", () => {
  const before = new Map([["a", { status: "working" }], ["b", { status: "working" }], ["c", { status: "idle" }]]);
  const now = new Map([["a", { status: "done" }], ["b", { status: "working" }], ["c", { status: "done" }]]);
  assert.deepEqual(finished(before, now), ["a"]);
});

test("checkoutOf finds the worktree already on a branch", async () => {
  const { checkoutOf } = await import("../mods/kanban-md/work.js");
  const porcelain = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt/feature-x\nHEAD def\nbranch refs/heads/feature/x\n";
  assert.equal(checkoutOf(porcelain, "feature/x"), "/wt/feature-x");
  assert.equal(checkoutOf(porcelain, "main"), "/repo");
  assert.equal(checkoutOf(porcelain, "feature"), null);
});

test("wrapText breaks at spaces, and inside a word only when it must", async () => {
  const { wrapText, cardHeight } = await import("../mods/kanban-md/cards.js");
  assert.deepEqual(wrapText("Viewer memory on huge reports", 14), ["Viewer memory", "on huge", "reports"]);
  assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrapText("short", 20), ["short"]);
  assert.equal(cardHeight(1), 2 + 20 + 18 + 6);
  assert.equal(cardHeight(2, 1), 2 + 20 + 36 + 8 + 22 + 6);
  assert.equal(cardHeight(1, 2), 2 + 20 + 18 + 8 + 44 + 4 + 6);
});

test("chipRows wraps chips that don't fit", async () => {
  const { chipRows } = await import("../mods/kanban-md/cards.js");
  assert.equal(chipRows([], 200), 0);
  assert.equal(chipRows([80, 80], 200), 1);
  assert.equal(chipRows([80, 80, 80], 200), 2);
  assert.equal(chipRows([300], 200), 1); // a chip wider than the card still takes one row
});
