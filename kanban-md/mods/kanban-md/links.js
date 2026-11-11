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
