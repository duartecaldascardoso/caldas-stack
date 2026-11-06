// Starting work from a card, and the agents working on cards. Pure.

// A branch name from a card's text: "Pricing page v2!" -> "feature/pricing-page-v2".
export function branchFor(text) {
  const slug = text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return `feature/${slug || "card"}`;
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
