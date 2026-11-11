// A linked pull request's state, as the card shows it, and where that puts the card. Pure.

const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

// From `gh pr view --json state,isDraft,reviewDecision,statusCheckRollup,headRefName,mergeable`:
// { state: "open" | "draft" | "merged" | "closed", checks: "passing" | "failing" | "pending" | null,
//   review: "approved" | "changes" | null, branch: its head branch or null, conflicts }.
export function prStatus(pr) {
  const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";
  // Check runs report a conclusion once completed; commit statuses report a state.
  const results = (pr.statusCheckRollup ?? []).map((c) => c.conclusion || c.state || (c.status === "COMPLETED" ? "SUCCESS" : "PENDING"));
  const checks = !results.length ? null
    : results.some((r) => FAILED.has(r)) ? "failing"
    : results.every((r) => PASSED.has(r)) ? "passing"
    : "pending";
  const review = pr.reviewDecision === "APPROVED" ? "approved" : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes" : null;
  return { kind: "pr", state, checks, review, branch: pr.headRefName ?? null, conflicts: pr.mergeable === "CONFLICTING" };
}

// From `gh issue view --json state,stateReason,url`: { kind: "issue", state: "open" | "closed",
// completed, url }. An issue closed as not planned isn't completed.
export function issueStatus(issue) {
  const closed = issue.state === "CLOSED";
  return { kind: "issue", state: closed ? "closed" : "open", completed: closed && issue.stateReason !== "NOT_PLANNED", url: issue.url ?? null };
}

// The column a card belongs in now, or null to leave it: a merged pull request ships, and an
// open one is in review once it has left ideas, plan and work; a completed issue ships. Column
// indexes follow COLUMNS.
export function columnFor(status, col, { review = 3, ship = 4 } = {}) {
  if (status.kind === "issue") return status.completed && col !== ship ? ship : null;
  if (status.state === "merged") return col === ship ? null : ship;
  if (status.state === "open" && col < review) return review;
  return null;
}

// "#42 open · checks passing · approved", for the hint line.
export function describe(number, status) {
  if (status.kind === "issue") return `issue #${number} ${status.completed === false && status.state === "closed" ? "closed, not planned" : status.state}`;
  const parts = [`#${number} ${status.state}`];
  if (status.conflicts) parts.push("conflicts");
  if (status.checks) parts.push(`checks ${status.checks}`);
  if (status.review) parts.push(status.review === "approved" ? "approved" : "changes requested");
  return parts.join(" · ");
}

// The number at the end of the URL `gh pr create` prints.
export const numberFromUrl = (url) => Number(url.trim().match(/\/pull\/(\d+)\s*$/)?.[1]) || null;

// The failing checks of a pull request, from `gh pr check --json name,bucket,link`, with the
// workflow run each belongs to (from its link): [{ name, runId }]. Checks outside Actions
// have no run to read and are left out.
export function failedChecks(checks) {
  return checks
    .filter((c) => c.bucket === "fail")
    .map((c) => ({ name: c.name, runId: c.link?.match(/\/actions\/runs\/(\d+)/)?.[1] ?? null }))
    .filter((c) => c.runId);
}

// The failing step of a failed run's log, as a message for the agent working on the branch.
// `gh run view --log-failed` gives every step of a failed job, clean-up included: the step
// that failed runs from its last "##[group]Run" marker to the "##[error]" line.
const LOG_LINES = 120;
const HEAD_LINES = 20;
export function failingStep(log) {
  const lines = log.trimEnd().split("\n")
    // Each line is "job<TAB>step<TAB>timestamp message": keep the message.
    .map((line) => (line.split("\t").length >= 3 ? line.split("\t").slice(2).join("\t") : line))
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "").replace(/\u001b\[[0-9;]*m/g, "").replace(/\^\[\[[0-9;]*m/g, ""));
  const error = lines.findLastIndex((line) => line.includes("##[error]"));
  const end = error >= 0 ? error + 1 : lines.length;
  const start = Math.max(0, lines.slice(0, end).findLastIndex((line) => line.startsWith("##[group]Run ")));
  const step = lines.slice(start, end);
  if (step.length <= LOG_LINES) return step.join("\n");
  return [...step.slice(0, HEAD_LINES), `… ${step.length - LOG_LINES} lines …`, ...step.slice(-(LOG_LINES - HEAD_LINES))].join("\n");
}

export function ciPrompt(number, failed, log) {
  const names = failed.map((c) => c.name).join(", ");
  return [
    `CI is failing on pull request #${number} (${names}).`,
    "The failing step of the job's log:",
    "```",
    failingStep(log),
    "```",
    "Find the cause in this branch, fix it, and push.",
  ].join("\n");
}
