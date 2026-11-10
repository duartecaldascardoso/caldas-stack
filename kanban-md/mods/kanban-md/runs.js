// What agents report about the playbooks they work through, kept beside the boards in
// ~/kanban/.runs/<board>.json. Pure.
//
// runs: { [branch]: { playbook, at, steps: { [n]: { status: "now" | "done" | "skipped", note, at } } } }

export const STEP_STATUSES = ["now", "done", "skipped"];

export function parseRuns(text) {
  try {
    const runs = JSON.parse(text ?? "");
    return runs && typeof runs === "object" && !Array.isArray(runs) ? runs : {};
  } catch {
    return {};
  }
}

// A branch's run on `playbook`. The same playbook again keeps its steps; another starts over.
export function recordPlaybook(runs, branch, playbook, at) {
  const run = runs[branch];
  return { ...runs, [branch]: run?.playbook === playbook ? { ...run, at } : { playbook, at, steps: {} } };
}

// Step n (from 1) of a branch's run is now, done or skipped. A new "now" ends the previous one,
// which counts as done.
export function recordStep(runs, branch, n, status, note, at) {
  const run = runs[branch] ?? { playbook: null, at, steps: {} };
  const steps = Object.fromEntries(Object.entries(run.steps).map(([k, s]) =>
    [k, status === "now" && s.status === "now" && Number(k) !== n ? { ...s, status: "done" } : s]));
  steps[n] = { status, note: note || null, at };
  return { ...runs, [branch]: { ...run, at, steps } };
}

// Where a run stands among `total` steps: how many are finished (done or skipped), and the step
// in hand: the one marked now, else the first not finished, else null when all are.
export function progress(run, total) {
  const steps = run?.steps ?? {};
  const finished = (n) => ["done", "skipped"].includes(steps[n]?.status);
  let done = 0;
  for (let n = 1; n <= total; n++) if (finished(n)) done++;
  const now = Object.keys(steps).map(Number).find((n) => steps[n].status === "now" && n <= total);
  let current = now ?? null;
  for (let n = 1; current === null && n <= total; n++) if (!finished(n)) current = n;
  return { done, current: done === total ? null : current };
}

// The loop a card goes around, and who does what at each station, for the inspector.
export const LOOP = [
  { name: "Plan", you: "Write a card, with a prefix like bug:", board: "Saves it in ~/kanban", agent: null },
  { name: "Start", you: "s on the card, then y", board: "A worktree, a branch, and a space with the agent", agent: "Gets the card as its first message" },
  { name: "Work", you: null, board: "Shows the agent working, blocked or ready", agent: "Works the playbook, reports each step, gathers proof" },
  { name: "Review", you: "g for the diff, comments, Send to agent", board: "Moves the card to test when the PR opens", agent: "Opens the PR, answers your comments" },
  { name: "Babysit", you: "⇧B when checks fail or changes are asked", board: "Shows checks, review and conflicts", agent: "Conflicts, threads, then CI. Never merges." },
  { name: "Ship", you: "Approve and merge. Only you land it.", board: "Moves the card to done", agent: null },
];

// The station a card is at, from its column (as COLUMNS orders them), whether an agent or a run
// is on it, and its run's playbook.
export function stationOf(col, { working = false, playbook = null } = {}) {
  if (col <= 1) return 0;
  if (col === 2) return working ? 2 : 1;
  if (col === 3) return playbook === "Babysit" ? 4 : 3;
  return 5;
}

// The agent's last message in a Claude Code transcript (JSON lines), with its time:
// { text, at }, or null. Helper agents' messages (isSidechain) don't count.
export function lastMessage(jsonl) {
  const lines = String(jsonl ?? "").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry?.type !== "assistant" || entry.isSidechain) continue;
    const content = entry.message?.content;
    const text = (Array.isArray(content) ? content : []).filter((c) => c?.type === "text").map((c) => c.text).join("\n").trim();
    if (text) return { text, at: entry.timestamp ?? null };
  }
  return null;
}

// "just now", "4 min", "2 h", "3 d" since an ISO time; null without one.
export function ago(iso, now = Date.now()) {
  const ms = now - Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return null;
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min`;
  if (min < 60 * 24) return `${Math.floor(min / 60)} h`;
  return `${Math.floor(min / 60 / 24)} d`;
}

// An agent's message, organised for a narrow column: { lead, points, more, question }. The lead
// is its first paragraph, the points its first bullets, `more` what's left out, and the question
// the last paragraph that asks one. Markdown marks, code blocks, tables and headings go.
export function summarize(text, { points: max = 4, lead: leadMax = 240, point: pointMax = 140 } = {}) {
  const clean = (s) => s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  const paragraphs = [];
  const bullets = [];
  let fence = false;
  let last = null; // "para" or "bullet": what a following line continues
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) { fence = !fence; last = null; continue; }
    if (fence || !line || line.startsWith("#") || line.startsWith("|") || /^[-*_]{3,}$/.test(line)) { last = null; continue; }
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) { bullets.push(clean(bullet[1])); last = "bullet"; }
    else if (last === "bullet" && raw !== raw.trimStart()) bullets[bullets.length - 1] += ` ${clean(line)}`;
    else if (last === "para") paragraphs[paragraphs.length - 1] += ` ${line}`;
    else { paragraphs.push(line); last = "para"; }
  }
  const paras = paragraphs.map(clean).filter(Boolean);
  const asks = paras.filter((s) => s.endsWith("?"));
  return {
    lead: paras.length ? cut(paras[0], leadMax) : null,
    points: bullets.slice(0, max).map((b) => cut(b, pointMax)),
    more: Math.max(0, bullets.length - max) + Math.max(0, paras.length - 1),
    question: asks.length ? cut(asks[asks.length - 1], leadMax) : null,
  };
}
