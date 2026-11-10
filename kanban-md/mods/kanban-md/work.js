// Starting work from a card, and the agents working on cards. Pure.

// Card prefixes that name a pstack playbook (pstack/skills/poteto-mode/playbooks), the branch
// prefix its work goes on, its steps shortened as [label, step], and what a run ends with.
// "Bug: login fails" is the Bug fix playbook on fix/login-fails.
const PLAYBOOKS = [
  { words: ["bug", "fix"], playbook: "Bug fix", branch: "fix", ends: "The failing reproduction, then the same one passing.", steps: [
    ["reproduce", "Reproduce it yourself, where it happens"],
    ["narrow", "Narrow down the cause with runtime evidence"],
    ["plan", "Plan the fix, designing first if it crosses a function boundary"],
    ["verify", "Check that the original reproduction now passes"],
    ["commit", "Commit the failing test before the fix"],
    ["open PR", "Open the pull request"]] },
  { words: ["perf"], playbook: "Perf issue", branch: "perf", ends: "Baseline, after, the difference, and the trace.", steps: [
    ["baseline", "Capture a baseline measurement, and vet it"],
    ["ideas", "Try ideas cheapest first, and stop at the first that hits the target"],
    ["fix", "Fix it from the trace, then measure again"],
    ["compare", "Compare before and after"],
    ["cite", "Cite the numbers"],
    ["open PR", "Open the pull request"]] },
  { words: ["refactor"], playbook: "Refactoring", branch: "refactor", ends: "The pin it held, the equivalence check, what got reverted.", steps: [
    ["pin", "Pin today's behavior with a test or snapshot"],
    ["name", "Name the structure the code is missing"],
    ["target", "Name the target shape"],
    ["subtract", "Delete dead code before adding the new shape"],
    ["move", "Move in small steps, keeping the pin green"],
    ["prove", "Prove the behavior didn't change"],
    ["keep", "Keep it only if the code got easier to read"],
    ["open PR", "Open the pull request"]] },
  { words: ["spike", "prototype"], playbook: "Prototype", branch: "spike", ends: "Each variant's evidence and a recommendation. The code is thrown away.", steps: [
    ["decision", "Name the decision the prototype exists to make"],
    ["references", "Gather references if the direction is open"],
    ["build", "Build throwaway code in a scratch folder"],
    ["switcher", "Put the variants behind one switcher"],
    ["observe", "Look at each variant, or measure the behavior"],
    ["recommend", "Recommend one, for Feature to build"]] },
  { words: ["investigate", "question"], playbook: "Investigation", branch: "investigate", ends: "A cited answer. No code, no pull request.", steps: [
    ["trace", "Trace how the code works, and why it was built that way"],
    ["scope", "Note that it is read-only: nothing to run in parallel"],
    ["answer", "Write the answer: overview, concepts, how it works, where things live, gotchas"],
    ["edit", "Clean up the prose"]] },
  { words: ["feat", "feature"], playbook: "Feature", branch: "feature", ends: "What was built, the choices and why, the open decisions.", steps: [
    ["learn", "Learn how the affected code works"],
    ["design", "Explore a few designs in parallel before building"],
    ["split", "Decide what runs first, in parallel, and what can't be shared"],
    ["build", "Helpers write the code, from a named data shape"],
    ["verify", "Verify where it actually runs"],
    ["commits", "Rebase into small, ordered commits"],
    ["review", "Get an adversarial review if the design is contested"],
    ["open PR", "Open the pull request"]] },
];

// Babysit isn't picked by a prefix: ⇧B starts it on a card's pull request.
const BABYSIT = { words: [], playbook: "Babysit", branch: null, ends: "Merge-ready, or the one thing that needs you.", steps: [
  ["mode", "Pick a mode: drive to merge-ready, or one status check"],
  ["frontier", "Work the lowest pull request in a stack first"],
  ["alone", "Make sure no other agent is on it"],
  ["no rewrites", "Never rebase or force-push; report what needs a rebase"],
  ["in order", "Conflicts, then review comments, then checks"],
  ["verdict", "Trust GitHub's verdict on whether it can merge"],
  ["CI", "Diagnose a failing check before retrying it, once"],
  ["bots", "Check bot reviews against the code"],
  ["stop", "Stop at your approval. Never merge."]] };

// Every playbook the board knows, for the inspector and `kanban playbook`.
export const PLAYBOOK_LIST = [...PLAYBOOKS, BABYSIT];

// A playbook by its name or one of its words, ignoring case: "bug fix", "bug", "Babysit".
export function playbookNamed(name) {
  const q = String(name ?? "").trim().toLowerCase();
  return PLAYBOOK_LIST.find((p) => p.playbook.toLowerCase() === q || p.words.includes(q)) ?? null;
}

// How an agent reports its steps to the board, for its first message.
export const REPORT = "Report each step on the board as you go: `kanban step <n> now|done|skipped [note]`.";

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
// poteto-mode, naming the card's playbook when it has one. Without pstack, a card with a playbook
// gets its steps spelled out. Either way the agent reports the steps it works through.
export function taskFor(text, issue, pstack) {
  const { playbook, title } = playbookOf(text);
  const task = issue ? `${title} (GitHub issue #${issue})` : title;
  if (pstack && playbook) return `/pstack:poteto-mode ${playbook} playbook. ${task}. ${REPORT}`;
  if (pstack) return `/pstack:poteto-mode ${task}. Once you pick a playbook, run \`kanban playbook <name>\`. ${REPORT}`;
  if (!playbook) return task;
  const steps = playbookNamed(playbook).steps.map(([, step], i) => `${i + 1}. ${step}.`).join(" ");
  return `${task}. Work through these steps: ${steps} ${REPORT}`;
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
  if (pstack) return `/pstack:poteto-mode Babysit playbook, ${mode} mode. Pull request #${number}${why}: ${title}. ${REPORT}`;
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
// branch -> { status, address, name, cwd }. When several share a branch, the most urgent wins.
const URGENCY = { blocked: 3, done: 2, working: 1, idle: 0 };
export function agentsByBranch(agents, panes) {
  const byPane = new Map(panes.map((p) => [p.pane, p]));
  const out = new Map();
  for (const agent of agents) {
    const branch = byPane.get(agent.pane)?.branch;
    if (!branch) continue;
    const seen = out.get(branch);
    if (seen && URGENCY[seen.status] >= URGENCY[agent.status]) continue;
    out.set(branch, { status: agent.status, address: agent.address, name: agent.program?.name || agent.app || "Agent", cwd: byPane.get(agent.pane)?.cwd ?? null });
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
