// The panels that take the columns' place: a card's run (i), its place on the loop and its
// playbook's steps as the agent reported them, and How it works (?), the loop and every playbook.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { describe } from "./links.js";
import { PLAYBOOK_LIST } from "./work.js";
import { progress, LOOP, stationOf, ago, summarize } from "./runs.js";
import { alpha, keycap, sectionLabel, agentMark } from "./ui.js";

const TRACK_LABEL = 84; // the you / board / agent labels in How it works

const panel = (t) => v_flex().id("inspector").flex_1().min_h(0).overflow_y_scroll().gap(22).px(28).py(24)
  .rounded(10).border_1().border_color(t.border).bg(t.raised);

// How it works: the loop, who does what at each station, the playbook at `index`, and every key
// (`keyGuide`: [group, [[key, what it does]]]).
export function helpView(t, index, keyGuide) {
  const book = PLAYBOOK_LIST[index];
  const who = [["You", t.ansi3, "you"], ["Board", t.ansi6, "board"], ["Agent", t.ansi5, "agent"]];
  return panel(t)
    .child(v_flex().gap(6)
      .child(div().text_size(18).font_semibold().child("How it works"))
      .child(div().text_color(t.muted).whitespace_normal().child("A card goes around this loop. Herdr runs the board and the agents; pstack's playbooks tell the agent how to work.")))
    .child(v_flex().gap(0)
      .child(track(t, null))
      .children(who.map(([name, color, key]) => h_flex().items_stretch().border_t(1).border_color(t.border)
        .child(h_flex().w(TRACK_LABEL).flex_none().gap(8).items_center().py(10)
          .child(div().size(7).rounded_full().bg(color)).child(div().text_size(12).font_medium().text_color(color).child(name)))
        .children(LOOP.map((stop) => div().flex_1().min_w(0).px(10).py(10).text_size(11.5).line_height(17)
          .text_color(stop[key] ? t.muted : t.dim).whitespace_normal().child(stop[key] ?? "·"))))))
    .child(v_flex().gap(10)
      .child(sectionLabel(t, "Playbooks"))
      .child(h_flex().items_stretch().rounded(8).border_1().border_color(t.border).bg(t.canvas)
        .child(v_flex().w(230).flex_none().py(6).border_r(1).border_color(t.border).children(PLAYBOOK_LIST.map((b) => {
          const on = b === book;
          return v_flex().px(14).py(8).gap(2).border_l(2).border_color(on ? t.accent : t.canvas).when(on, (el) => el.bg(t.selected))
            .child(div().font_medium().text_color(on ? t.foreground : t.muted).child(b.playbook))
            .child(div().text_size(11).text_color(t.dim).child(b.words.length ? b.words.map((w) => `${w}:`).join("  ") : "⇧B on a pull request"));
        })))
        .child(v_flex().flex_1().min_w(0).gap(16).px(22).py(18)
          .child(v_flex().gap(6)
            .child(h_flex().gap(10).items_center().child(div().text_size(16).font_semibold().child(book.playbook))
              .child(div().text_size(11.5).text_color(t.dim).child(`${book.steps.length} steps`)))
            .child(ends(t, book)))
          .child(steps(t, book, null)))))
    .child(v_flex().gap(10)
      .child(sectionLabel(t, "Keys"))
      .child(h_flex().items_start().gap(28).children(keyGuide.map(([group, keys]) => v_flex().flex_1().min_w(0).gap(8)
        .child(div().text_size(12).font_medium().text_color(t.foreground).child(group))
        .children(keys.map(([key, does]) => h_flex().gap(10).items_center().text_size(12)
          .child(div().w(64).flex_none().child(keycap(t, key)))
          .child(div().min_w(0).truncate().text_color(t.muted).child(does))))))));
}

