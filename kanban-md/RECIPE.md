# kanban-md

A keyboard-driven kanban board that opens over the window with `cmd-shift-k`. Each board is a markdown file in `~/kanban/`, with five columns (ideas, todo, wip, test, done) and one line of text per card. A board named after the focused terminal's git repository opens first.

![kanban-md](preview.png)

## What you see

A modal dialog, 92% of the window wide and 82% tall, `popover` background, in the terminal font (`settings().font_family`), text 13px, 20px side padding.

- **Board row** (top): one tab per board file, sorted by name. The open board has a `raised` background and `foreground` text, the others `dim`. The current project's board ends in ` ·`. A `+` follows the tabs; while a board is being named, a 160px input takes its place.
- **Columns** (middle): five equal columns, 16px apart, no boxes. Each heading is the lowercase column name in 12px with its card count in 11px `dim` (blank when empty), over a 1px bottom border: `accent` for the column with the cursor, `border` otherwise.
- **Cards**: plain text rows, 2px apart, rounded 6px, no border. The selected card has a `selected` background, `foreground` text and a 2px `accent` bar on its left; others are `muted` text on the dialog background, `hover` on hover. Cards in done are `dim`. A card being edited is replaced by a 32px input with a 1px `accent` border. Columns scroll on their own.
- **Hint line** (bottom): 11px `dim` key hints. While editing: `enter save · esc cancel`. When the project has no board yet it starts with `p board for <project>`. While confirming a board deletion it reads, in `blocked`, `Delete board "<name>"? y to confirm, any other key cancels`.

## How it behaves

- Arrows or `hjkl` move the cursor; `1`–`5` jump to a column. With shift they move the card: left/right to the end of the neighbouring column, up/down swapping with its neighbour. The cursor follows the card.
- `n`/`a` add a card at the end of the column; `e`, `enter` or a double-click edits it; enter saves, esc cancels, saving empty text deletes it. `d`/`x`/`backspace` delete. A single click selects a card or column.
- `cmd-z` undoes and `cmd-shift-z` redoes card changes, per board, up to 200 steps, for as long as the dialog is open.
- `[`/`]` or `tab`/`shift-tab` cycle boards; clicking a tab opens it. `b` or `+` names a new board (`/`, `\` and `:` become `-`, leading dots are dropped). `p` creates and opens the project board. `shift-d` asks, then moves the board file to `~/kanban/.trash/<name>-<timestamp>.md`.
- `esc` closes the dialog. The last opened board is remembered in `localStorage`.
- **Links.** A card holding `#42` (or a GitHub pull request URL) is linked to that pull request; `@feature/x` links a branch. The link stays in the card's text; the board shows the text without it and the link as a small chip on the card's right (`#42`, or `⎇ feature/x`), `raised` background, `accent` text. `g` opens the selected card's link in the `snappy-diff` mod as a dialog (`{ repo, pr }` or `{ repo, head }`). `@` links the selected card to the focused repository's current branch: its pull request number from `gh pr view`, else `@<branch>`, replacing an existing link (undoable). The hint line offers `g open diff` or `@ link branch` for the selected card.
- Each project board remembers its repository folder in `~/kanban/.repos.json` (board name → folder), so a board's links open from anywhere once it has been opened inside its project.
- Every change writes the board file at once. Every 3 seconds (not while typing) it re-reads the folder and the open board, so edits from an editor or an agent appear. Writes pass the last-read text as `expected`; if the file changed meanwhile, the write is dropped and the file on disk is shown.

## Built from

- `mods/kanban-md/mod.json`: `place: "none"`, `focusable: true`, overlay `{ kind: "dialog", modal: true, width: 0.92, height: 0.82 }`. `keys.json` binds `cmd-shift-k` to `mod.open:kanban-md`.
- `mods/kanban-md/board.js`: pure functions, no Herdr imports. `parse(text)` reads `## <column>` headings (case-insensitive) and `- `/`* ` cards, ignoring everything else; `serialize(title, lanes)` writes `# <title>` and all five sections; `addCard`, `editCard`, `removeCard`, `shiftCard`, `reorderCard` return `{ lanes, col, row }` or `null` and never mutate their input; `boardName` cleans a typed name; `cardLink(text)` returns `{ pr, token }`, `{ branch, token }` or `null` and `withoutLink` drops the token. Tested with `node --test`.
- `mods/kanban-md/main.js`: the view. Uses `exec` (`mkdir -p`, `ls`, `mv`, `git -C <cwd> rev-parse --show-toplevel`), `readTextFile`, `writeTextFile`, `focused().cwd`, `home()`, `settings()`, `theme()`, `props().overlay`, `openOverlay` (snappy-diff), `notify` and `closeOverlay`; `gh pr view` for `@`. Keys go through one `KEYS` table to named actions. Text input is one `InputState` shared by every edit.

## Watch out

- The dialog's keys only work while its own focus handle has focus: focus it in `init` and again 300ms later, and after every edit ends.
- While the input is focused, the view must ignore every key except `esc`, or typing triggers board actions.
- Runs programs (`ls`, `mkdir`, `mv`, `git`) and reads and writes `~/kanban/` outside the mod's folder. macOS and Linux only.
- Lines that are not headings or cards, and cards under unknown headings, are lost on the next save.
- The project is the git top-level folder's name; a terminal in the home folder has no project.

## Done when

- `herdr-app check mods/kanban-md` passes and `npm test` passes.
- `cmd-shift-k` opens the dialog on `~/kanban/main.md`, creating `~/kanban/` if missing; `esc` closes it.
- Adding, editing, moving and deleting a card changes `~/kanban/<board>.md` to match, and `cmd-z` restores the previous file.
- A line added to the file in an editor appears on the board within 3 seconds.
- In a terminal inside a git repository with no board, the hint offers `p`, and `p` creates `~/kanban/<repo>.md` and opens it.
- `shift-d` then `y` moves the open board to `~/kanban/.trash/`.
- With snappy-diff installed, `g` on a card holding `#<n>` opens that pull request's diff; esc returns to the board.
