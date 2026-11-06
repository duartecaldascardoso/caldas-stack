// Parses `git diff` output into files and hunks. Pure: no Herdr imports, tested with node.

const GENERATED =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|Pipfile\.lock|flake\.lock)$|\.(min\.(js|css)|map|snap)$/;

// Big enough that rendering it is rarely what you want first.
const LARGE_LINES = 2000;
const TAB = "    ";

// FNV-1a: enough to tell contents apart, and fast.
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const exists = (oid) => Boolean(oid) && !/^0+$/.test(oid);

// git quotes paths with unusual characters: "a/caf\303\251.txt".
function unquote(path) {
  if (!path.startsWith('"')) return path;
  const bytes = [];
  const body = path.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") { bytes.push(...new TextEncoder().encode(body[i])); continue; }
    const next = body[++i];
    if (/[0-7]/.test(next)) { bytes.push(parseInt(body.slice(i, i + 3), 8)); i += 2; }
    else bytes.push({ n: 10, t: 9, r: 13, '"': 34, "\\": 92 }[next] ?? next.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const stripPrefix = (path) => (path === "/dev/null" ? null : path.replace(/^[ab]\//, ""));

// "diff --git a/x b/x": the two names, when they aren't quoted with spaces in them.
function namesFromHeader(line) {
  const rest = line.slice("diff --git ".length);
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/);
  if (quoted) return [stripPrefix(unquote(quoted[1])), stripPrefix(unquote(quoted[2]))];
  const half = rest.match(/^a\/(.*) b\/(.*)$/);
  if (half && half[1] === half[2]) return [half[1], half[2]];
  const split = rest.indexOf(" b/");
  return split < 0 ? [null, null] : [stripPrefix(rest.slice(0, split)), stripPrefix(rest.slice(split + 1))];
}

function newFile(header) {
  const [prev, next] = namesFromHeader(header);
  return {
    name: next ?? prev ?? "", prevName: prev, type: "change", binary: false,
    oldOid: null, newOid: null, hunks: [], add: 0, del: 0,
  };
}

function finish(file, seen, rev) {
  if (file.type === "rename") file.type = file.hunks.length || file.binary ? "rename-changed" : "rename-pure";
  else file.prevName = null;
  const n = seen.get(file.name) ?? 0;
  seen.set(file.name, n + 1);
  file.id = n ? `${file.name}#${n}` : file.name;
  file.generated = GENERATED.test(file.name);
  file.large = file.add + file.del > LARGE_LINES;
  file.signature = exists(file.newOid) ? file.newOid
    : exists(file.oldOid) ? `deleted:${file.oldOid}`
    : hash(file.hunks.map((h) => h.lines.map((l) => l.kind + l.text).join("\n")).join("\n")).toString(36);
  file.rev = rev;
  return file;
}

// `previous` files whose contents are unchanged are kept as they were, so a live refresh
// only rebuilds what changed. `rev` identifies the load the new ones came from.
export function parsePatch(text, rev = 0, previous = []) {
  const files = [];
  const seen = new Map();
  let file = null;
  let hunk = null;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      if (file) files.push(finish(file, seen, rev));
      file = newFile(raw);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (hunk) {
      // Editors and mail clients strip the space from blank context lines.
      const kind = raw === "" && hunk.oldLeft > 0 && hunk.newLeft > 0 ? " " : raw[0];
      if (kind === "\\") continue; // "\ No newline at end of file"
      if ((kind === " " || kind === "-") && hunk.oldLeft > 0 || (kind === " " || kind === "+") && hunk.newLeft > 0) {
        hunk.lines.push({ kind, text: raw.slice(1).replaceAll("\t", TAB) });
        if (kind !== "+") hunk.oldLeft--;
        if (kind !== "-") hunk.newLeft--;
        if (kind === "+") file.add++;
        if (kind === "-") file.del++;
        continue;
      }
      hunk = null;
    }
    const range = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
    if (range) {
      hunk = {
        oldStart: +range[1], oldCount: range[2] == null ? 1 : +range[2],
        newStart: +range[3], newCount: range[4] == null ? 1 : +range[4],
        context: range[5], lines: [],
      };
      hunk.oldLeft = hunk.oldCount;
      hunk.newLeft = hunk.newCount;
      file.hunks.push(hunk);
    } else if (raw.startsWith("new file mode")) file.type = "new";
    else if (raw.startsWith("deleted file mode")) file.type = "deleted";
    else if (raw.startsWith("rename from ")) { file.type = "rename"; file.prevName = unquote(raw.slice(12)); }
    else if (raw.startsWith("rename to ")) file.name = unquote(raw.slice(10));
    else if (raw.startsWith("index ")) {
      const oids = raw.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/);
      if (oids) { file.oldOid = oids[1]; file.newOid = oids[2]; }
    } else if (raw.startsWith("Binary files ") || raw === "GIT binary patch") file.binary = true;
  }
  if (file) files.push(finish(file, seen, rev));

  const before = new Map(previous.map((f) => [f.id, f]));
  return files.map((f) => (before.get(f.id)?.signature === f.signature ? before.get(f.id) : f));
}

// Untracked files, as a patch adding them, so new files show next to the edits.
export function untrackedPatch(files) {
  let out = "";
  for (const { path, text } of files) {
    out += `diff --git a/${path} b/${path}\nnew file mode 100644\n`;
    if (text == null) { out += `Binary files /dev/null and b/${path} differ\n`; continue; }
    if (!text) continue;
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    out += `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => `+${l}\n`).join("");
  }
  return out;
}

// The first changed line on the new side: where opening a file should land.
export function firstChange(file) {
  for (const hunk of file.hunks) {
    let n = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.kind === "+") return n;
      if (line.kind !== "-") n++;
    }
  }
  return file.hunks[0]?.newStart ?? 1;
}

// Files too large to diff, listed so the count and the tree stay true.
export function skippedFiles(skipped, rev = 0) {
  return skipped.map(({ path, add, del }) => ({
    id: path, name: path, prevName: null, type: "change", binary: false, tooLarge: true,
    oldOid: null, newOid: null, hunks: [], add, del, generated: false, large: true,
    signature: `large:${add}:${del}:${hash(path)}`, rev,
  }));
}
