// The git a board needs: which project a folder is in, and a checkout for a card's branch.
import { exec, home } from "herdr";
import { boardName } from "./board.js";
import { worktreePath, checkoutOf } from "./work.js";

const git = (repo, args) => exec("git", ["-C", repo, ...args]).catch(() => null);
const ok = (result) => result?.code === 0;
const out = (result) => (ok(result) ? result.stdout.trim() : "");

// The project a folder is in: { name, root }, its board's name and folder. A worktree belongs to
// its repository, so the root is the main checkout's. Null at home and at /.
export async function projectOf(cwd) {
  if (!cwd) return null;
  const common = out(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const root = common.endsWith("/.git") ? common.slice(0, -5) : out(await git(cwd, ["rev-parse", "--show-toplevel"])) || cwd;
  if (root === home() || root === "/") return null;
  return { name: boardName(root.split("/").pop()), root };
}

// Whether folder is a repository's top folder, not just inside one.
export const isRepository = async (folder) => out(await git(folder, ["rev-parse", "--show-toplevel"])) === folder;

export const currentBranch = async (repo) => out(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]));

// The branch pull requests go into: origin's default, else HEAD.
export const baseBranch = async (repo) => out(await git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])) || "HEAD";

// How many commits branch has that its base hasn't, or null.
export async function commitsAhead(repo, branch) {
  const count = await git(repo, ["rev-list", "--count", `${await baseBranch(repo)}..${branch}`]);
  return ok(count) ? Number(count.stdout.trim()) : null;
}

// Pushes branch to origin, tracking it: null, or what went wrong.
export async function push(repo, branch) {
  const pushed = await git(repo, ["push", "-u", "origin", branch]);
  return ok(pushed) ? null : lastLine(pushed?.stderr);
}

// The folder checked out on branch: an existing checkout, else a new worktree in Herdr's layout,
// made from origin's branch (a pull request opened elsewhere) or, for a new branch, from the
// base. { folder } or { error }.
export async function checkout(repo, branch) {
  const folder = checkoutOf(out(await git(repo, ["worktree", "list", "--porcelain"])), branch);
  if (folder) return { folder };
  const path = worktreePath(home(), repo, branch);
  const exists = async (ref) => ok(await git(repo, ["rev-parse", "--verify", "--quiet", ref]));
  const local = await exists(`refs/heads/${branch}`);
  if (!local) await git(repo, ["fetch", "--quiet", "origin", branch]);
  const remote = !local && (await exists(`refs/remotes/origin/${branch}`));
  const made = await git(repo, local ? ["worktree", "add", path, branch]
    : remote ? ["worktree", "add", "-b", branch, path, `origin/${branch}`]
    : ["worktree", "add", "-b", branch, path, await baseBranch(repo)]);
  return ok(made) ? { folder: path } : { error: lastLine(made?.stderr) };
}

export const lastLine = (text) => (text ?? "").trim().split("\n").pop();
