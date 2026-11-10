// Starting work from a card, and the agents working on cards. Pure.

// Card prefixes that name a pstack playbook (pstack/skills/poteto-mode/playbooks), and the
// branch prefix its work goes on. "Bug: login fails" is the Bug fix playbook on fix/login-fails.
const PLAYBOOKS = [
  { words: ["bug", "fix"], playbook: "Bug fix", branch: "fix" },
  { words: ["perf"], playbook: "Perf issue", branch: "perf" },
  { words: ["refactor"], playbook: "Refactoring", branch: "refactor" },
  { words: ["spike", "prototype"], playbook: "Prototype", branch: "spike" },
  { words: ["investigate", "question"], playbook: "Investigation", branch: "investigate" },
  { words: ["feat", "feature"], playbook: "Feature", branch: "feature" },
];

// A card's playbook, branch prefix and text without the prefix. No prefix: no playbook, so
// poteto-mode picks one, and the work goes on feature/.
export function playbookOf(text) {
  const m = text.match(/^\s*([a-z]+)\s*:\s*(.*)$/is);
  const found = m && PLAYBOOKS.find((p) => p.words.includes(m[1].toLowerCase()));
  if (!found || !m[2].trim()) return { playbook: null, branch: "feature", title: text.trim() };
  return { playbook: found.playbook, branch: found.branch, title: m[2].trim() };
}

// A branch name from a card's text: "Pricing page v2!" -> "feature/pricing-page-v2".
export function branchFor(text) {
  const { branch, title } = playbookOf(text);
  const slug = title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return `${branch}/${slug || "card"}`;
}

// The agent's first message. With pstack installed in Claude Code, the card runs through
// poteto-mode, naming the card's playbook when it has one.
export function taskFor(text, issue, pstack) {
  const { playbook, title } = playbookOf(text);
  const task = issue ? `${title} (GitHub issue #${issue})` : title;
  if (!pstack) return task;
  return `/pstack:poteto-mode ${playbook ? `${playbook} playbook. ` : ""}${task}`;
}

// Babysitting a card's pull request, as pstack's Babysit playbook does it: `drive` runs it to
// merge-ready when something blocks it, `check` is one status pass and a report. The blockers
// come in the playbook's order: conflicts, then review, then checks. Null unless it is open.
export function babysitFor(number, status) {
  if (status?.kind !== "pr" || (status.state !== "open" && status.state !== "draft")) return null;
  const blockers = [
    status.conflicts && "conflicts",
    status.review === "changes" && "changes requested",
    status.checks === "failing" && "checks failing",
  ].filter(Boolean);
  return { number, mode: blockers.length ? "drive" : "check", blockers };
}

// The babysitter's first message: the Babysit playbook with pstack, else its rules spelled out.
export function babysitTask({ number, mode, blockers }, text, pstack) {
  const { title } = playbookOf(text);
  const why = blockers.length ? ` (${blockers.join(", ")})` : "";
  if (pstack) return `/pstack:poteto-mode Babysit playbook, ${mode} mode. Pull request #${number}${why}: ${title}`;
  if (mode === "check") return `Check on pull request #${number}: ${title}. Report its checks, review threads and whether it can merge. Change nothing.`;
  return `Get pull request #${number} merge-ready${why}: ${title}. Report conflicts instead of rebasing, answer review comments, fix only checks the diff broke, and don't merge.`;
}

// Whether Claude Code has pstack, from ~/.claude/plugins/installed_plugins.json: the official
// plugin (pstack@cursor-plugins) or a port (pstack@pstack-claude).
export function hasPstack(installed) {
  try {
    const json = JSON.parse(installed ?? "");
    return Object.keys(json?.plugins ?? json ?? {}).some((key) => key.startsWith("pstack@"));
  } catch {
    return false;
  }
}

// Where Herdr's worktree mod keeps checkouts, so the spaces sidebar nests them under their
// repository: ~/.herdr/worktrees/<repo>/<branch, with slashes as dashes>.
export function worktreePath(home, repo, branch) {
  const name = repo.split("/").filter(Boolean).pop();
  const folder = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${home}/.herdr/worktrees/${name}/${folder}`;
}

// The branch a card's work happens on: its own link, or its pull request's head.
export const cardBranch = (link, status) => link?.branch ?? status?.branch ?? null;

// Agents by the branch their terminal is on, from Herdr's agents() and panes():
// branch -> { status, address, name }. When several share a branch, the most urgent wins.
const URGENCY = { blocked: 3, done: 2, working: 1, idle: 0 };
export function agentsByBranch(agents, panes) {
  const byPane = new Map(panes.map((p) => [p.pane, p]));
  const out = new Map();
  for (const agent of agents) {
    const branch = byPane.get(agent.pane)?.branch;
    if (!branch) continue;
    const seen = out.get(branch);
    if (seen && URGENCY[seen.status] >= URGENCY[agent.status]) continue;
    out.set(branch, { status: agent.status, address: agent.address, name: agent.program?.name || agent.app || "Agent" });
  }
  return out;
}

// Branches whose agent just stopped working: it was working and is now done or idle.
export function finished(before, now) {
  const out = [];
  for (const [branch, agent] of now) {
    if (before.get(branch)?.status === "working" && (agent.status === "done" || agent.status === "idle")) out.push(branch);
  }
  return out;
}

// The folder already checked out on `branch`, from `git worktree list --porcelain`, or null.
export function checkoutOf(porcelain, branch) {
  for (const block of porcelain.split(/\n\n+/)) {
    const lines = block.split("\n");
    if (lines.includes(`branch refs/heads/${branch}`)) return lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? null;
  }
  return null;
}