// A card's run. `card`: { title, col, run, book, planned, agent, branch, pr, detail, setup }, the
// card's column, its playbook run, its agent, its pull request link, what loadDetail found and
// the project's setup in a few words (setupSummary).
export function cardRunView(t, card) {
  const { title, col, run, book, planned, agent, branch, pr, detail, setup } = card;
  const station = stationOf(col, { working: Boolean(agent || run?.playbook), playbook: run?.playbook });
  const at = book && run ? progress(run, book.steps.length) : null;
  const since = (iso) => { const a = ago(iso); return a && (a === "just now" ? a : `${a} ago`); };
  const prColor = { open: t.ansi2, draft: t.dim, merged: t.ansi5, closed: t.ansi1 }[pr?.status?.state] ?? t.dim;
  const prText = pr && (pr.status ? describe(pr.n, pr.status) : `#${pr.n}`);
  const facts = [
    ["Station", LOOP[station].name],
    ["Branch", branch ?? "none yet"],
    ["Pull request", prText ?? "none yet"],
    ...(detail?.commits != null ? [["Commits", `${detail.commits} on the branch`]] : []),
    ...(run?.at ? [["Updated", since(run.at)]] : []),
    ...(setup ? [["Setup", setup]] : []),
  ];
  return panel(t)
    .child(v_flex().gap(10)
      .child(div().text_size(18).font_semibold().whitespace_normal().child(title))
      .child(h_flex().flex_wrap().gap(18).items_center().text_size(12).text_color(t.muted)
        .when(Boolean(book), (el) => el.child(h_flex().gap(6).items_center().child(div().size(7).rounded_full().bg(t.ansi5)).child(`${book.playbook} playbook`)))
        .when(Boolean(branch), (el) => el.child(`⎇ ${branch}`))
        .when(Boolean(pr), (el) => el.child(h_flex().gap(6).items_center().child(div().size(7).rounded_full().bg(prColor)).child(prText)))))
    .child(track(t, station))
    .child(h_flex().gap(28).items_start()
      .child(v_flex().flex_1().min_w(0).gap(16)
        .child(v_flex().gap(8)
          .child(h_flex().justify_between().items_center()
            .child(sectionLabel(t, book && planned ? "Playbook, planned" : "Playbook"))
            .when(Boolean(at), (el) => el.child(div().text_size(12).text_color(t.muted)
              .child(at.current ? `${at.done} of ${book.steps.length} · ${book.steps[at.current - 1][0]}` : `all ${book.steps.length} done`))))
          .child(book ? bar(t, book, run) : div()))
        .child(book ? steps(t, book, run) : noPlaybook(t))
        .when(Boolean(book), (el) => el.child(ends(t, book)))
        .when(Boolean(book && planned), (el) => el.child(div().text_size(11.5).text_color(t.dim).whitespace_normal()
          .child(col <= 1 ? "Steps fill in once s starts an agent and it reports them." : "The agent hasn't reported a step yet."))))
      .child(v_flex().w(360).flex_none().gap(22)
        .child(v_flex().gap(8).child(sectionLabel(t, "Agent")).child(agentBox(t, agent, detail?.message, col)))
        .child(v_flex().gap(8).child(sectionLabel(t, "Details"))
          .child(v_flex().children(facts.map(([k, v], i) => h_flex().gap(12).py(6)
            .when(i > 0, (el) => el.border_t(1).border_color(t.border)).text_size(12)
            .child(div().w(96).flex_none().text_color(t.dim).child(k))
            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(v))))))));
}

// The card's agent: its status, then its last message organised (summarize): the lead, a few
// points, how much more there is, and when it's blocked, its question.
function agentBox(t, agent, message, col) {
  const box = v_flex().gap(10).p(14).rounded(8).border_1().border_color(t.border).bg(t.canvas);
  if (!agent && !message) {
    return box.child(div().text_size(12).text_color(t.dim).whitespace_normal()
      .child(col <= 1 ? "No agent yet. s starts one." : "No agent on this branch now."));
  }
  const doing = { working: ["working", t.working], blocked: ["needs you", t.blocked], done: ["ready for review", t.done], idle: ["idle", t.dim] };
  const [word, color] = doing[agent?.status] ?? ["not running", t.dim];
  const when = message?.at ? ago(message.at) : null;
  const sum = message ? summarize(message.text) : null;
  return box
    .child(h_flex().gap(8).items_center()
      .when(Boolean(agent), (el) => el.child(agentMark(t, agent)))
      .child(div().font_medium().child(agent?.name ?? "Agent"))
      .child(div().text_size(12).text_color(color).child(word))
      .child(div().flex_1())
      .when(Boolean(when), (el) => el.child(div().text_size(11).text_color(t.dim).child(when === "just now" ? when : `${when} ago`))))
    .when(!sum, (el) => el.child(div().text_size(12).text_color(t.dim).whitespace_normal()
      .child("No message yet, or this agent keeps no Claude Code transcript.")))
    .when(Boolean(sum && agent?.status === "blocked" && sum.question), (el) => el.child(v_flex().gap(4).px(10).py(8).rounded(6)
      .bg(alpha(t.blocked, "1f")).border_1().border_color(alpha(t.blocked, "55"))
      .child(div().text_size(10.5).font_medium().text_color(t.blocked).child("NEEDS YOU"))
      .child(div().text_size(12).text_color(t.foreground).line_height(18).whitespace_normal().child(sum.question))))
    .when(Boolean(sum?.lead), (el) => el.child(div().text_size(12.5).text_color(t.foreground).line_height(19).whitespace_normal().child(sum.lead)))
    .when(Boolean(sum?.points.length), (el) => el.child(v_flex().gap(6).children(sum.points.map((point) =>
      h_flex().gap(8).items_start().text_size(12)
        .child(div().w(10).flex_none().text_color(t.dim).child("•"))
        .child(div().flex_1().min_w(0).text_color(t.muted).line_height(17).whitespace_normal().child(point))))))
    .when(Boolean(sum?.more), (el) => el.child(div().text_size(11).text_color(t.dim)
      .child(`${sum.more} more in the agent's tab`)));
}

