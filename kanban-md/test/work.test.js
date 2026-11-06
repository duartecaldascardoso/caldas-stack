import { test } from "node:test";
import assert from "node:assert/strict";
import { branchFor, worktreePath, cardBranch, agentsByBranch, finished } from "../mods/kanban-md/work.js";

test("branchFor makes a branch name from a card", () => {
  assert.equal(branchFor("Pricing page v2!"), "feature/pricing-page-v2");
  assert.equal(branchFor("Café menu — night"), "feature/cafe-menu-night");
  assert.equal(branchFor("!!!"), "feature/card");
  assert.ok(branchFor("a ".repeat(60)).length <= "feature/".length + 48);
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
    { pane: "p1", status: "working", address: "t1", tab_name: "pricing" },
    { pane: "p2", status: "blocked", address: "t2", tab_name: "pricing 2" },
    { pane: "p3", status: "idle", address: "t3", title: "main" },
    { pane: "p4", status: "working", address: "t4" },
  ];
  const panes = [{ pane: "p1", branch: "feature/pricing" }, { pane: "p2", branch: "feature/pricing" }, { pane: "p3", branch: "main" }, { pane: "p4", branch: null }];
  const by = agentsByBranch(agents, panes);
  assert.deepEqual(by.get("feature/pricing"), { status: "blocked", address: "t2", name: "pricing 2" });
  assert.equal(by.get("main").name, "main");
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
  assert.equal(cardHeight(1, false), 2 + 20 + 18 + 6);
  assert.equal(cardHeight(2, true), 2 + 20 + 36 + 8 + 22 + 6);
});
