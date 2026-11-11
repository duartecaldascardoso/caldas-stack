// Claude Code's files for a project and for everywhere, read from disk into what setup.js
// makes of them: { project, everywhere }, each { instructions, settings, skills, commands,
// agents, hooks, servers }, everywhere with plugins too. Each item is { name, description, path }, with
// `from` (a plugin's name) or `local` (why agents started from cards won't have it).
import * as fs from "fs/promises";
import { exec, home } from "herdr";
import { entryOf, commandName, instructionsOf, settingsOf, hooksOf, serversOf, pluginsOf, localChanges } from "./setup.js";

const read = (path) => fs.readFile(path, "utf8").catch(() => null);
const json = (text) => { try { return JSON.parse(text ?? ""); } catch { return null; } };

// Every file under dir whose name passes `keep`, as paths relative to dir, a few levels deep.
async function filesUnder(dir, keep, depth = 4) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const entry of entries) {
    if (entry.isDirectory() && depth > 0) out.push(...(await filesUnder(`${dir}/${entry.name}`, keep, depth - 1)).map((f) => `${entry.name}/${f}`));
    else if (entry.isFile() && keep(entry.name)) out.push(entry.name);
  }
  return out.sort();
}

// Skills, commands and subagents kept under a .claude-like folder (or a plugin's root).
async function definedIn(dir) {
  const load = (kind, sub, keep, name) => filesUnder(`${dir}/${sub}`, keep).then((files) => Promise.all(files.map(async (f) => {
    const entry = entryOf(`${dir}/${sub}/${f}`, await read(`${dir}/${sub}/${f}`), kind);
    return name ? { ...entry, name: name(f) } : entry;
  })));
  const [skills, commands, agents] = await Promise.all([
    load("skill", "skills", (n) => n === "SKILL.md"),
    load("command", "commands", (n) => n.endsWith(".md"), commandName),
    load("agent", "agents", (n) => n.endsWith(".md")),
  ]);
  return { skills, commands, agents };
}

async function instructions(paths) {
  const found = await Promise.all(paths.map(async (path) => ({ path, text: await read(path) })));
  return found.filter((f) => f.text !== null).map((f) => instructionsOf(f.path, f.text));
}

export async function projectSetup(root) {
  const claude = `${root}/.claude`;
  const [defined, notes, shared, local, mcp, userConfig, status] = await Promise.all([
    definedIn(claude),
    instructions([`${root}/CLAUDE.md`, `${root}/AGENTS.md`, `${claude}/CLAUDE.md`, `${root}/CLAUDE.local.md`]),
    read(`${claude}/settings.json`),
    read(`${claude}/settings.local.json`),
    read(`${root}/.mcp.json`),
    read(`${home()}/.claude.json`),
    exec("git", ["-C", root, "status", "--porcelain", "--ignored", "--untracked-files=all", "--", ".claude", "CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", ".mcp.json"]).catch(() => null),
  ]);
  // MCP servers added with `claude mcp add` (local scope) live in ~/.claude.json, by project.
  const privateServers = serversOf(json(userConfig)?.projects?.[root], `${home()}/.claude.json`).map((s) => ({ ...s, local: "yours only" }));
  const setup = {
    instructions: notes,
    settings: [settingsOf(shared, `${claude}/settings.json`), settingsOf(local, `${claude}/settings.local.json`)].filter(Boolean),
    ...defined,
    hooks: [...hooksOf(shared, `${claude}/settings.json`), ...hooksOf(local, `${claude}/settings.local.json`)],
    servers: [...serversOf(json(mcp), `${root}/.mcp.json`), ...privateServers],
  };
  // What a worktree won't have: anything git doesn't hold as committed.
  const changes = localChanges(status?.code === 0 ? status.stdout : "");
  const stateOf = (path) => {
    const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
    if (relative === null) return null;
    for (const [changed, state] of changes) if (changed === relative || (changed.endsWith("/") && relative.startsWith(changed))) return state;
    return null;
  };
  for (const items of Object.values(setup)) for (const item of items) item.local ??= stateOf(item.path);
  return setup;
}

export async function everywhereSetup() {
  const claude = `${home()}/.claude`;
  const [defined, notes, settings, installed, userConfig] = await Promise.all([
    definedIn(claude),
    instructions([`${claude}/CLAUDE.md`]),
    read(`${claude}/settings.json`),
    read(`${claude}/plugins/installed_plugins.json`),
    read(`${home()}/.claude.json`),
  ]);
  const plugins = pluginsOf(installed, settings);
  // An enabled plugin brings its skills, commands, subagents and hooks.
  const brought = await Promise.all(plugins.filter((p) => p.enabled && p.root).map(async (p) => {
    const [own, hooks] = await Promise.all([definedIn(p.root), read(`${p.root}/hooks/hooks.json`)]);
    const from = (items) => items.map((item) => ({ ...item, from: p.name }));
    return { skills: from(own.skills), commands: from(own.commands), agents: from(own.agents), hooks: from(hooksOf(hooks, `${p.root}/hooks/hooks.json`)) };
  }));
  const all = (kind) => [...defined[kind] ?? [], ...brought.flatMap((b) => b[kind])];
  return {
    instructions: notes,
    settings: [settingsOf(settings, `${claude}/settings.json`)].filter(Boolean),
    skills: all("skills"),
    commands: all("commands"),
    agents: all("agents"),
    hooks: [...hooksOf(settings, `${claude}/settings.json`), ...brought.flatMap((b) => b.hooks)],
    servers: serversOf(json(userConfig), `${home()}/.claude.json`),
    plugins: plugins.map((p) => ({ name: p.name, description: `${p.version}${p.enabled ? "" : " · disabled"}`, path: p.root ? `${p.root}` : null })),
  };
}
