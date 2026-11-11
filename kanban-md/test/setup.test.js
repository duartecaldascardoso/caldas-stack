import { test } from "node:test";
import assert from "node:assert/strict";
import { frontmatter, entryOf, commandName, instructionsOf, firstLine, settingsOf, hooksOf, serversOf, pluginsOf, localChanges, overlaps, setupSummary, definitionsIn, splitHeads } from "../mods/kanban-md/setup.js";

test("frontmatter reads plain, quoted and block fields", () => {
  const text = "---\nname: shadcn\ndescription: >\n  Manages shadcn components\n  and projects.\nuser-invocable: false\ntitle: \"Quoted: yes\"\n---\n# Body";
  assert.deepEqual(frontmatter(text), { name: "shadcn", description: "Manages shadcn components and projects.", "user-invocable": "false", title: "Quoted: yes" });
  assert.deepEqual(frontmatter("# No frontmatter"), {});
});

test("entryOf names skills after their folder and the rest after their file when they don't say", () => {
  assert.deepEqual(entryOf("/r/.claude/skills/deploy/SKILL.md", "---\ndescription: Ships it\n---\n", "skill"), { name: "deploy", description: "Ships it", path: "/r/.claude/skills/deploy/SKILL.md" });
  assert.equal(entryOf("/p/agents/modus-code-reviewer.agent.md", "Reviews code.", "agent").name, "modus-code-reviewer");
  assert.equal(entryOf("/p/agents/x.md", "---\nname: reviewer\n---\n# Reviews\n", "agent").description, "Reviews");
  assert.equal(commandName("git/commit.md"), "/git:commit");
});

test("instructionsOf and firstLine skip frontmatter, fences and heading marks", () => {
  assert.equal(firstLine("---\na: b\n---\n\n# Kanban **boards**\nMore"), "Kanban boards");
  assert.deepEqual(instructionsOf("/r/CLAUDE.md", "# Rules\n\n- one\n- two\n"), { name: "CLAUDE.md", description: "Rules", lines: 3, path: "/r/CLAUDE.md" });
});

test("settingsOf describes a settings file by what it sets", () => {
  assert.deepEqual(settingsOf('{"enabledMcpjsonServers":["shadcn"],"enableAllProjectMcpServers":true}', "/r/.claude/settings.local.json"),
    { name: "settings.local.json", description: "enabledMcpjsonServers, enableAllProjectMcpServers", path: "/r/.claude/settings.local.json" });
  assert.equal(settingsOf(null, "/r/s.json"), null);
});

test("hooksOf lists one hook per command, named by event and matcher", () => {
  const settings = JSON.stringify({ hooks: {
    SessionStart: [{ matcher: "^(startup|resume)$", hooks: [{ type: "command", command: "bash state.sh session" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }, { type: "prompt", prompt: "Is this safe?" }] }],
    Stop: [{ hooks: [{ type: "command", command: "notify.sh" }] }],
  } });
  assert.deepEqual(hooksOf(settings, "s.json").map((h) => [h.name, h.description]), [
    ["SessionStart ^(startup|resume)$", "bash state.sh session"], ["PreToolUse Bash", "guard.sh"], ["PreToolUse Bash", "Is this safe?"], ["Stop", "notify.sh"],
  ]);
  assert.deepEqual(hooksOf("not json", "s.json"), []);
  assert.deepEqual(hooksOf(JSON.stringify({ model: "x" }), "s.json"), []);
});

test("serversOf describes how each MCP server runs", () => {
  const config = { mcpServers: { shadcn: { command: "npx", args: ["shadcn@latest", "mcp"] }, docs: { type: "http", url: "https://docs.example/mcp" } } };
  assert.deepEqual(serversOf(config, ".mcp.json").map((s) => [s.name, s.description]), [["shadcn", "npx shadcn@latest mcp"], ["docs", "https://docs.example/mcp"]]);
  assert.deepEqual(serversOf(null, ".mcp.json"), []);
});

test("pluginsOf reads installed plugins and whether they're enabled", () => {
  const installed = JSON.stringify({ version: 2, plugins: { "pstack@cursor-plugins": [{ installPath: "/c/pstack/1.0", version: "1.0" }], "typesafe@typesafe-ai": [{ installPath: "/c/t", version: "0.5.7" }] } });
  const settings = JSON.stringify({ enabledPlugins: { "typesafe@typesafe-ai": false } });
  assert.deepEqual(pluginsOf(installed, settings), [
    { id: "pstack@cursor-plugins", name: "pstack", version: "1.0", enabled: true, root: "/c/pstack/1.0" },
    { id: "typesafe@typesafe-ai", name: "typesafe", version: "0.5.7", enabled: false, root: "/c/t" },
  ]);
  assert.deepEqual(pluginsOf(null, null), []);
});

test("localChanges says which files a worktree won't have, and why", () => {
  const changes = localChanges("?? .claude/skills/new/SKILL.md\n!! .claude/settings.local.json\n M CLAUDE.md\nR  old.md -> .claude/agents/a.md\n");
  assert.deepEqual([...changes], [[".claude/skills/new/SKILL.md", "not committed"], [".claude/settings.local.json", "ignored"], ["CLAUDE.md", "changed"], [".claude/agents/a.md", "changed"]]);
});

test("definitionsIn sorts a folder's markdown into skills, commands and subagents", () => {
  const found = definitionsIn("/p", [
    "/p/skills/deploy/SKILL.md", "/p/skills/deploy/reference.md", "/p/skills/synced/x/y/SKILL.md",
    "/p/commands/review.md", "/p/commands/git/commit.md", "/p/agents/reviewer.md", "/p/agents/notes/extra.md", "/other/skills/a/SKILL.md",
  ]);
  assert.deepEqual(found, {
    skills: ["/p/skills/deploy/SKILL.md", "/p/skills/synced/x/y/SKILL.md"],
    commands: [{ path: "/p/commands/review.md", name: "/review" }, { path: "/p/commands/git/commit.md", name: "/git:commit" }],
    agents: ["/p/agents/reviewer.md"],
  });
});

test("splitHeads splits head's output back into each file", () => {
  const out = "==> /a/SKILL.md <==\n---\nname: a\n---\n\n==> /b/SKILL.md <==\n# B\nbody";
  assert.deepEqual([...splitHeads(out, ["/a/SKILL.md", "/b/SKILL.md"])], [["/a/SKILL.md", "---\nname: a\n---\n"], ["/b/SKILL.md", "# B\nbody"]]);
  assert.deepEqual([...splitHeads("# Only", ["/c.md"])], [["/c.md", "# Only"]]);
});

test("setupSummary counts what a project adds, and what worktrees miss", () => {
  const project = { instructions: [], settings: [{ local: "ignored" }], skills: [{}, {}], commands: [], agents: [], hooks: [{}], servers: [{ local: "yours only" }] };
  assert.equal(setupSummary(project), "2 skills, 1 hook, 1 MCP server, 1 settings file · 1 not in worktrees");
  assert.equal(setupSummary({ skills: [], hooks: [] }), null);
  assert.equal(setupSummary(null), null);
});

test("overlaps finds names defined for the project and everywhere", () => {
  const found = overlaps({ skills: [{ name: "deploy" }, { name: "shadcn" }] }, { skills: [{ name: "deploy" }], commands: [] });
  assert.deepEqual([...found.skills], ["deploy"]);
  assert.deepEqual([...found.commands], []);
});
