// What a review keeps: viewed files and line comments. Pure.

// Identifies what is under review, so progress and comments come back with it.
export function reviewKey(source) {
  return `${source.repo}:${source.base}...${source.head || "worktree"}${source.commit ? `@${source.commit}` : ""}`;
}

export const emptyReview = () => ({ viewed: {}, comments: [] });

// The range whose head you review commit by commit: a branch, not the working tree or one commit.
export const rangeKey = (source) => (source.head && !source.commit ? `${source.repo}:${source.base}...${source.head}` : null);

// New commits on top of the tip you last reviewed: commits are newest first, so the reviewed
// tip's position is how many are new. Null when there are none, or it isn't in the range.
export function sinceReview(lastSha, commits) {
  const newer = lastSha ? commits.findIndex((c) => c.sha === lastSha) : -1;
  return newer > 0 ? { sha: lastSha, count: newer } : null;
}

// Viewed holds the signature a file had when marked, so it unmarks itself once the file changes.
export const isViewed = (review, file) => review.viewed[file.id] === file.signature;
export const changedSinceViewed = (review, file) => file.id in review.viewed && review.viewed[file.id] !== file.signature;

export function toggleViewed(review, file) {
  const viewed = { ...review.viewed };
  if (viewed[file.id] === file.signature) delete viewed[file.id];
  else viewed[file.id] = file.signature;
  return { ...review, viewed };
}

// The text of lines start..end on one side of a file, or null if the diff lacks any of them.
export function linesText(file, side, start, end) {
  const lines = new Map();
  for (const hunk of file.hunks) {
    let n = side === "new" ? hunk.newStart : hunk.oldStart;
    for (const line of hunk.lines) {
      if (side === "new" ? line.kind === "-" : line.kind === "+") continue;
      lines.set(n++, line.text);
    }
  }
  const out = [];
  for (let n = start; n <= end; n++) {
    if (!lines.has(n)) return null;
    out.push(lines.get(n));
  }
  return out.join("\n");
}

// A comment: { id, file, side: "old" | "new", start, end, text, code }. `code` is the text it
// was left on; when that is gone from the diff the comment is outdated (most likely addressed).
export function withStatus(comments, files) {
  const byId = new Map(files.map((f) => [f.id, f]));
  return comments.map((c) => {
    const file = byId.get(c.file);
    const outdated = !file || (c.code != null && linesText(file, c.side, c.start, c.end) !== c.code);
    return { ...c, outdated };
  });
}

// The comments as a prompt for a coding agent: one numbered item per comment, pointing at
// `path:line`, with the code and the ask. `subject` names what was reviewed.
export function reviewPrompt(subject, comments, files) {
  const order = new Map(files.map((f, i) => [f.id, i]));
  const byId = new Map(files.map((f) => [f.id, f]));
  const open = comments.filter((c) => !c.outdated)
    .sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0) || a.end - b.end);
  const out = [
    `Please address these review comments on ${subject}.`,
    "Each one gives the file and lines, the code it refers to, and what to change.",
  ];
  open.forEach((c, i) => {
    const file = byId.get(c.file);
    const path = file?.name ?? c.file;
    const lines = c.start === c.end ? `${c.end}` : `${c.start}-${c.end}`;
    const removed = c.side === "old" ? " (removed lines; numbers are from before the change)" : "";
    out.push("", `${i + 1}. \`${path}:${lines}\`${removed}`);
    const code = file && linesText(file, c.side, c.start, c.end);
    if (code) out.push("```" + path.split(".").pop(), code, "```");
    out.push(c.text);
  });
  return out.join("\n");
}
