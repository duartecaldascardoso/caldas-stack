import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localDay } from "../mods/kanban-md/board.js";

const BIN = fileURLToPath(new URL("../bin/kanban", import.meta.url));

function kanban(dir, ...args) {
  try {
    return { out: execFileSync(BIN, ["-b", "demo", ...args], { env: { ...process.env, KANBAN_DIR: dir } }).toString().trim(), code: 0 };
  } catch (e) {
    return { out: e.stderr.toString().trim(), code: e.status };
  }
}

const board = (dir) => readFileSync(join(dir, "demo.md"), "utf8");

test("kanban adds, moves, links and finishes cards in the board's format", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-"));
  assert.equal(kanban(dir, "add", "plan", "Pricing", "page").out, "added to plan: Pricing page");
  kanban(dir, "add", "ideas", "Dark mode");
  assert.equal(kanban(dir, "move", "pricing", "work").out, "moved to work: Pricing page");
  assert.equal(kanban(dir, "link", "Pricing page", "@feature/pricing").out, "linked: Pricing page @feature/pricing");
  assert.equal(kanban(dir, "ship", "2").out, "moved to ship: Pricing page @feature/pricing");
  assert.equal(board(dir), "# demo\n\n## Ideas\n- Dark mode\n\n## Plan\n\n## Work\n\n## Review\n\n## Ship\n- Pricing page @feature/pricing\n");
  assert.match(kanban(dir, "show").out, /Ship \(1\)\n {2}2\. Pricing page @feature\/pricing/);
});

test("kanban still takes the old column names", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-"));
  assert.equal(kanban(dir, "add", "todo", "Pricing").out, "added to plan: Pricing");
  assert.equal(kanban(dir, "move", "1", "test").out, "moved to review: Pricing");
  assert.equal(kanban(dir, "done", "1").out, "moved to ship: Pricing");
});

test("kanban refuses what it can't do clearly", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-"));
  writeFileSync(join(dir, "demo.md"), "# demo\n\n## Todo\n- Fix login\n- Fix logout\n");
  const ambiguous = kanban(dir, "done", "fix");
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.out, /matches 2 cards; use its number:\n {2}1\. Fix login\n {2}2\. Fix logout/);
  assert.match(kanban(dir, "add", "later", "x").out, /unknown column "later"/);
  assert.match(kanban(dir, "link", "1", "42").out, /link to "#<number>", "issue #<number>" or "@<branch>"/);
  assert.equal(kanban(dir, "link", "1", "issue", "#34").out, "linked: Fix login issue #34");
  assert.match(kanban(dir, "rm", "9").out, /no card 9; the board has 2/);
});

test("kanban picks the repository's board, from a worktree too", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-"));
  const repo = join(dir, "app");
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main", "app");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature/x", join(dir, "wt")], { cwd: repo });
  writeFileSync(join(dir, "app.md"), "# app\n\n## Todo\n- From the app board\n");
  const show = (cwd) => execFileSync(BIN, [], { cwd, env: { ...process.env, KANBAN_DIR: dir } }).toString();
  assert.match(show(repo), /# app/);
  assert.match(show(join(dir, "wt")), /From the app board/);
});

test("kanban records a branch's playbook and its steps beside the board", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-"));
  const repo = join(dir, "app");
  execFileSync("git", ["init", "-q", "-b", "fix/login", "app"], { cwd: dir });
  writeFileSync(join(dir, "app.md"), "# app\n\n## WIP\n- bug: login fails @fix/login\n");
  const run = (...args) => {
    try {
      return execFileSync(BIN, args, { cwd: repo, env: { ...process.env, KANBAN_DIR: dir } }).toString().trim();
    } catch (e) {
      return e.stderr.toString().trim();
    }
  };
  assert.match(run("run"), /no playbook on fix\/login yet/);
  assert.match(run("playbook", "bug"), /^Bug fix on fix\/login: 0\/6\n {2}● 1 reproduce/);
  run("step", "1", "done", "fails on main");
  const out = run("step", "2", "now");
  assert.match(out, /^Bug fix on fix\/login: 1\/6/);
  assert.match(out, /✓ 1 reproduce .*\(fails on main\)/);
  assert.match(out, /● 2 narrow/);
  assert.match(run("step", "7", "done"), /Bug fix has 6 steps/);
  assert.match(run("step", "1", "finished"), /a step is now, done, skipped/);
  assert.match(run("playbook", "hillclimb"), /unknown playbook "hillclimb"/);
  const saved = JSON.parse(readFileSync(join(dir, ".runs", "app.json"), "utf8"));
  assert.equal(saved["fix/login"].steps[2].status, "now");
});

test("kanban keeps a board's notes and adds to them", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-"));
  writeFileSync(join(dir, "demo.md"), "# demo\n\n## Plan\n- Fix login\n\n## Notes\n\nCustomers log in with SSO.\n");
  kanban(dir, "move", "1", "work");
  assert.match(board(dir), /## Work\n- Fix login\n[\s\S]*## Notes\n\nCustomers log in with SSO\.\n$/);
  assert.equal(kanban(dir, "note", "Ask", "about", "SAML").out, "noted on demo: Ask about SAML");
  assert.equal(kanban(dir, "notes").out, "Customers log in with SSO.\nAsk about SAML");
});

test("kanban import brings open issues into ideas once", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-"));
  const gh = join(dir, "gh");
  writeFileSync(gh, '#!/bin/sh\necho \'[{"number":34,"title":"UK NHS numbers"},{"number":37,"title":"Page-pinned facts"}]\'\n', { mode: 0o755 });
  writeFileSync(join(dir, "demo.md"), "# demo\n\n## Plan\n- UK NHS numbers #34\n");
  const run = () => execFileSync(BIN, ["-b", "demo", "import"], { env: { ...process.env, KANBAN_DIR: dir, KANBAN_GH: gh } }).toString().trim();
  assert.equal(run(), "added to ideas:\n  Page-pinned facts issue #37");
  assert.match(board(dir), /## Ideas\n- Page-pinned facts issue #37\n/);
  assert.equal(run(), "nothing new: 2 open issues, all on demo already");
});

test("kanban archives the shipped cards, or one card, by day", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-"));
  kanban(dir, "add", "ship", "Launch post");
  kanban(dir, "add", "ship", "Domain");
  kanban(dir, "add", "work", "Pricing");
  assert.equal(kanban(dir, "archive", "pricing").out, "archived:\n  Pricing");
  assert.equal(kanban(dir, "archive").out, "archived:\n  Launch post\n  Domain");
  assert.equal(board(dir), "# demo\n\n## Ideas\n\n## Plan\n\n## Work\n\n## Review\n\n## Ship\n");
  const day = localDay();
  assert.equal(readFileSync(join(dir, ".archive", "demo.md"), "utf8"), `# demo archive\n\n## ${day}\n- Pricing\n- Launch post\n- Domain\n`);
  assert.equal(kanban(dir, "archived").out, `${day}\n  Pricing\n  Launch post\n  Domain`);
  assert.equal(kanban(dir, "archive").out, "nothing shipped on demo to archive");
});
