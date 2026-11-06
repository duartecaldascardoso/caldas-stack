// The sidebar's file tree and size bars. Pure.

export const STATUS = { new: "A", deleted: "D", change: "M", "rename-pure": "R", "rename-changed": "R" };

// Folders first, then files, by name; a folder holding only one folder shows as one row
// ("src/lib"). Rows: { kind: "dir", path, name, depth, add, del, open } and
// { kind: "file", id, name, depth, status, add, del }. `closed` holds folder paths folded shut.
export function treeRows(files, closed = new Set()) {
  const root = { dirs: new Map(), files: [], add: 0, del: 0 };
  for (const file of files) {
    const parts = file.name.split("/");
    let node = root;
    node.add += file.add;
    node.del += file.del;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [], add: 0, del: 0 });
      node = node.dirs.get(part);
      node.add += file.add;
      node.del += file.del;
    }
    node.files.push({ file, name: parts.at(-1) });
  }

  const rows = [];
  const walk = (node, prefix, depth) => {
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let label = name;
      let dir = child;
      while (dir.dirs.size === 1 && !dir.files.length) {
        const [[only, inner]] = dir.dirs;
        label += `/${only}`;
        dir = inner;
      }
      const path = prefix + label;
      const open = !closed.has(path);
      rows.push({ kind: "dir", path, name: label, depth, add: dir.add, del: dir.del, open });
      if (open) walk(dir, `${path}/`, depth + 1);
    }
    for (const { file, name } of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
      rows.push({ kind: "file", id: file.id, name, depth, status: STATUS[file.type] ?? "M", add: file.add, del: file.del });
    }
  };
  walk(root, "", 0);
  return rows;
}

const BOXES = 5;

// How many squares of a size bar to fill green, red and grey, like GitHub's diffstat. Size
// is on a log scale against the biggest in view, so one huge file doesn't flatten the rest.
export function diffstat(add, del, max) {
  const size = add + del;
  if (!size) return { add: 0, del: 0, empty: BOXES };
  const filled = Math.min(BOXES, Math.max(1, Math.ceil((BOXES * Math.log(size + 1)) / Math.log(max + 1))));
  let green = Math.round((filled * add) / size);
  if (add && !green && filled > 1) green = 1;
  if (del && green === filled && filled > 1) green--;
  return { add: green, del: filled - green, empty: BOXES - filled };
}

// Every term must match: a fuzzy path match, or is:<kind> (code, tests, config, ci, docs).
export function fileMatches(file, filter) {
  return filter.trim().split(/\s+/).filter(Boolean).every((term) =>
    term.startsWith("is:") ? kindOf(file) === term.slice(3).toLowerCase() : fuzzy(file.name.toLowerCase(), term.toLowerCase()));
}

function fuzzy(text, query) {
  let i = 0;
  for (const ch of text) if (ch === query[i]) i++;
  return i === query.length;
}

export function kindOf(file) {
  const path = file.name.toLowerCase();
  if (/(^|\/)\.github\/|\.gitlab-ci|jenkinsfile|(^|\/)\.circleci\//.test(path)) return "ci";
  if (/(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|_test\.go$|(^|\/)test_[^/]+\.py$/.test(path)) return "tests";
  if (/\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\//.test(path)) return "docs";
  if (/\.(json|ya?ml|toml|ini|cfg|conf|lock)$|(^|\/)(\.[^/]+rc|dockerfile|makefile)$|\.config\.[a-z]+$/.test(path)) return "config";
  return "code";
}

export const KINDS = [["code", "Code"], ["tests", "Tests"], ["config", "Config"], ["ci", "CI"], ["docs", "Docs"]];

// Added and removed lines per kind, in KINDS order, leaving out kinds with no files.
export function breakdown(files) {
  const by = new Map();
  for (const file of files) {
    const kind = by.get(kindOf(file)) ?? { add: 0, del: 0 };
    kind.add += file.add;
    kind.del += file.del;
    by.set(kindOf(file), kind);
  }
  return KINDS.filter(([id]) => by.has(id)).map(([id, label]) => ({ id, label, ...by.get(id) }));
}
