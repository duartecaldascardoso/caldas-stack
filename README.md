# caldas-stack

My development environment, built on [Herdr](https://herdr.dev): a plain-text kanban board to plan work, and a native diff viewer to review it and hand the review to an agent.

| | |
| --- | --- |
| [kanban-md](#kanban-md) | Kanban boards as markdown files, one per project: start agents from cards, follow them, link pull requests |
| [snappy-diff](#snappy-diff) | Review a branch or pull request like on GitHub, and send the comments to an agent |
| [herdr](#herdr) | My theme, keys and settings |

## How it fits

1. **Plan:** a card on the project's board (`⌘⇧K`), or `kanban add` from any terminal.
2. **Start:** `s` on a card makes a worktree and branch for it and starts an agent with the card as its task.
3. **Follow:** the card shows its agent working, blocked or ready; when it finishes, a toast opens its diff.
4. **Review:** comment on lines and **Send to agent**, or post the review to GitHub; `o` on the board opens the pull request.
5. **Iterate:** the viewer says when comments are addressed, and **N new commits since your review** shows only what changed.
6. **Ship:** the card moves to test when its pull request opens and to done when it merges.

## kanban-md

![kanban-md](kanban-md/preview.png)

Five columns: ideas, todo, wip, test, done. Every board is a markdown file in `~/kanban/<board>.md`, so your editor and your agents can change it too; edits made elsewhere show up within a few seconds.

```markdown
# website

## WIP
- Launch post #42
- Pricing page issue #12 @feature/pricing

## Done
- Pick a domain
```

- **Project boards:** a board named after a git repository opens first inside it, and `p` creates one for the current project.
- **Start work:** `s` makes a worktree on `feature/<card>` (in `~/.herdr/worktrees`, where Herdr nests it under the repository), opens a space there with your agent and the card as its first task, links the card to the branch and moves it to wip.
- **Agents on cards:** a card shows the agent on its branch (working, blocked, ready, idle). While the board is open, an agent that finishes says the card is ready for review; the toast opens its diff.
- **Links:** `#42` links a card to pull request or issue 42 (GitHub says which; `issue #34` and `PR #42` say it outright) and `@branch` to a branch. A card can have several. It shows a pull request's state (open, draft, merged, closed), checks and review, and an issue's state.
- **Cards follow GitHub:** opening a pull request moves its card to test, merging it or completing the issue moves it to done.
- **Follows your theme**, with a done/total progress bar per board.

| Key | Action |
| --- | --- |
| `← → ↑ ↓` or `h l k j` | Move between cards and columns |
| `⇧` + move | Move the card |
| `n` / `e` / `d` | New, edit, delete card |
| `@` | Link the card to its branch's pull request, or the branch |
| `g` | Open the card's pull request or branch in snappy-diff, or its issue in the browser |
| `s` | Start work: a worktree, a branch and an agent for the card (asks first) |
| `o` | Push the card's branch and open a pull request titled like the card, closing its issue (asks first) |
| `⌘Z` / `⌘⇧Z` | Undo / redo |
| `[` `]` | Switch board |
| `b` / `p` / `⇧D` | New board, board for this project, delete board |

### The `kanban` command

Agents and scripts change boards through `kanban`, which keeps the file in the board's format. Inside a repository it works on that project's board; `-b <board>` picks another.

```sh
kanban                          # the board, cards numbered
kanban add todo Pricing page
kanban move pricing wip         # a card by number, or a unique part of its text
kanban link 3 #42               # or "issue #34", or @feature/pricing
kanban done 3
```

## snappy-diff

![snappy-diff](snappy-diff/preview.png)

A native port of [snappy-diff](https://github.com/duartecaldascardoso/snappy-diff). `⌘⇧G` opens it on the focused terminal's repository: the branch against its pull request's base, with uncommitted work on top. Pull requests open by number from the board.

- **Reads like GitHub:** split or unified, syntax highlighting, changed words marked, a file tree with status letters, and the file header pinned while you scroll.
- **Review:** mark files viewed, comment on a line or a range, and **Send to agent** types the comments, with files, lines and code, into the agent working on that branch. On a pull request, **GitHub** posts them as a review. The copy button puts the prompt on the clipboard.
- **Overview:** headline numbers, review time, where the changes are, kinds, the largest files, what deserves a closer look (dependencies, CI, sensitive paths, missing tests) and the commits. `n` reviews in a sensible order: contracts, tests, code, config, docs.
- **Iterate:** when the commented code changes, it says the comments were addressed; when commits land on a reviewed branch, **N new commits since your review** shows only those.
- **Less to read:** moved code is faded, generated and huge files start collapsed, and a file opened from go-to or search is shown on its own. Or the opposite: **Whole files** in settings shows every file in full.
- **Live:** uncommitted changes refresh every two seconds. Viewed files and comments are kept per branch.

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous file |
| `n` | Next file to review that you haven't viewed |
| `v` | Mark file viewed |
| Click a line number | Comment on it (`⇧`-click for a range) |
| `o` | Open the file in your editor |
| `⌘K` | Go to a file, commit or action |
| `⌘F` | Search the code in the diff |
| `esc` | Back to all files, or close |
| Click `⋯ N unmodified lines` | Show the lines it hides |
| Click `+N −N` | Changes by kind (code, tests, config, CI, docs); pick one to filter the tree |
| `/` | Filter the file tree, or `is:tests` |
| `⌘B` | Toggle the sidebar |
| `?` | Settings: split or unified, whitespace, editor, whole files |

## herdr

`herdr/` holds my Herdr setup: the **midnight** theme (near-black, slate accent), my `keys.json`, and `settings.json` (Victor Mono).

## Install

Needs [Herdr](https://herdr.dev) and git; the pull request features use the [GitHub CLI](https://cli.github.com) (`gh`), signed in.

Ask an agent in Herdr to add `github.com/duartecaldascardoso/caldas-stack/kanban-md` (or `/snappy-diff`), or by hand:

```sh
git clone https://github.com/duartecaldascardoso/caldas-stack
cp -R caldas-stack/kanban-md/mods/kanban-md caldas-stack/snappy-diff/mods/snappy-diff ~/.config/herdr-app/mods/
cp caldas-stack/herdr/themes/midnight.json ~/.config/herdr-app/themes/
ln -s "$PWD/caldas-stack/kanban-md/bin/kanban" ~/.local/bin/kanban   # needs Node 20+
```

Then add the keys to the `global` section of `~/.config/herdr-app/keys.json`:

```json
"cmd-shift-k": "mod.open:kanban-md",
"cmd-shift-g": "mod.open:snappy-diff"
```

## Development

```sh
npm test                                      # board and diff logic
npm run check                                 # syntax of every mod file
herdr-app check snappy-diff/mods/snappy-diff  # loads a mod in Herdr
```

Each mod's `RECIPE.md` describes it fully enough to rebuild it.

## License

[MIT](LICENSE)
