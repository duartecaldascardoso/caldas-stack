// Claude Code's files for a project and for everywhere, read from disk into what setup.js
// makes of them: { project, everywhere }, each { instructions, settings, permissions, env,
// skills, commands, agents, styles, hooks, servers, plugins }, the project's with memory too.
// Each item is { name, description, path }, with `from` (a plugin's name), `local` (why agents
// started from cards won't have it), and what changesOf needs to change it: `at` (its place in a
// JSON file), `mcp` ({ name, scope } for `claude mcp`), `plugin` ({ id, scope, on }) or `index`.
//
// Every file call a mod makes goes through the app, so files are found with one `find` and read
// with one `head` rather than one call each.
import { exec, home, readTextFile } from "herdr";
import {
  entryOf, definitionsIn, splitHeads, instructionsOf, settingsOf, permissionsOf, envOf, hooksOf, serversOf, pluginsOf, localChanges,
} from "./setup.js";

const read = (path) => readTextFile(path).catch(() => null);
const json = (text) => { try { return JSON.parse(text ?? ""); } catch { return null; } };

// The first 4 KB of each of `paths`, which hold their frontmatter: a Map of path -> text.
async function heads(paths) {
  if (!paths.length) return new Map();
  return splitHeads((await exec("head", ["-c", "4096", ...paths]).catch(() => null))?.stdout ?? "", paths);
}

// Markdown files under `dirs` (following links: a repository may link .claude/skills to a folder
// its other agents share), a few levels deep. find exits non-zero over folders that don't exist;
// what it found still counts.
async function markdownUnder(dirs, depth) {
  if (!dirs.length) return []; // find without a folder would search the one it runs in
  const found = await exec("find", ["-L", ...dirs, "-maxdepth", String(depth), "-type", "f", "-name", "*.md"]).catch(() => null);
  return (found?.stdout ?? "").split("\n").filter(Boolean).sort();
}

// Skills, commands, subagents and output styles kept under each of `roots` (.claude folders and
// plugins), as [{ skills, commands, agents, styles }] in the same order.
async function definedIn(roots) {
  const paths = await markdownUnder(roots.flatMap((root) => ["skills", "commands", "agents", "output-styles"].map((sub) => `${root}/${sub}`)), 5);
  const byRoot = roots.map((root) => definitionsIn(root, paths));
  const texts = await heads(byRoot.flatMap((d) => [...d.skills, ...d.commands.map((c) => c.path), ...d.agents, ...d.styles]));
  return byRoot.map((d) => ({
    skills: d.skills.map((path) => entryOf(path, texts.get(path), "skill")),
    commands: d.commands.map(({ path, name }) => ({ ...entryOf(path, texts.get(path), "command"), name })),
    agents: d.agents.map((path) => entryOf(path, texts.get(path), "agent")),
    styles: d.styles.map((path) => entryOf(path, texts.get(path), "style")),
  }));
}

// What enabled plugins bring: their skills, commands, subagents, output styles, hooks and MCP
// servers, each marked `from` the plugin. `plugins`: [{ name, root }].
async function broughtBy(plugins) {
  const roots = plugins.map((p) => p.root);
  const [own, hookFiles, serverFiles] = await Promise.all([
    definedIn(roots),
    Promise.all(roots.map((root) => read(`${root}/hooks/hooks.json`))),
    Promise.all(roots.map((root) => read(`${root}/.mcp.json`))),
  ]);
  const from = (items, plugin) => items.map((item) => ({ ...item, from: plugin.name }));
  const all = (kind) => plugins.flatMap((p, i) => from(own[i][kind], p));
  return {
    skills: all("skills"), commands: all("commands"), agents: all("agents"), styles: all("styles"),
    hooks: plugins.flatMap((p, i) => from(hooksOf(hookFiles[i], `${p.root}/hooks/hooks.json`), p)),
    servers: plugins.flatMap((p, i) => from(serversOf(json(serverFiles[i]), `${p.root}/.mcp.json`), p)),
  };
}

const pluginRow = (p, scope) => ({
  name: p.name, description: `${p.version}${p.enabled ? "" : " · off"}`, path: p.root, plugin: { id: p.id, scope, on: p.enabled },
});

// MCP servers Claude Code keeps in ~/.claude.json: changed through `claude mcp` at their scope.
const keptServers = (config, scope) => serversOf(config, `${home()}/.claude.json`).map(({ at: _, ...s }) => ({ ...s, mcp: { name: s.name, scope } }));

// A settings file's permissions, environment and hooks, together.
const fromSettings = (text, file) => ({ permissions: permissionsOf(text, file), env: envOf(text, file), hooks: hooksOf(text, file) });

// What Claude has remembered for a project: its memory folder's MEMORY.md, then each memory.
async function memoryOf(root) {
  const dir = `${home()}/.claude/projects/${root.replace(/[/.]/g, "-")}/memory`;
  const paths = await markdownUnder([dir], 1);
  const texts = await heads(paths);
  const index = paths.find((p) => p.endsWith("/MEMORY.md"));
  return paths.map((path) => (path === index
    ? { ...instructionsOf(path, texts.get(path)), description: "The index Claude reads first" }
    : { ...entryOf(path, texts.get(path), "memory"), index: index ?? null }));
}

