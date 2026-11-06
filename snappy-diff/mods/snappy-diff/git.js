// The git CLI, as snappy-diff's server runs it. Shelling out is as fast as git itself.
import { exec, readTextFile } from "herdr";
import { untrackedPatch } from "./patch.js";

// Reads that write nothing under .git: no index refresh, no lock, no fsmonitor cookie.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const DIFF = ["--no-color", "--no-ext-diff", "--full-index", "-M"];
// Untracked files past these limits are listed as binary rather than read.
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_BYTES = 1 << 20;
// Files changing more lines than this are listed, not diffed: a staged PDF or a dump can
// run to millions of lines, past what one command may print.
const MAX_FILE_LINES = 20000;

async function git(repo, args) {
  const result = await exec("git", ["-C", repo, ...READ, ...args]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

async function line(repo, args) {
  const out = await git(repo, args).catch(() => "");
  return out.trim() || null;
}

const isOption = (ref) => ref?.startsWith("-");

// git's empty tree: the base for a repository with no commits yet, where everything is new.
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export const hasCommits = async (repo) => Boolean(await line(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]));

export const toplevel = (dir) => line(dir, ["rev-parse", "--show-toplevel"]);

export const currentBranch = async (repo) => (await line(repo, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? "HEAD";

// The branch a pull request would most likely target.
export async function defaultBase(repo) {
  if (!(await hasCommits(repo))) return EMPTY_TREE;
  const remote = await line(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remote) return remote;
  for (const candidate of ["main", "master"]) {
    if (await line(repo, ["rev-parse", "--verify", "--quiet", candidate])) return candidate;
  }
  return "HEAD";
}

export const isDirty = async (repo) => Boolean(await line(repo, ["status", "--porcelain", "--untracked-files=normal"]));

// Branches, remote branches and tags, most recently committed first.
export async function refs(repo) {
  const out = await git(repo, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"]).catch(() => "");
  return out.split("\n").filter((r) => r && !r.endsWith("/HEAD")).map((r) => r.split("/").slice(2).join("/"));
}

// Commits in base..head, newest first, with lines added and removed.
export async function commits(repo, base, head) {
  if (!head || base === EMPTY_TREE || isOption(base) || isOption(head)) return [];
  const out = await git(repo, ["log", "--format=%x1e%H%x1f%s%x1f%an%x1f%ar", "--numstat", "--max-count=500", `${base}..${head}`, "--"]).catch(() => "");
  return out.split("\x1e").filter(Boolean).map((record) => {
    const [first, ...stats] = record.split("\n");
    const [sha, subject, author, date] = first.split("\x1f");
    let add = 0;
    let del = 0;
    for (const stat of stats) {
      const [a, d] = stat.split("\t");
      if (/^\d+$/.test(a) && /^\d+$/.test(d)) { add += +a; del += +d; }
    }
    return { sha, subject, author, date, add, del };
  });
}

// The patch for a source: one commit, base...head like a pull request, or, with no head,
// the working tree against where it forked from base, untracked files included.
// Returns { text, skipped }: skipped files are too large to diff, with their line counts.
export async function diff({ repo, base, head, commit, ignoreWhitespace }) {
  const whitespace = ignoreWhitespace ? ["-w"] : [];
  let command;
  if (commit) {
    if (isOption(commit)) throw new Error("invalid commit");
    command = ["show", "--format=", "--diff-merges=first-parent", ...whitespace, commit];
  } else {
    if (isOption(base) || isOption(head)) throw new Error("invalid ref");
    // The empty tree has no history to fork from: compare against it directly.
    const range = head ? [`${base}...${head}`] : base === EMPTY_TREE ? [base] : ["--merge-base", base];
    command = ["diff", ...whitespace, ...range];
  }
  const stats = await git(repo, [...command, "--numstat", "-z", "-M", "--"]);
  const skipped = numstat(stats).filter((f) => f.add + f.del > MAX_FILE_LINES);
  const excludes = skipped.map((f) => `:(exclude,literal)${f.path}`);
  const [text, untracked] = await Promise.all([
    git(repo, [...command, ...DIFF, "--", ...(excludes.length ? [".", ...excludes] : [])]),
    head || commit ? [] : untrackedFiles(repo),
  ]);
  return { text: text + untrackedPatch(untracked), skipped };
}

// `--numstat -z`: "add\tdel\tpath\0", or for a rename "add\tdel\t\0from\0to\0".
function numstat(out) {
  const parts = out.split("\0");
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) continue;
    const path = m[3] || (i += 2, parts[i]);
    files.push({ path, add: m[1] === "-" ? 0 : +m[1], del: m[2] === "-" ? 0 : +m[2] });
  }
  return files;
}

async function untrackedFiles(repo) {
  const list = await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]).catch(() => "");
  const paths = list.split("\0").filter(Boolean).slice(0, MAX_UNTRACKED_FILES);
  return Promise.all(paths.map(async (path) => {
    const text = await readTextFile(`${repo}/${path}`).catch(() => null);
    const binary = text == null || text.length > MAX_UNTRACKED_BYTES || text.slice(0, 8000).includes("\0");
    return { path, text: binary ? null : text };
  }));
}

// Pull requests, through the GitHub CLI. Null when gh is missing, signed out, or there is none.
export async function pullRequest(repo, number) {
  const args = ["pr", "view", ...(number ? [String(number)] : []), "--json", "number,title,url,baseRefName,headRefName,headRefOid"];
  const result = await exec("gh", args, { cwd: repo }).catch(() => null);
  if (result?.code !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

// Fetches a pull request's head and base, so it can be reviewed without checking it out.
export async function fetchPullRequest(repo, pr) {
  const head = `origin/pr/${pr.number}`;
  const result = await exec("git", ["-C", repo, "fetch", "--quiet", "origin",
    `+pull/${pr.number}/head:refs/remotes/${head}`, `+${pr.baseRefName}:refs/remotes/origin/${pr.baseRefName}`]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `couldn't fetch #${pr.number}`);
  return { base: `origin/${pr.baseRefName}`, head };
}

// A file's text on the new side of the diff, for expanding the lines a separator hides:
// its blob when git has one, otherwise (uncommitted) what is on disk.
export async function fileText(repo, file, worktree) {
  if (file.newOid && !/^0+$/.test(file.newOid)) {
    const result = await exec("git", ["-C", repo, ...READ, "cat-file", "blob", file.newOid]);
    if (result.code === 0) return result.stdout;
  }
  return worktree ? readTextFile(`${repo}/${file.name}`) : null;
}
