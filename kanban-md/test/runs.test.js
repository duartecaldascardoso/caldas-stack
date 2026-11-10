import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRuns, recordPlaybook, recordStep, progress } from "../mods/kanban-md/runs.js";

test("parseRuns reads the runs file, and anything else as none", () => {
  assert.deepEqual(parseRuns('{"fix/x":{"playbook":"Bug fix","at":"t","steps":{}}}')["fix/x"].playbook, "Bug fix");
  assert.deepEqual(parseRuns(null), {});
  assert.deepEqual(parseRuns("[1]"), {});
  assert.deepEqual(parseRuns("not json"), {});
});

test("recordPlaybook keeps a run on the same playbook and starts over on another", () => {
  let runs = recordPlaybook({}, "fix/x", "Bug fix", "t1");
  runs = recordStep(runs, "fix/x", 1, "done", "", "t2");
  assert.equal(Object.keys(recordPlaybook(runs, "fix/x", "Bug fix", "t3")["fix/x"].steps).length, 1);
  assert.deepEqual(recordPlaybook(runs, "fix/x", "Babysit", "t3")["fix/x"], { playbook: "Babysit", at: "t3", steps: {} });
});

test("recordStep marks a step, and a new step in hand finishes the last one", () => {
  let runs = recordStep({}, "fix/x", 1, "now", "repro on main", "t1");
  assert.deepEqual(runs["fix/x"].steps[1], { status: "now", note: "repro on main", at: "t1" });
  runs = recordStep(runs, "fix/x", 2, "now", "", "t2");
  assert.equal(runs["fix/x"].steps[1].status, "done");
  assert.equal(runs["fix/x"].steps[2].note, null);
});

test("progress counts finished steps and finds the one in hand", () => {
  assert.deepEqual(progress(null, 6), { done: 0, current: 1 });
  let runs = recordStep({}, "b", 1, "done", "", "t");
  runs = recordStep(runs, "b", 2, "skipped", "no repro needed", "t");
  assert.deepEqual(progress(runs.b, 6), { done: 2, current: 3 });
  runs = recordStep(runs, "b", 5, "now", "", "t");
  assert.deepEqual(progress(runs.b, 6), { done: 2, current: 5 });
  for (const n of [3, 4, 5, 6]) runs = recordStep(runs, "b", n, "done", "", "t");
  assert.deepEqual(progress(runs.b, 6), { done: 6, current: null });
});

test("stationOf places a card on the loop", async () => {
  const { stationOf, LOOP } = await import("../mods/kanban-md/runs.js");
  assert.equal(LOOP.length, 6);
  assert.equal(LOOP[stationOf(0)].name, "Plan");
  assert.equal(LOOP[stationOf(2)].name, "Start");
  assert.equal(LOOP[stationOf(2, { working: true })].name, "Work");
  assert.equal(LOOP[stationOf(3)].name, "Review");
  assert.equal(LOOP[stationOf(3, { playbook: "Babysit" })].name, "Babysit");
  assert.equal(LOOP[stationOf(4)].name, "Ship");
});

test("lastMessage finds the agent's last words, not its helpers' or its tool calls", async () => {
  const { lastMessage } = await import("../mods/kanban-md/runs.js");
  const lines = [
    { type: "assistant", timestamp: "t1", message: { content: [{ type: "text", text: "Reproduced it." }] } },
    { type: "assistant", timestamp: "t2", isSidechain: true, message: { content: [{ type: "text", text: "helper" }] } },
    { type: "assistant", timestamp: "t3", message: { content: [{ type: "tool_use", name: "Bash" }] } },
    { type: "user", timestamp: "t4", message: { content: "ok" } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\nnot json";
  assert.deepEqual(lastMessage(lines), { text: "Reproduced it.", at: "t1" });
  assert.equal(lastMessage(""), null);
});

test("ago says how long since", async () => {
  const { ago } = await import("../mods/kanban-md/runs.js");
  const now = Date.parse("2026-11-10T12:00:00Z");
  assert.equal(ago("2026-11-10T11:59:40Z", now), "just now");
  assert.equal(ago("2026-11-10T11:46:00Z", now), "14 min");
  assert.equal(ago("2026-11-10T09:00:00Z", now), "3 h");
  assert.equal(ago("2026-11-07T12:00:00Z", now), "3 d");
  assert.equal(ago(null, now), null);
});

test("summarize turns an agent's markdown into a lead, points and its question", async () => {
  const { summarize } = await import("../mods/kanban-md/runs.js");
  const text = [
    "The **inspector** is built and in `#5`.",
    "",
    "## What changed",
    "- **Loop:** a track of stations",
    "- Steps as a timeline,",
    "  with notes under them",
    "- A bar",
    "",
    "```sh",
    "npm test",
    "```",
    "| a | b |",
    "",
    "1. Press `?`",
    "2. Press `i`",
    "",
    "Should I merge #3 first?",
  ].join("\n");
  assert.deepEqual(summarize(text), {
    lead: "The inspector is built and in #5.",
    points: ["Loop: a track of stations", "Steps as a timeline, with notes under them", "A bar", "Press ?"],
    more: 2,
    question: "Should I merge #3 first?",
  });
  assert.deepEqual(summarize(""), { lead: null, points: [], more: 0, question: null });
  assert.ok(summarize("x".repeat(500)).lead.length <= 240);
});
