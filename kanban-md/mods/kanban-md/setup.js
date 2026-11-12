// What agents work with, from Claude Code's files: instructions, skills, commands, subagents,
// hooks, MCP servers and plugins, for a project and for everywhere. Pure: claude.js reads the
// files and hands their text here.

// A markdown file's YAML frontmatter, its plain fields: { name, description, … }. Handles
// quoted values and folded or literal blocks (`>` and `|`), which is what skills use.
export function frontmatter(text) {
  const match = (text ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fields = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const field = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!field) continue;
    let value = field[2].trim();
    if (/^[>|][-+]?$/.test(value) || value === "") {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(" ").trim();
    }
    fields[field[1]] = value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return fields;
}

// A skill, command or subagent from its file: { name, description, path }. Without a name in
// its frontmatter, a skill is named after its folder, the others after their file.
export function entryOf(path, text, kind) {
  const meta = frontmatter(text);
  const parts = path.split("/");
  const file = parts.at(-1).replace(/(\.agent)?\.md$/, "");
  const fallback = kind === "skill" ? parts.at(-2) : file;
  return { name: meta.name || fallback, description: meta.description || firstLine(text), path };
}

// What defines skills, commands, subagents and output styles under `root` (a .claude folder or
// a plugin), from a list of markdown paths: skills/**/SKILL.md, commands/**/*.md, agents/*.md and
// output-styles/*.md. { skills: [path], commands: [{ path, name }], agents: [path], styles: [path] }.
export function definitionsIn(root, paths) {
  const out = { skills: [], commands: [], agents: [], styles: [] };
  for (const path of paths) {
    if (!path.startsWith(`${root}/`)) continue;
    const [folder, ...rest] = path.slice(root.length + 1).split("/");
    if (folder === "skills" && rest.at(-1) === "SKILL.md") out.skills.push(path);
    else if (folder === "commands" && rest.length) out.commands.push({ path, name: commandName(rest.join("/")) });
    else if (folder === "agents" && rest.length === 1) out.agents.push(path);
    else if (folder === "output-styles" && rest.length === 1) out.styles.push(path);
  }
  return out;
}

// `head -c N a b c`'s output, split back into each file's text: a Map of path -> text. head
// marks each file with "==> path <==" when given more than one.
export function splitHeads(output, paths) {
  if (paths.length === 1) return new Map([[paths[0], output]]);
  const texts = new Map();
  let at = 0;
  paths.forEach((path, i) => {
    const marker = `==> ${path} <==\n`;
    const start = output.indexOf(marker, at);
    if (start < 0) return;
    const next = i + 1 < paths.length ? output.indexOf(`\n==> ${paths[i + 1]} <==\n`, start) : -1;
    texts.set(path, output.slice(start + marker.length, next < 0 ? undefined : next));
    at = next < 0 ? output.length : next;
  });
  return texts;
}

// A command's name from its path under a commands folder: "review.md" is /review,
// "git/commit.md" /git:commit.
export function commandName(relative) {
  return "/" + relative.replace(/\.md$/, "").split("/").join(":");
}

// An instructions file (CLAUDE.md, AGENTS.md): its first line of prose and its length.
export function instructionsOf(path, text) {
  const lines = (text ?? "").split("\n");
  return { name: path.split("/").at(-1), description: firstLine(text), lines: lines.filter((l) => l.trim()).length, path };
}

