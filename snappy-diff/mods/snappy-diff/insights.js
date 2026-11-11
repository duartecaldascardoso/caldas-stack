// The diff at a glance, for the overview: where the changes are, how long they take to read,
// what deserves a closer look, and an order to review them in. Pure.
import { kindOf } from "./tree.js";

// Changes grouped by the next folder below `prefix`; files directly in it group as themselves.
// [{ path, name, add, del, files, viewed, deeper }], biggest first.
export function areas(files, prefix, isViewed) {
  const out = new Map();
  for (const file of files) {
    if (!file.name.startsWith(prefix)) continue;
    const rest = file.name.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    const path = prefix + name + (slash < 0 ? "" : "/");
    const area = out.get(path) ?? { path, name, add: 0, del: 0, files: 0, viewed: 0, deeper: slash >= 0 };
    area.add += file.add;
    area.del += file.del;
    area.files++;
    if (isViewed(file)) area.viewed++;
    out.set(path, area);
  }
  return [...out.values()].sort((a, b) => b.add + b.del - (a.add + a.del));
}

// A reviewer reads roughly this many changed lines an hour, carefully.
const LINES_PER_HOUR = 400;

// Lines that need reading: not generated, not pure renames, not moved.
export function effort(files, moves, isViewed) {
  let lines = 0;
  let skipped = 0;
  let viewedLines = 0;
  for (const file of files) {
    const size = file.add + file.del;
    if (file.generated || file.type === "rename-pure") { skipped += size; continue; }
    const own = Math.max(0, size - (moves.perFile.get(file.id) ?? 0));
    lines += own;
    if (isViewed(file)) viewedLines += own;
  }
  const moved = [...moves.perFile.values()].reduce((n, v) => n + v, 0);
  return { lines, skipped, moved, viewedLines, minutes: Math.max(1, Math.round((lines / LINES_PER_HOUR) * 60)) };
}

const DEPENDENCIES = /(^|\/)(package\.json|Cargo\.toml|go\.mod|pyproject\.toml|requirements[^/]*\.txt|Gemfile|pom\.xml|build\.gradle(\.kts)?|composer\.json|mix\.exs|Package\.swift)$/;
const SENSITIVE = /(auth|secur|crypt|password|secret|token|permission|session|oauth|\.env)/i;

// Things worth a closer look, each with the files behind it: [{ id, label, detail, files }].
export function hints(files, churn) {
  const out = [];
  const add = (id, label, detail, matched) => { if (matched.length) out.push({ id, label, detail, files: matched }); };
  const by = (test) => files.filter(test);
  add("deps", "Dependencies changed", "Manifests that add, remove or bump packages", by((f) => DEPENDENCIES.test(f.name)));
  add("ci", "CI or automation changed", "Workflows run with repository permissions", by((f) => kindOf(f) === "ci"));
  add("sensitive", "Security-sensitive paths", "Auth, secrets, tokens or permissions in the path", by((f) => SENSITIVE.test(f.name)));
  add("deleted", "Files deleted", "Make sure nothing still depends on them", by((f) => f.type === "deleted"));
  add("large", "Very large files", "Over 500 changed lines; consider splitting", by((f) => !f.generated && f.add + f.del > 500));
  add("churn", "Reworked across commits", "Changed in three or more commits of the range", by((f) => (churn.get(f.name) ?? 0) >= 3));
  const code = files.filter((f) => kindOf(f) === "code").reduce((n, f) => n + f.add, 0);
  if (code > 50 && !files.some((f) => kindOf(f) === "tests")) {
    out.push({ id: "tests", label: "No test changes", detail: `${code} lines of code added, no tests touched`, files: [] });
  }
  return out;
}

const RANK = { code: 2, tests: 1, config: 3, ci: 3, docs: 4 };
const CONTRACT = /(^|\/)(types?|interfaces?|schemas?|api|proto|migrations?)(\/|\.)|\.d\.ts$|\.(proto|graphql|sql)$/;

// Review order: contracts first, then tests, code, config and docs; generated files last.
export function reviewOrder(files) {
  const rank = (f) => (f.generated ? 5 : CONTRACT.test(f.name) ? 0 : RANK[kindOf(f)]);
  return files.map((f, i) => ({ f, i, r: rank(f) })).sort((a, b) => a.r - b.r || a.i - b.i).map(({ f }) => f);
}

// Open pull requests for go-to, from `gh pr list --json number,title,author,isDraft,reviewRequests`:
// the ones asking for your review first, then the rest, drafts last; each { number, title, hint }.
export function pullRequestList(prs, me) {
  const asked = (pr) => (pr.reviewRequests ?? []).some((r) => r.login && r.login === me);
  const rank = (pr) => (asked(pr) ? 0 : pr.isDraft ? 2 : 1);
  return prs
    .map((pr, i) => ({ pr, i }))
    .sort((a, b) => rank(a.pr) - rank(b.pr) || a.i - b.i)
    .map(({ pr }) => ({
      number: pr.number,
      title: pr.title,
      hint: [asked(pr) ? "your review" : pr.isDraft ? "draft" : null, pr.author?.login === me ? "yours" : pr.author?.login && `@${pr.author.login}`].filter(Boolean).join(" · "),
    }));
}
