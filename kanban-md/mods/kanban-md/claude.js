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
  if (!roots.length) return []; // find without a folder would search the one it runs in
  const dirs = roots.flatMap((root) => ["skills", "commands", "agents"].map((sub) => `${root}/${sub}`));
  // -L follows links (a repository may link .claude/skills to a folder its other agents share).
  // find exits non-zero over folders that don't exist; what it found still counts.
  const found = await exec("find", ["-L", ...dirs, "-maxdepth", "5", "-type", "f", "-name", "*.md"]).catch(() => null);
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

// What enabled plugins bring: their skills, commands, subagents and hooks, each marked `from`
// the plugin. `plugins`: [{ name, root }].
async function broughtBy(plugins) {
  const [own, hookFiles] = await Promise.all([
    definedIn(plugins.map((p) => p.root)),
    Promise.all(plugins.map((p) => read(`${p.root}/hooks/hooks.json`))),
  ]);
  const from = (items, plugin) => items.map((item) => ({ ...item, from: plugin.name }));
  const all = (kind) => plugins.flatMap((p, i) => from(own[i][kind], p));
  return {
    skills: all("skills"), commands: all("commands"), agents: all("agents"),
    hooks: plugins.flatMap((p, i) => from(hooksOf(hookFiles[i], `${p.root}/hooks/hooks.json`), p)),
  };
}

const pluginRow = (p) => ({ name: p.name, description: `${p.version}${p.enabled ? "" : " · disabled"}`, path: p.root });

async function instructions(paths) {
  const found = await Promise.all(paths.map(async (path) => ({ path, text: await read(path) })));
  return found.filter((f) => f.text !== null).map((f) => instructionsOf(f.path, f.text));
}

export async function projectSetup(root) {
  const claude = `${root}/.claude`;
  const [[defined], notes, shared, local, mcp, userConfig, installed, status] = await Promise.all([
    definedIn([claude]),
    instructions([`${root}/CLAUDE.md`, `${root}/AGENTS.md`, `${claude}/CLAUDE.md`, `${root}/CLAUDE.local.md`]),
    read(`${claude}/settings.json`),
    read(`${claude}/settings.local.json`),
    read(`${root}/.mcp.json`),
    read(`${home()}/.claude.json`),
    read(`${home()}/.claude/plugins/installed_plugins.json`),
    exec("git", ["-C", root, "status", "--porcelain", "--ignored", "--untracked-files=all", "--", ".claude", "CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", ".mcp.json"]).catch(() => null),
  ]);
  // MCP servers added with `claude mcp add` (local scope) live in ~/.claude.json, by project.
  const privateServers = serversOf(json(userConfig)?.projects?.[root], `${home()}/.claude.json`).map((s) => ({ ...s, local: "yours only" }));
  // Plugins the project's settings turn on, each remembering the file that does it.
  const turnedOn = [[shared, `${claude}/settings.json`], [local, `${claude}/settings.local.json`]]
    .flatMap(([text, file]) => Object.entries(json(text)?.enabledPlugins ?? {}).filter(([, on]) => on === true).map(([id]) => [id, file]));
  const plugins = pluginsOf(installed, null).filter((p) => p.root && turnedOn.some(([id]) => id === p.id))
    .map((p) => ({ ...p, enabled: true, file: turnedOn.find(([id]) => id === p.id)[1] }));
  const brought = await broughtBy(plugins);
  const setup = {
    instructions: notes,
    settings: [settingsOf(shared, `${claude}/settings.json`), settingsOf(local, `${claude}/settings.local.json`)].filter(Boolean),
    skills: [...defined.skills, ...brought.skills],
    commands: [...defined.commands, ...brought.commands],
    agents: [...defined.agents, ...brought.agents],
    hooks: [...hooksOf(shared, `${claude}/settings.json`), ...hooksOf(local, `${claude}/settings.local.json`), ...brought.hooks],
    servers: [...serversOf(json(mcp), `${root}/.mcp.json`), ...privateServers],
    plugins: plugins.map((p) => pluginRow(p)),
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
  // What a plugin brings reaches a worktree only if the file turning it on does.
  const fileOf = new Map(plugins.map((p) => [p.name, p.file]));
  for (const kind of ["skills", "commands", "agents", "hooks", "plugins"]) {
    for (const item of setup[kind]) {
      const file = fileOf.get(item.from ?? (kind === "plugins" ? item.name : null));
      if (file) item.local = stateOf(file);
    }
  }
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
  const [[defined], brought] = await Promise.all([definedIn([claude]), broughtBy(plugins.filter((p) => p.enabled && p.root))]);
  return {
    instructions: notes,
    settings: [settingsOf(settings, `${claude}/settings.json`)].filter(Boolean),
    skills: [...defined.skills, ...brought.skills],
    commands: [...defined.commands, ...brought.commands],
    agents: [...defined.agents, ...brought.agents],
    hooks: [...hooksOf(settings, `${claude}/settings.json`), ...brought.hooks],
    servers: serversOf(json(userConfig), `${home()}/.claude.json`),
    plugins: plugins.map((p) => pluginRow(p)),
  };
}
