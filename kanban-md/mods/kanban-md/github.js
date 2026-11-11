// GitHub through the gh CLI, signed in on its own: what a card's numbers are, pull requests,
// issues and failed checks. Each call runs in the board's repository.
import { exec } from "herdr";
import { prStatus, issueStatus, numberFromUrl, failedChecks } from "./links.js";
import { lastLine } from "./git.js";

const gh = (repo, args) => exec("gh", args, { cwd: repo }).catch(() => null);
const ok = (result) => result?.code === 0;

function json(result) {
  if (!ok(result)) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

// What GitHub says about each number, [[n, kind]] with the kind the card gave it, if any: a pull
// request, else an issue. A Map of n -> prStatus or issueStatus, for the numbers gh knows.
export async function statusesOf(repo, refs) {
  const statuses = new Map();
  await Promise.all(refs.map(async ([n, kind]) => {
    const pr = kind === "issue" ? null : json(await gh(repo, ["pr", "view", String(n), "--json", "state,isDraft,reviewDecision,statusCheckRollup,headRefName,mergeable"]));
    const issue = pr || kind === "pr" ? null : json(await gh(repo, ["issue", "view", String(n), "--json", "state,stateReason,url"]));
    const status = pr ? prStatus(pr) : issue ? issueStatus(issue) : null;
    if (status) statuses.set(n, status);
  }));
  return statuses;
}

// The pull request of the repository's current branch, or null.
export async function currentPullRequest(repo) {
  const view = await gh(repo, ["pr", "view", "--json", "number", "-q", ".number"]);
  return (ok(view) && Number(view.stdout.trim())) || null;
}

// The latest pull request from branch, open or not, or null.
export async function pullRequestFrom(repo, branch) {
  const list = await gh(repo, ["pr", "list", "--head", branch, "--state", "all", "--json", "number", "-q", ".[0].number"]);
  return (ok(list) && Number(list.stdout.trim())) || null;
}

// Opens a pull request from an already pushed branch: { number } or { error }.
export async function createPullRequest(repo, branch, title, body) {
  const create = await gh(repo, ["pr", "create", "--head", branch, "--title", title, "--body", body]);
  const number = ok(create) && numberFromUrl(create.stdout);
  return number ? { number } : { error: lastLine(create?.stderr) };
}

// The repository's open issues, [{ number, title }], or null when gh can't list them.
export const openIssues = async (repo) => json(await gh(repo, ["issue", "list", "--state", "open", "--limit", "200", "--json", "number,title"]));

export const showIssue = (repo, n) => gh(repo, ["issue", "view", String(n), "--web"]);

// The failing GitHub Actions checks of pull request n and the log of the first one's failed job:
// { failed, log }, { failed: [] } when none runs on Actions, or { error } when gh can't read the log.
export async function failedRun(repo, n) {
  // gh exits non-zero when checks fail, so the output is read whatever the exit code.
  const checks = await gh(repo, ["pr", "checks", String(n), "--json", "name,bucket,link"]);
  let failed = [];
  try { failed = failedChecks(JSON.parse(checks?.stdout || "[]")); } catch { /* not JSON */ }
  if (!failed.length) return { failed };
  const log = await gh(repo, ["run", "view", failed[0].runId, "--log-failed"]);
  if (!ok(log)) return { error: lastLine(log?.stderr) };
  return { failed, log: log.stdout };
}
