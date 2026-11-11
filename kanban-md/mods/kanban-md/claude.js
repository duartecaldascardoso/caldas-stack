// Claude Code's files for a project and for everywhere, read from disk into what setup.js
// makes of them: { project, everywhere }, each { instructions, settings, skills, commands,
// agents, hooks, servers }, everywhere with plugins too. Each item is { name, description, path },
// with `from` (a plugin's name) or `local` (why agents started from cards won't have it).
//
// Every file call a mod makes goes through the app, so files are found with one `find` and read
// with one `head` rather than one call each.
import { exec, home, readTextFile } from "herdr";
import { entryOf, definitionsIn, splitHeads, instructionsOf, settingsOf, hooksOf, serversOf, pluginsOf, localChanges } from "./setup.js";

const read = (path) => readTextFile(path).catch(() => null);
const json = (text) => { try { return JSON.parse(text ?? ""); } catch { return null; } };

// Skills, commands and subagents kept under each of `roots` (.claude folders and plugins), as
// [{ skills, commands, agents }] in the same order. The first 4 KB of a file hold its frontmatter.
async function definedIn(roots) {
  const dirs = roots.flatMap((root) => ["skills", "commands", "agents"].map((sub) => `${root}/${sub}`));
  // find exits non-zero over folders that don't exist; what it found still counts.
  const found = await exec("find", [...dirs, "-maxdepth", "5", "-type", "f", "-name", "*.md"]).catch(() => null);
  const paths = (found?.stdout ?? "").split("\n").filter(Boolean).sort();
  const byRoot = roots.map((root) => definitionsIn(root, paths));
  const wanted = byRoot.flatMap((d) => [...d.skills, ...d.commands.map((c) => c.path), ...d.agents]);
  const heads = wanted.length ? splitHeads((await exec("head", ["-c", "4096", ...wanted]).catch(() => null))?.stdout ?? "", wanted) : new Map();
  return byRoot.map((d) => ({
    skills: d.skills.map((path) => entryOf(path, heads.get(path), "skill")),
    commands: d.commands.map(({ path, name }) => ({ ...entryOf(path, heads.get(path), "command"), name })),
    agents: d.agents.map((path) => entryOf(path, heads.get(path), "agent")),
  }));
}

async function instructions(paths) {
  const found = await Promise.all(paths.map(async (path) => ({ path, text: await read(path) })));
  return found.filter((f) => f.text !== null).map((f) => instructionsOf(f.path, f.text));
}

export async function projectSetup(root) {
  const claude = `${root}/.claude`;
  const [[defined], notes, shared, local, mcp, userConfig, status] = await Promise.all([
    definedIn([claude]),
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
  const [notes, settings, installed, userConfig] = await Promise.all([
    instructions([`${claude}/CLAUDE.md`]),
    read(`${claude}/settings.json`),
    read(`${claude}/plugins/installed_plugins.json`),
    read(`${home()}/.claude.json`),
  ]);
  const plugins = pluginsOf(installed, settings);
  // An enabled plugin brings its skills, commands, subagents and hooks.
  const enabled = plugins.filter((p) => p.enabled && p.root);
  const [[defined, ...own], hookFiles] = await Promise.all([
    definedIn([claude, ...enabled.map((p) => p.root)]),
    Promise.all(enabled.map((p) => read(`${p.root}/hooks/hooks.json`))),
  ]);
  const from = (items, plugin) => items.map((item) => ({ ...item, from: plugin.name }));
  const all = (kind) => [...defined[kind], ...enabled.flatMap((p, i) => from(own[i][kind], p))];
  return {
    instructions: notes,
    settings: [settingsOf(settings, `${claude}/settings.json`)].filter(Boolean),
    skills: all("skills"),
    commands: all("commands"),
    agents: all("agents"),
    hooks: [...hooksOf(settings, `${claude}/settings.json`), ...enabled.flatMap((p, i) => from(hooksOf(hookFiles[i], `${p.root}/hooks/hooks.json`), p))],
    servers: serversOf(json(userConfig), `${home()}/.claude.json`),
    plugins: plugins.map((p) => ({ name: p.name, description: `${p.version}${p.enabled ? "" : " · disabled"}`, path: p.root })),
  };
}