async function instructions(paths) {
  const found = await Promise.all(paths.map(async (path) => ({ path, text: await read(path) })));
  return found.filter((f) => f.text !== null).map((f) => instructionsOf(f.path, f.text));
}

export async function projectSetup(root) {
  const claude = `${root}/.claude`;
  const sharedFile = `${claude}/settings.json`;
  const localFile = `${claude}/settings.local.json`;
  const [[defined], notes, shared, local, mcp, userConfig, installed, memory, status] = await Promise.all([
    definedIn([claude]),
    instructions([`${root}/CLAUDE.md`, `${root}/AGENTS.md`, `${claude}/CLAUDE.md`, `${root}/CLAUDE.local.md`]),
    read(sharedFile),
    read(localFile),
    read(`${root}/.mcp.json`),
    read(`${home()}/.claude.json`),
    read(`${home()}/.claude/plugins/installed_plugins.json`),
    memoryOf(root),
    exec("git", ["-C", root, "status", "--porcelain", "--ignored", "--untracked-files=all", "--", ".claude", "CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", ".mcp.json"]).catch(() => null),
  ]);
  // Plugins the project's settings turn on, each remembering the file that does it.
  const turnedOn = [[shared, sharedFile], [local, localFile]]
    .flatMap(([text, file]) => Object.entries(json(text)?.enabledPlugins ?? {}).filter(([, on]) => on === true).map(([id]) => [id, file]));
  const plugins = pluginsOf(installed, null).filter((p) => p.root && turnedOn.some(([id]) => id === p.id))
    .map((p) => ({ ...p, enabled: true, file: turnedOn.find(([id]) => id === p.id)[1] }));
  const brought = await broughtBy(plugins);
  const [one, two] = [fromSettings(shared, sharedFile), fromSettings(local, localFile)];
  const setup = {
    instructions: notes,
    settings: [settingsOf(shared, sharedFile), settingsOf(local, localFile)].filter(Boolean),
    permissions: [...one.permissions, ...two.permissions],
    env: [...one.env, ...two.env],
    skills: [...defined.skills, ...brought.skills],
    commands: [...defined.commands, ...brought.commands],
    agents: [...defined.agents, ...brought.agents],
    styles: [...defined.styles, ...brought.styles],
    hooks: [...one.hooks, ...two.hooks, ...brought.hooks],
    // Servers added with `claude mcp add` (local scope) live in ~/.claude.json, by project.
    servers: [...serversOf(json(mcp), `${root}/.mcp.json`), ...keptServers(json(userConfig)?.projects?.[root], "local").map((s) => ({ ...s, local: "yours only" })), ...brought.servers],
    plugins: plugins.map((p) => pluginRow(p, p.file === localFile ? "local" : "project")),
    memory,
  };
  // What a worktree won't have: anything git doesn't hold as committed.
  const changes = localChanges(status?.code === 0 ? status.stdout : "");
  const stateOf = (path) => {
    const relative = path?.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
    if (relative === null) return null;
    for (const [changed, state] of changes) if (changed === relative || (changed.endsWith("/") && relative.startsWith(changed))) return state;
    return null;
  };
  for (const [kind, items] of Object.entries(setup)) if (kind !== "memory") for (const item of items) item.local ??= stateOf(item.path);
  // What a plugin brings reaches a worktree only if the file turning it on does.
  const fileOf = new Map(plugins.map((p) => [p.name, p.file]));
  for (const kind of ["skills", "commands", "agents", "styles", "hooks", "servers", "plugins"]) {
    for (const item of setup[kind]) {
      const file = fileOf.get(item.from ?? (kind === "plugins" ? item.name : null));
      if (file) item.local = stateOf(file);
    }
  }
  return setup;
}

export async function everywhereSetup() {
  const claude = `${home()}/.claude`;
  const settingsFile = `${claude}/settings.json`;
  const [notes, settings, installed, userConfig] = await Promise.all([
    instructions([`${claude}/CLAUDE.md`]),
    read(settingsFile),
    read(`${claude}/plugins/installed_plugins.json`),
    read(`${home()}/.claude.json`),
  ]);
  const plugins = pluginsOf(installed, settings);
  const [[defined], brought] = await Promise.all([definedIn([claude]), broughtBy(plugins.filter((p) => p.enabled && p.root))]);
  const own = fromSettings(settings, settingsFile);
  return {
    instructions: notes,
    settings: [settingsOf(settings, settingsFile)].filter(Boolean),
    permissions: own.permissions,
    env: own.env,
    skills: [...defined.skills, ...brought.skills],
    commands: [...defined.commands, ...brought.commands],
    agents: [...defined.agents, ...brought.agents],
    styles: [...defined.styles, ...brought.styles],
    hooks: [...own.hooks, ...brought.hooks],
    servers: [...keptServers(json(userConfig), "user"), ...brought.servers],
    plugins: plugins.map((p) => pluginRow(p, "user")),
  };
}
