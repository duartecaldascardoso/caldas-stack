// The agents the board starts and reads: which one to start, and what one said last.
import { exec, home, knownAgents, readTextFile } from "herdr";
import { hasPstack } from "./work.js";
import { lastMessage } from "./runs.js";

// The first installed agent Herdr knows, and whether it is Claude Code with pstack:
// { agent, pstack }, or null when none is installed.
export async function pickAgent() {
  const agent = (await knownAgents().catch(() => [])).find((a) => a.installed);
  if (!agent) return null;
  const pstack = agent.key === "claude" && hasPstack(await readTextFile(`${home()}/.claude/plugins/installed_plugins.json`).catch(() => null));
  return { agent, pstack };
}

// The last message of the newest Claude Code session in folder, or null. Claude Code keeps a
// folder's sessions in ~/.claude/projects/<the folder, with / and . as ->.
export async function lastAgentMessage(folder) {
  const dir = `${home()}/.claude/projects/${folder.replace(/[/.]/g, "-")}`;
  const newest = (await exec("ls", ["-t", dir]).catch(() => null))?.stdout.split("\n").find((f) => f.endsWith(".jsonl"));
  if (!newest) return null;
  return lastMessage((await exec("tail", ["-n", "400", `${dir}/${newest}`]).catch(() => null))?.stdout);
}
