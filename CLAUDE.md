# Parity — agent instructions

Everything above the project rules comes from the `agents` baseline repo and is shared with every
other project. Do not edit those sections here to settle a local argument — change them in `agents`
if the baseline itself is wrong. The project rules at the bottom are this repo's own.

> The voice and dictionary sections are checked by the Stop hook at
> `.claude/hooks/check-no-pleasantries.mjs`, which is the source of truth. If a banned term changes,
> change it in the hook and in the `agents` baseline together.

---

## Voice — no pleasantries, no feelings (Critical — every reply, all agents)

Do not address the user with thanks, apologies, congratulations, well-wishes, encouragement, or
closing sign-offs. Do not use first-person feeling words (for example: glad, happy, excited,
delighted, sorry, "hope this helps", "I appreciate"). You have no feelings; do not perform them.
No jargon, no buzzwords. State the result or the next step in plain words, then stop.

This is enforced by the Stop hook `.claude/hooks/check-no-pleasantries.mjs`, which blocks a reply that
contains a banned term and asks for a plain restatement.

### Banned-term dictionary (every reply, all agents)

The Stop hook `.claude/hooks/check-no-pleasantries.mjs` holds the canonical list and is the source of
truth; if this copy and the hook ever differ, the hook wins. Keep the two in sync — when you
change one, change the other. The hook scans the whole reply and matches the term even inside
quotes, so do not reach for a banned word even to talk about it; use the replacement below instead.

**Pleasantries, feelings, and sign-offs — never use any of these (in any reply):**

- thanks / thank you
- you're welcome / you are welcome
- no problem
- my pleasure
- glad
- happy to
- excited
- delighted
- sorry
- apology / apologies / apologize / apologise (any form)
- cheers
- congrats / congratulations
- "I appreciate" / "we appreciate" (only the first-person form is banned; "the rate appreciates" is fine)
- "hope this / hope that / hope you / hope it …"
- feel free
- warm / best / kind / kindest regards
- looking forward

**Excluded vocabulary — banned word → use instead:**

- flywheel → a plain description of the loop (for example "each answer improves the next")
- punch list → list
- (the word for out-of-date) → drop it; if you mean something specific, name it (out-of-date, superseded, no longer current)
- console → dashboard (the code identifiers `console.log` / `console.error` / `console.info` are exempt)

When the hook blocks a reply, restate the result in plain, factual language — none of the terms
above, no jargon, no first-person feeling words — then stop.

---

## Plain language — no jargon (Critical — all agents)

Write in plain, everyday language. **Do not use jargon, acronyms, or insider terminology** in
human-facing output — chat replies, pull-request titles and descriptions, review comments, commit
messages, issue comments, and documentation. Jargon is a distraction and is confusing; it slows the
reader down and hides meaning.

- **Default to simple words.** Prefer the plain term over the technical or marketing one (for example
  "test it before you rely on it" over "validate end-to-end"; "make sure" over "ensure idempotency";
  "the background service" over "the daemon"). Write so a non-specialist can follow.
- **If a technical term is genuinely necessary, define it in plain words on first use** — one short
  parenthetical is enough. Do not assume the reader knows acronyms; spell them out the first time.
- **Explain, don't just name.** Say what something does and why it matters, not only its label.
- **Exempt:** real code identifiers, file paths, command names, and established proper nouns (service
  names, library names) — name those accurately; just don't pile extra jargon around them.
- Applies to **every agent** and all human-facing communication. When in doubt, choose the wording a
  newcomer would understand.

---

## Task planning — no "phases" (Critical)

Do **not** organize work into "phases." No "Phase 0 / Phase 1 / Phase 2", no phased-rollout buckets —
anywhere: plans, checklists, design notes, code comments, pull-request descriptions, or commit
messages. Phases confuse humans and agents alike.

Instead, when given an objective, break it into discrete tasks and **list them one after another in
the order they must happen**. Where order matters, state it as an explicit blocking dependency, not a
phase:

- ✅ "Task B is blocked by Task A — do A first."
- ✅ A flat, ordered, numbered task list (1, 2, 3 …) where each item may name what it depends on.
- ❌ "Phase 1: …", "Phase 2: …", "do this in a later phase."

