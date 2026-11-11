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

// A settings file as a row: { name, description, path }, described by what it sets.
export function settingsOf(text, path) {
  const settings = json(text);
  if (!settings || typeof settings !== "object") return null;
  return { name: path.split("/").at(-1), description: Object.keys(settings).join(", ") || "empty", path };
}

// A settings file's hooks: [{ name, description, path }], one per command, named by event and
// matcher ("PreToolUse Bash") and described by its command.
export function hooksOf(settingsText, path) {
  const hooks = json(settingsText)?.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  return Object.entries(hooks).flatMap(([event, groups]) => (Array.isArray(groups) ? groups : []).flatMap((group) =>
    (group.hooks ?? []).map((hook) => ({
      name: [event, group.matcher].filter(Boolean).join(" "),
      description: hook.command ?? hook.prompt ?? hook.type ?? "",
      path,
    }))));
}

// MCP servers in a { mcpServers } object: [{ name, description, path }], described by how they
// run (the command and its arguments, or the URL).
export function serversOf(config, path) {
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== "object") return [];
  return Object.entries(servers).map(([name, s]) => ({
    name, description: s.url ?? [s.command, ...(s.args ?? [])].filter(Boolean).join(" "), path,
  }));
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
  const words = [["skills", "skill"], ["commands", "command"], ["agents", "subagent"], ["hooks", "hook"], ["servers", "MCP server"], ["instructions", "instructions file"], ["settings", "settings file"]];
  const parts = words.map(([kind, word]) => [project[kind]?.length ?? 0, word]).filter(([n]) => n).map(([n, word]) => `${n} ${word}${n === 1 ? "" : "s"}`);
  if (!parts.length) return null;
  const local = Object.values(project).flat().filter((item) => item.local && item.local !== "yours only").length;
  return parts.join(", ") + (local ? ` · ${local} not in worktrees` : "");
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
