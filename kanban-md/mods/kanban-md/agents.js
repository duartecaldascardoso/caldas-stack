// The agents the board starts and reads: which ones can be started, and what one said last.
import { exec, hc, home, knownAgents, readTextFile } from "herdr";
import { hasPstack } from "./work.js";
import { lastMessage, screenMessage } from "./runs.js";

// The installed agents Herdr knows, `preferred` (an agent's key, the one picked last) first.
export async function installedAgents(preferred = null) {
  const installed = (await knownAgents().catch(() => [])).filter((a) => a.installed);
  return [...installed.filter((a) => a.key === preferred), ...installed.filter((a) => a.key !== preferred)];
}

// Whether Claude Code has pstack: only Claude Code runs a card through its playbooks.
export async function pstackInstalled() {
  return hasPstack(await readTextFile(`${home()}/.claude/plugins/installed_plugins.json`).catch(() => null));
}

// What an agent ({ address, app, cwd }) said last, or null. Claude Code's transcript gives its
// last message whole; any other agent, or Claude Code without one, is read off its screen.
export async function lastAgentMessage(agent) {
  const fromTranscript = agent.app === "claude-code" && agent.cwd ? await claudeMessage(agent.cwd) : null;
  if (fromTranscript) return fromTranscript;
  const screen = agent.address ? await hc(["read", agent.address]).catch(() => null) : null;
  return screen?.code === 0 ? screenMessage(screen.stdout) : null;
}

// The last message of the newest Claude Code session in folder, or null. Claude Code keeps a
// folder's sessions in ~/.claude/projects/<the folder, with / and . as ->.
async function claudeMessage(folder) {
  const dir = `${home()}/.claude/projects/${folder.replace(/[/.]/g, "-")}`;
  const newest = (await exec("ls", ["-t", dir]).catch(() => null))?.stdout.split("\n").find((f) => f.endsWith(".jsonl"));
  if (!newest) return null;
  return lastMessage((await exec("tail", ["-n", "400", `${dir}/${newest}`]).catch(() => null))?.stdout);
}
