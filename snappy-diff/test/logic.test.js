import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePatch, untrackedPatch, firstChange } from "../mods/snappy-diff/patch.js";
import { wordDiff } from "../mods/snappy-diff/words.js";
import { languageOf, highlight } from "../mods/snappy-diff/syntax.js";
import { fileRows, wrapCount, wrapLines, segments } from "../mods/snappy-diff/rows.js";
import { treeRows, diffstat, fileMatches, kindOf } from "../mods/snappy-diff/tree.js";
import { toggleViewed, isViewed, emptyReview, linesText, withStatus, reviewPrompt } from "../mods/snappy-diff/review.js";

const PATCH = `diff --git a/src/app.js b/src/app.js
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/src/app.js
+++ b/src/app.js
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;

 export { a };
@@ -10,2 +11,2 @@ function tail() {
-  return old;
+  return next;
 }
diff --git a/new.md b/new.md
new file mode 100644
index 0000000000000000000000000000000000000000..3333333333333333333333333333333333333333
--- /dev/null
+++ b/new.md
@@ -0,0 +1,2 @@
+# Title
+Body
\\ No newline at end of file
diff --git a/old.txt b/renamed.txt
similarity index 100%
rename from old.txt
rename to renamed.txt
diff --git a/logo.png b/logo.png
index 4444444444444444444444444444444444444444..5555555555555555555555555555555555555555 100644
Binary files a/logo.png and b/logo.png differ
`;

test("parsePatch reads files, types, hunks and counts", () => {
  const files = parsePatch(PATCH);
  assert.deepEqual(files.map((f) => [f.name, f.type, f.add, f.del]), [
    ["src/app.js", "change", 3, 2],
    ["new.md", "new", 2, 0],
    ["renamed.txt", "rename-pure", 0, 0],
    ["logo.png", "change", 0, 0],
  ]);
  const [app, md, renamed, logo] = files;
  assert.equal(app.hunks.length, 2);
  assert.equal(app.hunks[1].context, "function tail() {");
  assert.deepEqual(app.hunks[0].lines.map((l) => l.kind).join(""), " -++  ");
  assert.equal(md.hunks[0].lines.length, 2);
  assert.equal(renamed.prevName, "old.txt");
  assert.equal(logo.binary, true);
  assert.equal(app.signature, "2222222222222222222222222222222222222222");
});

test("parsePatch keeps unchanged files from the previous load", () => {
  const first = parsePatch(PATCH, 1);
  const second = parsePatch(PATCH, 2, first);
  assert.equal(second[0], first[0]);
  assert.equal(second[0].rev, 1);
});

test("parsePatch numbers files that appear twice and unquotes odd paths", () => {
  const twice = parsePatch(PATCH + PATCH);
  assert.equal(twice[4].id, "src/app.js#1");
  const quoted = parsePatch(`diff --git "a/caf\\303\\251 x.txt" "b/caf\\303\\251 x.txt"\nnew file mode 100644\n`);
  assert.equal(quoted[0].name, "café x.txt");
});

test("untrackedPatch adds new files as a patch git would print", () => {
  const files = parsePatch(untrackedPatch([{ path: "a.txt", text: "one\ntwo\n" }, { path: "b.bin", text: null }]));
  assert.deepEqual(files.map((f) => [f.name, f.type, f.add, f.binary]), [["a.txt", "new", 2, false], ["b.bin", "new", 0, true]]);
});

test("firstChange is the first added line", () => {
  assert.equal(firstChange(parsePatch(PATCH)[0]), 2);
});

test("wordDiff marks only the tokens that changed", () => {
  assert.deepEqual(wordDiff("const b = 2;", "const b = 3;"), { before: [[10, 11]], after: [[10, 11]] });
  assert.equal(wordDiff("alpha beta", "gamma delta"), null);
});

test("highlight finds keywords, strings, numbers, comments and calls", () => {
  const [line] = highlight(languageOf("x.ts"), ['const x = run("a", 42) // done']);
  const kinds = Object.fromEntries(line.filter((t) => t.kind).map((t) => [t.text.trim(), t.kind]));
  assert.equal(kinds.const, "keyword");
  assert.equal(kinds.run, "function");
  assert.equal(kinds['"a"'], "string");
  assert.equal(kinds["42"], "number");
  assert.equal(kinds["// done"], "comment");
});

test("highlight carries block comments and multi-line strings across lines", () => {
  const lines = highlight(languageOf("x.c"), ["a /* open", "still", "done */ b"]);
  assert.deepEqual(lines[1], [{ text: "still", kind: "comment" }]);
  assert.equal(lines[2][0].text, "done */");
  const py = highlight(languageOf("x.py"), ['x = """doc', 'more', '"""']);
  assert.equal(py[1][0].kind, "string");
});

test("highlight marks keys in data files and leaves unknown files plain", () => {
  const [json] = highlight(languageOf("a.json"), ['"name": "x"']);
  assert.equal(json[0].kind, "property");
  assert.equal(json.at(-1).kind, "string");
  assert.deepEqual(highlight(null, ["plain"]), [[{ text: "plain", kind: null }]]);
});