// The six stations as a track: numbered nodes joined by a line, the columns matching the
// you / board / agent rows under them. With `current`, earlier stations are passed (✓).
function track(t, current) {
  return h_flex().items_center().pb(12)
    .child(div().w(current === null ? TRACK_LABEL : 0).flex_none())
    .children(LOOP.map((stop, i) => {
      const here = i === current;
      const passed = current !== null && i < current;
      const node = div().size(22).flex_none().rounded_full().flex().items_center().justify_center().text_size(11).font_semibold()
        .border_1().border_color(here ? t.accent : passed ? t.ansi2 : t.border)
        .bg(here ? t.accent : t.canvas).text_color(here ? t.accent_foreground ?? t.canvas : passed ? t.ansi2 : t.muted)
        .child(passed ? "✓" : String(i + 1));
      return h_flex().flex_1().min_w(0).items_center().gap(8).px(current === null ? 10 : 0)
        .child(node)
        .child(div().flex_none().font_medium().text_color(here ? t.foreground : passed ? t.muted : current === null ? t.foreground : t.dim).child(stop.name))
        .child(i < LOOP.length - 1 ? div().flex_1().h(1).mx(6).bg(passed ? alpha(t.ansi2, "80") : t.border) : div().flex_1());
    }));
}

// One segment a step: done green, skipped faint, the one in hand accent, to do a border line.
function bar(t, book, run) {
  const at = run ? progress(run, book.steps.length) : null;
  return h_flex().gap(3).children(book.steps.map((_, i) => {
    const s = run?.steps?.[i + 1]?.status;
    const color = s === "done" ? t.ansi2 : s === "skipped" ? alpha(t.dim, "80") : at?.current === i + 1 ? t.accent : t.border;
    return div().flex_1().h(5).rounded(3).bg(color);
  }));
}

// A playbook's steps as a timeline: a node per step on a rail, its label and step, and the
// agent's note under it. ✓ done, – skipped, the one in hand ringed and tagged "now".
function steps(t, book, run) {
  const at = run ? progress(run, book.steps.length) : null;
  const last = book.steps.length - 1;
  return v_flex().children(book.steps.map(([label, step], i) => {
    const n = i + 1;
    const status = run?.steps?.[n]?.status ?? (at?.current === n ? "now" : null);
    const note = run?.steps?.[n]?.note;
    const now = status === "now";
    const node = status === "done"
      ? div().size(16).rounded_full().bg(t.ansi2).flex().items_center().justify_center().text_size(10).text_color(t.canvas).child("✓")
      : status === "skipped"
        ? div().size(16).rounded_full().border_1().border_color(t.dim).flex().items_center().justify_center().text_size(10).text_color(t.dim).child("–")
        : now
          ? div().size(16).rounded_full().border(2).border_color(t.accent).flex().items_center().justify_center().child(div().size(6).rounded_full().bg(t.accent))
          : div().size(16).rounded_full().border_1().border_color(t.border).flex().items_center().justify_center().text_size(9.5).text_color(t.dim).child(String(n));
    const lineColor = status === "done" || status === "skipped" ? alpha(t.ansi2, "60") : t.border;
    return h_flex().items_stretch().gap(12)
      .child(v_flex().w(16).flex_none().items_center()
        .child(div().mt(2).child(node))
        .child(i < last ? div().w(1.5).flex_1().bg(lineColor) : div()))
      .child(v_flex().flex_1().min_w(0).gap(3).pb(i < last ? 14 : 0)
        .child(h_flex().gap(8).items_center()
          .child(div().font_medium().text_color(now || status === "done" ? t.foreground : status === "skipped" ? t.dim : t.muted).child(label))
          .when(now, (el) => el.child(div().px(6).h(16).flex().items_center().rounded(4).bg(alpha(t.accent, "33")).text_size(10).text_color(t.accent).child("now"))))
        .child(div().text_size(12).text_color(status === "skipped" ? t.dim : t.muted).whitespace_normal().child(step))
        .when(Boolean(note), (el) => el.child(div().mt(2).pl(8).border_l(2).border_color(t.border).text_size(11.5).text_color(t.muted).whitespace_normal().child(note))));
  }));
}

function ends(t, book) {
  return h_flex().gap(8).items_start().text_size(12)
    .child(div().flex_none().text_color(t.ansi2).child("Ends with"))
    .child(div().flex_1().min_w(0).text_color(t.muted).whitespace_normal().child(book.ends));
}

function noPlaybook(t) {
  return v_flex().gap(10).p(14).rounded(8).border_1().border_color(t.border).bg(t.canvas)
    .child(div().text_color(t.muted).whitespace_normal().child("No playbook yet. Start the card with a word to pick one, or let poteto-mode pick and report it with `kanban playbook`."))
    .child(h_flex().flex_wrap().gap(6).children(PLAYBOOK_LIST.filter((b) => b.words.length).map((b) =>
      h_flex().gap(6).px(8).h(22).items_center().rounded(5).border_1().border_color(t.border).text_size(11.5)
        .child(div().text_color(t.foreground).child(`${b.words[0]}:`)).child(div().text_color(t.dim).child(b.playbook)))));
}
