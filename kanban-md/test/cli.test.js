import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  assert.equal(kanban(dir, "add", "todo", "Pricing", "page").out, "added to todo: Pricing page");
  kanban(dir, "add", "ideas", "Dark mode");
  assert.equal(kanban(dir, "move", "pricing", "wip").out, "moved to wip: Pricing page");
  assert.equal(kanban(dir, "link", "Pricing page", "@feature/pricing").out, "linked: Pricing page @feature/pricing");
  assert.equal(kanban(dir, "done", "2").out, "moved to done: Pricing page @feature/pricing");
  assert.equal(board(dir), "# demo\n\n## Ideas\n- Dark mode\n\n## Todo\n\n## WIP\n\n## Test\n\n## Done\n- Pricing page @feature/pricing\n");
  assert.match(kanban(dir, "show").out, /Done \(1\)\n {2}2\. Pricing page @feature\/pricing/);
});

test("kanban refuses what it can't do clearly", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-"));
  writeFileSync(join(dir, "demo.md"), "# demo\n\n## Todo\n- Fix login\n- Fix logout\n");
  const ambiguous = kanban(dir, "done", "fix");
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.out, /matches 2 cards; use its number:\n {2}1\. Fix login\n {2}2\. Fix logout/);
  assert.match(kanban(dir, "add", "later", "x").out, /unknown column "later"/);
  assert.match(kanban(dir, "link", "1", "42").out, /link to "#<number>" or "@<branch>"/);
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