// The first line worth reading: past the frontmatter, headings' marks dropped, or "".
export function firstLine(text) {
  const body = (text ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const line = body.split("\n").map((l) => l.trim()).find((l) => l && !/^(```|<!--|---)/.test(l)) ?? "";
  return line.replace(/^#+\s*/, "").replace(/[*_`]/g, "");
}

// A settings file as a row: { name, description, path }, described by what it sets: plain values
// with their value ("model: opus"), the rest by name.
export function settingsOf(text, path) {
  const settings = json(text);
  if (!settings || typeof settings !== "object") return null;
  const said = Object.entries(settings).map(([key, value]) => (value !== null && typeof value === "object" ? key : `${key}: ${value}`));
  return { name: path.split("/").at(-1), description: said.join(", ") || "empty", path };
}

// A settings file's permission rules: [{ name, description, detail, path, at }], one per rule in
// permissions.allow, deny and ask. `at` is where the rule is in the file, to change it alone.
export function permissionsOf(settingsText, path) {
  const permissions = json(settingsText)?.permissions;
  const says = { allow: ["allowed", "Runs without asking"], deny: ["denied", "Never runs"], ask: ["asks first", "Always asks before running"] };
  return Object.entries(says).flatMap(([list, [word, meaning]]) => (Array.isArray(permissions?.[list]) ? permissions[list] : []).map((rule, i) => ({
    name: rule, description: word, detail: `${meaning}:\n\n\`\`\`\n${rule}\n\`\`\``, path, at: ["permissions", list, i],
  })));
}

// A settings file's environment variables: [{ name, description, detail, path, at }]. Their
// values aren't shown, since they're often tokens; editing one shows it.
export function envOf(settingsText, path) {
  const env = json(settingsText)?.env;
  if (!env || typeof env !== "object") return [];
  return Object.keys(env).map((name) => ({
    name, description: "value hidden", detail: `Set in every session started with these settings. The value is hidden; e shows it to edit.`, path, at: ["env", name],
  }));
}

// A settings file's hooks: [{ name, description, detail, path }], one per command, named by
// event and matcher ("PreToolUse Bash"), described by its command, and with `detail`, what the
// reader shows: the whole hook as markdown.
export function hooksOf(settingsText, path) {
  const hooks = json(settingsText)?.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  return Object.entries(hooks).flatMap(([event, groups]) => (Array.isArray(groups) ? groups : []).flatMap((group, g) =>
    (group.hooks ?? []).map((hook, h) => ({
      name: [event, group.matcher].filter(Boolean).join(" "),
      description: hook.command ?? hook.prompt ?? hook.type ?? "",
      detail: [
        `When: ${event}${group.matcher ? `, matching \`${group.matcher}\`` : ""}`,
        `Runs: a ${hook.type ?? "command"}${hook.timeout ? `, for up to ${hook.timeout}s` : ""}`,
        "", "```", hook.command ?? hook.prompt ?? "", "```",
      ].join("\n"),
      path,
      at: ["hooks", event, g, "hooks", h],
    }))));
}

// MCP servers in a { mcpServers } object: [{ name, description, detail, path }], described by
// how they run (the command and its arguments, or the URL). `detail` names their environment and
// headers without their values, which are often tokens.
export function serversOf(config, path) {
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== "object") return [];
  return Object.entries(servers).map(([name, s]) => {
    const runs = s.url ?? [s.command, ...(s.args ?? [])].filter(Boolean).join(" ");
    const keys = (label, object) => (object && Object.keys(object).length ? [`${label}: ${Object.keys(object).join(", ")} (values hidden)`] : []);
    const detail = [`${s.url ? "URL" : "Runs"}${s.type ? ` (${s.type})` : ""}:`, "", "```", runs, "```", "", ...keys("Environment", s.env), ...keys("Headers", s.headers)].join("\n").trim();
    return { name, description: runs, detail, path, at: ["mcpServers", name] };
  });
}

// Installed plugins (installed_plugins.json, either version) and whether settings enable them:
// [{ id, name, version, enabled, root }].
export function pluginsOf(installedText, settingsText) {
  const installed = json(installedText);
  const all = installed?.plugins ?? installed ?? {};
  const enabled = json(settingsText)?.enabledPlugins ?? {};
  return Object.entries(all).filter(([, installs]) => Array.isArray(installs) && installs.length).map(([id, installs]) => {
    const latest = installs.at(-1);
    return { id, name: id.split("@")[0], version: latest.version ?? "", enabled: enabled[id] !== false, root: latest.installPath ?? null };
  });
}

// Which of a project's files agents started from cards won't have. They work in a git worktree,
// which holds only committed files. From `git status --porcelain --ignored --untracked-files=all`:
// a Map of path (from the repository) -> "not committed", "ignored" or "changed".
export function localChanges(porcelain) {
  const out = new Map();
  for (const line of (porcelain ?? "").split("\n")) {
    const match = line.match(/^(..) (.+)$/);
    if (!match) continue;
    const path = match[2].replace(/^"(.*)"$/, "$1").split(" -> ").at(-1);
    out.set(path, match[1] === "??" ? "not committed" : match[1] === "!!" ? "ignored" : "changed");
  }
  return out;
}

// A project's setup in a few words, for a card's details: what it adds for agents, and how much
// of it a worktree won't have. "2 skills, 1 hook · 1 not in worktrees", or null for none.
export function setupSummary(project) {
  if (!project) return null;
  const words = [["skills", "skill"], ["commands", "command"], ["agents", "subagent"], ["hooks", "hook"], ["servers", "MCP server"], ["permissions", "permission rule"], ["instructions", "instructions file"], ["settings", "settings file"]];
  const parts = words.map(([kind, word]) => [project[kind]?.length ?? 0, word]).filter(([n]) => n).map(([n, word]) => `${n} ${word}${n === 1 ? "" : "s"}`);
  if (!parts.length) return null;
  const local = Object.values(project).flat().filter((item) => item.local && item.local !== "yours only").length;
  return parts.join(", ") + (local ? ` · ${local} not in worktrees` : "");
}

// How a row can be changed here: { edit, remove, toggle }, each null or a plan.
//   { how: "file", path }        the file, edited whole or moved to the trash; a memory's `index`
//                                is the MEMORY.md whose line for it goes too
//   { how: "json", file, at }    one entry in a JSON file, at that path of keys
//   { how: "mcp", name, scope }  a server Claude Code keeps in ~/.claude.json, through `claude mcp`
//   { how: "plugin", id, scope, on }  a plugin, through `claude plugin`
// What a plugin brings is read-only: its manager would put it back. Settings files are edited,
// never deleted.
export function changesOf({ kind, item }) {
  const none = { edit: null, remove: null, toggle: null };
  if (item.from) return none;
  if (item.mcp) return { ...none, edit: { how: "mcp", ...item.mcp }, remove: { how: "mcp", ...item.mcp } };
  if (kind === "plugins") return item.plugin ? { ...none, remove: { how: "plugin", ...item.plugin }, toggle: { how: "plugin", ...item.plugin } } : none;
  if (item.at && item.path) return { ...none, edit: { how: "json", file: item.path, at: item.at }, remove: { how: "json", file: item.path, at: item.at } };
  if (!item.path || item.path.endsWith("/.claude.json")) return none;
  const file = { how: "file", path: item.path };
  const remove = {
    skills: { how: "file", path: item.path.slice(0, item.path.lastIndexOf("/")) },
    commands: file, agents: file, instructions: file, styles: file,
    memory: { ...file, index: item.index ?? null },
  }[kind] ?? null;
  return { ...none, edit: file, remove };
}

// The value at `at` (a path of keys and indexes) in parsed JSON, or undefined.
export function valueAt(data, at) {
  return at.reduce((node, key) => (node == null ? undefined : node[key]), data);
}

// The JSON text with the value at `at` (a path of keys and indexes) set to `value`.
export function setAt(text, at, value) {
  const data = JSON.parse(text);
  let node = data;
  for (const key of at.slice(0, -1)) node = node[key];
  node[at.at(-1)] = value;
  return `${JSON.stringify(data, null, 2)}\n`;
}

// The JSON text without the value at `at`, and without the objects and lists that leaves empty
// (a hook's group, then its event), short of the top.
export function deleteAt(text, at) {
  const data = JSON.parse(text);
  const parents = [data];
  for (const key of at.slice(0, -1)) parents.push(parents.at(-1)[key]);
  for (let depth = at.length - 1; depth >= 0; depth--) {
    const parent = parents[depth];
    const key = at[depth];
    if (depth < at.length - 1) {
      const child = parent[key];
      const empty = Array.isArray(child) ? !child.length : !Object.keys(child).length;
      if (!empty) break;
    }
    if (Array.isArray(parent)) parent.splice(key, 1);
    else delete parent[key];
  }
  return `${JSON.stringify(data, null, 2)}\n`;
}

// A MEMORY.md without its line for `file` (a "- [Title](file.md) — hook" pointer).
export function withoutIndexLine(index, file) {
  return index.split("\n").filter((line) => !line.includes(`(${file})`)).join("\n");
}

// The kinds a new file can be, and their names.
export const NEW_KINDS = [["skills", "skill"], ["commands", "command"], ["agents", "subagent"]];

// A new skill, command or subagent named `name`: { path, text } under `base` (a .claude folder),
// or null for a name with nothing usable in it. Names become lowercase-with-dashes.
export function newDefinition(base, kind, name) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return null;
  if (kind === "skills") {
    return { path: `${base}/skills/${slug}/SKILL.md`, text: `---\nname: ${slug}\ndescription: What this skill does, and when Claude should use it.\n---\n\n# ${name.trim()}\n\n` };
  }
  if (kind === "commands") {
    return { path: `${base}/commands/${slug}.md`, text: `---\ndescription: What /${slug} does.\n---\n\n` };
  }
  return { path: `${base}/agents/${slug}.md`, text: `---\nname: ${slug}\ndescription: When Claude should hand work to this subagent.\n---\n\nYou are ` };
}

// Names defined both for the project and everywhere, per kind: { skills: Set, … }.
export function overlaps(project, everywhere) {
  const out = {};
  for (const kind of ["skills", "commands", "agents"]) {
    const global = new Set((everywhere[kind] ?? []).map((e) => e.name));
    out[kind] = new Set((project[kind] ?? []).map((e) => e.name).filter((n) => global.has(n)));
  }
  return out;
}

function json(text) {
  try { return JSON.parse(text ?? ""); } catch { return null; }
}