test("fileRows pairs removed and added lines side by side", () => {
  const app = parsePatch(PATCH)[0];
  const rows = fileRows(app, "split", languageOf(app.name));
  assert.deepEqual(rows.map((r) => r.t), ["split", "split", "split", "split", "split", "hunk", "split", "split"]);
  const changed = rows[1];
  assert.equal(changed.left.text, "const b = 2;");
  assert.equal(changed.right.text, "const b = 3;");
  assert.deepEqual(changed.right.marks, [[10, 11]]);
  assert.equal(rows[2].left, null);
  assert.equal(rows[2].right.n, 3);
  assert.equal(rows[5].hidden, 5);
});

test("fileRows in unified style lists removals before additions", () => {
  const rows = fileRows(parsePatch(PATCH)[0], "unified", null).filter((r) => r.t === "unified");
  assert.deepEqual(rows.slice(0, 4).map((r) => [r.old, r.new, r.cell.kind]), [[1, 1, "ctx"], [2, null, "del"], [null, 2, "add"], [null, 3, "add"]]);
});

test("fileRows explains files without lines", () => {
  const files = parsePatch(PATCH);
  assert.equal(fileRows(files[2], "split", null)[0].text, "Renamed from old.txt, unchanged");
  assert.equal(fileRows(files[3], "split", null)[0].text, "Binary file not shown");
});

test("segments splits a wrapped slice by token and word change", () => {
  const cell = { text: "const b = 3;", tokens: [{ text: "const", kind: "keyword" }, { text: " b = 3;", kind: null }], marks: [[10, 11]] };
  assert.deepEqual(segments(cell, 4, 12), [
    { text: "t", kind: "keyword", marked: false },
    { text: " b = ", kind: null, marked: false },
    { text: "3", kind: null, marked: true },
    { text: ";", kind: null, marked: false },
  ]);
  assert.equal(wrapCount("x".repeat(25), 10), 3);
  assert.equal(wrapCount("", 10), 1);
});

test("wrapLines breaks after the last space that fits, and inside words only when it must", () => {
  const text = "# The repository has to allow";
  assert.deepEqual(wrapLines(text, 12).map(([a, b]) => text.slice(a, b)), ["# The ", "repository ", "has to allow"]);
  assert.deepEqual(wrapLines("abcdefghij", 4), [[0, 4], [4, 8], [8, 10]]);
  // Indentation is not a place to break: the line breaks inside the word instead.
  assert.deepEqual(wrapLines("    indented words", 10).map(([a, b]) => "    indented words".slice(a, b)), ["    indent", "ed words"]);
});

test("treeRows folds single-child folders and sorts folders first", () => {
  const files = [
    { id: "src/lib/a.js", name: "src/lib/a.js", type: "change", add: 1, del: 0 },
    { id: "src/lib/b.js", name: "src/lib/b.js", type: "new", add: 2, del: 0 },
    { id: "README.md", name: "README.md", type: "deleted", add: 0, del: 3 },
  ];
  assert.deepEqual(treeRows(files).map((r) => [r.kind, r.name, r.depth, r.status ?? r.add]), [
    ["dir", "src/lib", 0, 3], ["file", "a.js", 1, "M"], ["file", "b.js", 1, "A"], ["file", "README.md", 0, "D"],
  ]);
  assert.equal(treeRows(files, new Set(["src/lib"])).length, 2);
});

test("diffstat fills a five-square bar on a log scale", () => {
  assert.deepEqual(diffstat(0, 0, 10), { add: 0, del: 0, empty: 5 });
  assert.deepEqual(diffstat(100, 100, 200), { add: 3, del: 2, empty: 0 });
  assert.equal(diffstat(1, 0, 1000).add, 1);
});

test("fileMatches takes fuzzy paths and kinds", () => {
  const file = { name: "src/components/diff-view.test.tsx" };
  assert.equal(fileMatches(file, "dfvw"), true);
  assert.equal(fileMatches(file, "is:tests"), true);
  assert.equal(fileMatches(file, "is:docs"), false);
  assert.equal(kindOf({ name: ".github/workflows/ci.yml" }), "ci");
});

test("viewed marks follow the file's contents", () => {
  const file = { id: "a", signature: "s1" };
  const review = toggleViewed(emptyReview(), file);
  assert.equal(isViewed(review, file), true);
  assert.equal(isViewed(review, { ...file, signature: "s2" }), false);
  assert.equal(isViewed(toggleViewed(review, file), file), false);
});

test("comments know their code and turn into an agent prompt", () => {
  const files = parsePatch(PATCH);
  assert.equal(linesText(files[0], "new", 2, 3), "const b = 3;\nconst c = 4;");
  assert.equal(linesText(files[0], "old", 2, 2), "const b = 2;");
  const comment = { id: "1", file: "src/app.js", side: "new", start: 2, end: 2, text: "Why 3?", code: "const b = 3;" };
  const [ok] = withStatus([comment], files);
  assert.equal(ok.outdated, false);
  const [gone] = withStatus([{ ...comment, code: "something else" }], files);
  assert.equal(gone.outdated, true);
  const prompt = reviewPrompt("my changes", [ok], files);
  assert.match(prompt, /1\. `src\/app\.js:2`/);
  assert.match(prompt, /```js\nconst b = 3;\n```\nWhy 3\?/);
});
