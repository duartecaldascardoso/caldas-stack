# caldas-stack

My development environment, built on [Herdr](https://herdr.dev). Work is planned on a plain-text kanban board and reviewed in a native diff viewer. A card can link to its pull request, so one opens the other.

| | |
| --- | --- |
| [kanban-md](#kanban-md) | Kanban boards as markdown files, one per project |
| [snappy-diff](#snappy-diff) | Review a branch or pull request like on GitHub, and hand the comments to an agent |
| [herdr](#herdr) | My theme, keys and settings |

## kanban-md

![kanban-md](kanban-md/preview.png)

`⌘⇧K` opens the board. Five columns: ideas, todo, wip, test, done.

| Key | Action |
| --- | --- |
| `← → ↑ ↓` or `h l k j` | Move between cards and columns |
| `⇧` + move | Move the card |
| `n` / `e` / `d` | New, edit, delete card |
| `@` | Link the card to its repository's branch: the pull request, or the branch |
| `g` | Open the linked pull request or branch in snappy-diff |
| `o` | Push the card's branch and open a pull request titled like the card (asks first) |
| `⌘Z` / `⌘⇧Z` | Undo / redo |
| `[` `]` | Switch board |
| `b` / `p` / `⇧D` | New board, board for this project, delete board |

Boards live in `~/kanban/<board>.md`. A board named after a git repository is that project's board and opens first inside it.

```markdown
# website

## WIP
- Launch post #42
- Pricing page @feature/pricing

## Done
- Pick a domain
```

`#42` links a card to pull request 42 and `@branch` to a branch. A linked card shows its pull request: a dot for open, draft, merged or closed, then its checks and review. Cards follow it: an open pull request moves its card to test, a merged one to done. Edits made elsewhere show up within a few seconds, so agents can update the board too.

## snappy-diff

![snappy-diff](snappy-diff/preview.png)

A native port of [snappy-diff](https://github.com/duartecaldascardoso/snappy-diff). `⌘⇧G` opens it on the focused terminal's repository: the branch against its pull request's base, with uncommitted work on top.

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous file |
| `n` | Next file you haven't viewed |
| `v` | Mark file viewed |
| Click a line number | Comment on it (`⇧`-click for a range) |
| `o` | Open the file in your editor |
| `⌘K` | Go to a file, commit or action; a file opens on its own (`esc` shows them all) |
| `⌘F` | Search the code in the diff, and open the match's file on its own |
| Click `⋯ N unmodified lines` | Show the lines it hides |
| Click `+N −N` | Changes by kind: code, tests, config, CI, docs; pick one to filter the tree |
| `/` | Filter the file tree |
| `⌘B` | Toggle the sidebar |
| `?` | Settings: split or unified, whitespace, editor |

Code that was only moved is faded, and its file header says how many lines moved. **Send to agent** types your comments, with files, lines and code, into the agent working on that branch; when the code they were on changes, it tells you they were addressed. The copy button puts the same prompt on the clipboard. Viewed files and comments are kept per branch. Pull requests are fetched with the GitHub CLI (`gh`).

## herdr

`herdr/` holds my Herdr setup: the **midnight** theme (near-black, slate accent), my `keys.json`, and `settings.json` (Victor Mono).

## Install

Ask an agent in Herdr to add `github.com/duartecaldascardoso/caldas-stack/kanban-md` (or `/snappy-diff`), or by hand:

```sh
git clone https://github.com/duartecaldascardoso/caldas-stack
cp -R caldas-stack/kanban-md/mods/kanban-md caldas-stack/snappy-diff/mods/snappy-diff ~/.config/herdr-app/mods/
cp caldas-stack/herdr/themes/midnight.json ~/.config/herdr-app/themes/
```

Then add the keys to the `global` section of `~/.config/herdr-app/keys.json`:

```json
"cmd-shift-k": "mod.open:kanban-md",
"cmd-shift-g": "mod.open:snappy-diff"
```

## Development

```sh
npm test                                  # board and diff logic
npm run check                             # syntax of every mod file
herdr-app check kanban-md/mods/kanban-md  # loads a mod in Herdr
```

## License

[MIT](LICENSE)
