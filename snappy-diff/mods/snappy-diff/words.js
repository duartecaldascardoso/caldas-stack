// Word-level changes between a removed line and the added line it became. Pure.

const TOKEN = /\w+|\s+|[^\w\s]/g;
// Past this many token pairs the comparison costs more than it shows.
const MAX_CELLS = 40000;

// Character ranges [start, end) of the tokens that differ, on each side.
// Returns null when the lines share too little for a word diff to help.
export function wordDiff(before, after) {
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  if (!a.length || !b.length || a.length * b.length > MAX_CELLS) return null;

  // Longest common subsequence over tokens, filled from the end.
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const keptA = new Array(a.length).fill(false);
  const keptB = new Array(b.length).fill(false);
  let common = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { keptA[i++] = keptB[j++] = true; common += a[i - 1].trim() ? 1 : 0; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
    else j++;
  }
  // Mostly rewritten: marking nearly everything says less than marking nothing.
  const words = Math.max(a.filter((t) => t.trim()).length, b.filter((t) => t.trim()).length);
  if (common < words * 0.25) return null;

  return { before: ranges(a, keptA), after: ranges(b, keptB) };
}

function ranges(tokens, kept) {
  const out = [];
  let at = 0;
  tokens.forEach((token, i) => {
    const end = at + token.length;
    if (!kept[i]) {
      const last = out.at(-1);
      if (last && last[1] === at) last[1] = end;
      else out.push([at, end]);
    }
    at = end;
  });
  return out;
}