A task with no dependency can be done at any time or in parallel; say so plainly ("no dependencies;
can run anytime").

---

## Branch naming (all agents)

- Always create a descriptive, task-named branch and develop on it. Use a Conventional-Commit-style
  prefix plus a short kebab-case summary of the task: for example `feat/user-auth-refresh`,
  `fix/csv-export-dedup`, `chore/ci-node-version-bump`, `docs/readme-quickstart`.
- Never develop on, commit to, or open a pull request from an auto-generated session branch (an opaque
  name like `claude/loving-mendel-wwWF4`). Treat it as a throwaway base: immediately branch off it (or
  off the default branch) to a descriptive name and push from the descriptive branch.
- Branch names must describe the task at hand — never an opaque or random string.
- Carry the branch all the way through to a merged pull request, then clean it up — see
  *Pull requests and the merge lifecycle* below.

---

## Pull requests and the merge lifecycle (all agents)

A task is not finished when the code is written — it is finished when the change is merged and the
branch is cleaned up. Carry every change through that whole path, in this order, without being asked:

1. **Open a pull request when the work is complete.** Once the task's changes are committed and the
   descriptive branch is pushed, open a pull request from that branch against the default branch.
   Finished work should not sit on a branch with no pull request. Give the request a descriptive,
   plain-language title and a body that says what changed and why, in the same plain voice as every
   other reply.
2. **Watch the request through to merge.** Opening it is not the finish line; track its state until
   it is merged. Where the environment can notify you of changes to the request — review comments,
   check results, new conflicts — subscribe to those notifications instead of checking in a tight
   loop; otherwise re-check its status from time to time. Never block on a sleep loop.
3. **Keep it mergeable — fix conflicts.** If the default branch moves ahead and the request develops
   merge conflicts, bring the latest default-branch commits into the branch (rebase onto it, or merge
   it in) and resolve the conflicts, keeping both sides' intent. If a conflict is a real, ambiguous
   clash where either resolution changes how the code behaves, stop and ask rather than guess.
4. **Merge when it is ready.** Merge once the automated checks (continuous integration, or CI) are
   green and the request is mergeable with no unresolved "changes requested" review. Use the
   repository's default merge method. If required checks take a while, turn on auto-merge so the
   request merges itself the moment they pass, rather than waiting on it. Never force a merge over a
   failing required check or an open request for changes — fix the cause, or report it and stop.
5. **Delete the branch after merge.** Once the request is merged, delete the now-merged head branch
   so old branches do not pile up.

The gate in step 4 — green checks, mergeable, no open change-requests — is the safe default. A
repository that requires human review before merge should keep that requirement: set the gate to
match the repository's own rules rather than merging around them.

Mechanism, by where the agent runs:

- **Claude Code on the web:** use the GitHub tools to open the request, update its branch from the
  default branch, and merge it; use the pull-request activity subscription to be told about check
  results, reviews, and conflicts instead of polling for them.
- **Local Claude Code / a terminal:** `gh pr create` to open it, `gh pr checks` to read check state,
  `git rebase`/`git merge` to clear conflicts, and `gh pr merge --auto --delete-branch` (with the
  repository's merge method) to merge and remove the branch in one step.

---

## Search tooling (optional convenience)

- Prefer `rg` (ripgrep) for recursive text and file discovery.
- Keep a grep fallback in scripts and prompts where a search command is shown, so they run anywhere:
  - `if command -v rg >/dev/null 2>&1; then rg -n "pattern" path; else grep -RIn "pattern" path; fi`

---

---

## Project rules — Parity

Parity is an offline restroom and rest-stop finder for long-haul truck drivers. The driver it is
built for is alone, in a truck, on a phone clamped to the windscreen, often with no signal at all.
Every rule below follows from that one fact.

### The four constraints that are not negotiable

These are not preferences. A change that breaks one of them is wrong even if it is otherwise good.

1. **Offline-first, not offline-capable.** The app must work fully in airplane mode on the first
   launch after it is installed. No sign-in, no "sync required" state, no first-run download, no
   server round trip for anything a driver needs on the road. If a change adds a code path that
   waits on a network, that change is wrong.
2. **Nothing leaves the phone.** No account, no analytics, no usage measurement, no crash reporter,
   no advertising, no third-party script, no font or map tile fetched from anyone else's server.
   Position data is used in memory and never written down or transmitted. Say so in the code
   comments where it would otherwise be a reader's fair question.
3. **Phone only.** No companion desktop app and no laptop-side tool is needed to use it. A laptop is
   needed only to build a fresh dataset, which is a thing the driver does once, over Wi-Fi, or is
   handed by someone else as a file.
4. **Glanceable while driving.** Large touch targets (56px and up), high contrast, dark by default,
   readable at arm's length in daylight and at 2am. The fewest taps possible between opening the app
   and knowing where to stop next.

### Where the value actually is

The public datasets say a restroom exists. They do not say whether it is usable or safe. The
observation layer — what a driver saw when she stopped — is the reason this app exists. When a
change would trade away observation quality for a nicer map, a smoother list, or a cleverer score,
the observation layer wins.

Three rules protect it:

- **Records are added, never edited.** Logging the same stop again writes a second record. Conditions
  change; a record that is overwritten each visit destroys the history that shows it.
- **Disagreement is surfaced, never averaged away.** A 5 and a 1 is not a 3. Where drivers disagree,
  show both with their dates and say plainly that they disagree.
- **Unknown is a real answer and is not "no".** A source that is silent about showers must never be
  rendered as "no showers". A place nobody has logged is shown as unrated, never given a default
  middling score.

### Direction of travel is the thing most likely to be got wrong

Showing a stop that is behind the driver, or across the median of a divided highway, makes the app
worse than useless. The rules in `js/geo.js` are deliberate and are covered by tests:

- Sideways offset only means something close up. Past about two kilometres the road bends, and the
  curve of the earth alone puts a point 130 miles dead ahead nearly a degree off your bearing —
  about 2.8 km sideways. Do not read either as "she is on the far carriageway".
- Further out, use the direction the source published, and nothing else.
- When neither applies, return unknown and say "side unknown" on screen. Never guess.
- Hide only what is known to be across the median. Unclear and unknown are both shown, with the
  warning on them: a wrongly hidden stop costs a driver the stop.
- The heading itself is worked out from where the truck has been, so `js/location.js` throws that
  trail away when the receiver jumps rather than the truck moving — a fix implying more than about
  150 mph, or one arriving after three minutes of silence. Coming out of a tunnel or a dead zone
  otherwise gives a heading pointing back the way she came, which puts every reachable stop on the
  "behind you" side and hides the lot. No heading for a few seconds beats a wrong one.

### Stack and layout

Plain HTML, CSS and ES modules. **No build step, no bundler, no framework, no npm dependencies in
the app.** The whole repo is served as-is by GitHub Pages, and what is in the repo is what runs on
the phone. Keep it that way — a build step is one more thing that can be broken on the day someone
needs to change a label.

```
index.html  app.css  sw.js  manifest.webmanifest   the app shell
js/         geo, planner, db, places, observations, exchange, location, ui, app
shared/     theme, fonts, icons — copied from the offline-os design system
data/       the bundled dataset
pipeline/   the import pipeline (Node, no dependencies). Never called at runtime.
docs/       schema, data sources, and the driver-facing note
tests/      unit tests and browser tests
```

- `shared/` is a copy of the offline-os design system. Match it rather than inventing a second look;
  send changes to the design upstream to offline-os.
- Bump `VERSION` in `sw.js` on any change to a file it caches, or phones keep serving the old copy.
- Anything persisted goes through `js/db.js` so it is covered by export and backup.

### The pipeline never runs at runtime

`pipeline/` produces a dataset file offline from cached extracts. The app reads the file. The app
must never call Overpass, an ArcGIS service, or any other source directly. The only step needing a
network is the fetch, and it is run by hand, over Wi-Fi, on a computer.

An endpoint or field name that has not been checked against the live service must be marked
`"verified": false` in `pipeline/sources.json` with a note saying what to check. Do not present a
guessed address as confirmed, and do not fetch unverified sources without the explicit flag.

### Data that is made up must say so

The dataset that ships with the app is invented so the app has something to run against. It carries
`"sample": true` and a warning, and the app shows a standing banner while it is loaded. Never
present invented coordinates as real stops — a driver planning a night stop around one is the
worst thing this repo could cause.

### Testing

Run both before pushing:

```
node --test tests/app.test.mjs      # the arithmetic that decides what a driver sees
node --test tests/browser.test.mjs  # the real app in a real browser
node --test pipeline/test.mjs       # normalizing and merging the public data
```

The browser tests need Chromium through Playwright and a `node_modules/playwright` link; they are
skipped, not deleted, where a browser is unavailable. New behaviour around direction of travel,
merging observations, or the import merge rules needs a test — those are the places where a quiet
mistake reaches a driver at 2am.
