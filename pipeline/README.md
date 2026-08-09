# The import pipeline

This folder turns public map data into one file the app can load: a `parity.dataset` file full of
`Place` records, exactly as `docs/SCHEMA.md` describes them.

**Only the first step needs the internet.** You run it once, sitting somewhere with Wi-Fi. It saves
the answers to disk. Everything after that reads those saved files and never asks the internet for
anything. **The app itself never calls any of these services** — not at start-up, not in the
background, not when a driver taps a stop. By the time a phone sees this data it is a single file
that was loaded once and works with the radio switched off.

Nothing here needs installing. It is plain JavaScript for Node 22 and it has no packages, no build
step, and no lock file.

---

## What is in here

| File | What it does |
|---|---|
| `sources.json` | The list of places the data comes from, and for each one the map from that source's field names onto the schema's fields. |
| `fetch-osm.mjs` | **Needs the internet.** Downloads OpenStreetMap data through Overpass and saves the raw answers. |
| `fetch-arcgis.mjs` | **Needs the internet.** Downloads records from any transport department's map service and saves the raw answers. |
| `normalize.mjs` | Turns one raw record into one `Place`. Pure working-out, no internet, no files. |
| `build.mjs` | Reads everything saved, joins records about the same place, writes the dataset file. No internet. |
| `build-sample.mjs` | Builds the small made-up dataset that ships with the app. No internet. |
| `test.mjs` | The tests. No internet. |
| `cache/` | Where the downloaded answers land. Not checked in. |
| `cache-samples/` | Small extracts written by hand, checked in, used by the tests and the sample build. |

---

## Running it

Do these in order. Step 3 is blocked by steps 1 and 2 — it can only join what has already been
downloaded. Steps 1 and 2 do not depend on each other and can be done in either order, or only one
of them if that is all you want.

### 1. Check the addresses in `sources.json` (needs the internet, and a browser)

Some entries are marked `"verified": false`. That means the web address, the field names, or both
are a best guess and have not been opened and checked. Each one carries a `note` saying what to look
at. Open the address in a browser, find the real layer, add `?f=json` to its address to see the
field names it actually publishes, correct the entry, and set `verified` to `true`.

`fetch-arcgis.mjs` skips unchecked sources by default and tells you which ones it skipped. A guessed
address is not worth sending a request to.

### 2. Download the data (needs the internet — this is the only step that does)

OpenStreetMap, for an area given as west, south, east, north in degrees:

```
node pipeline/fetch-osm.mjs --bbox -80.5,36.5,-66.9,47.5
```

It cuts the area into one-degree squares, asks for one square at a time with a three-second pause
between requests, and tries again with a longer wait if the server is busy. Overpass is a free
shared service, so the pauses matter. Each square lands in `pipeline/cache/osm/` as the server's own
answer, byte for byte, next to a small `.meta.json` file recording when it was downloaded. Squares
already saved are skipped, so re-running after a dropped connection only fetches what is missing.

Add `--dry-run` to print the query and the list of squares without asking for anything.

Transport departments, from `sources.json`:

```
node pipeline/fetch-arcgis.mjs --all
node pipeline/fetch-arcgis.mjs --source ia-dot-rest-areas
```

It reads a page of records at a time until the layer runs out, and saves each page raw to
`pipeline/cache/arcgis/<source id>/page-N.json`.

Both scripts save the answers untouched and never save anything worked out from them. That is
deliberate: it means the rules in `normalize.mjs` can be improved and the whole dataset rebuilt from
what is already on disk, without asking a public service for the same data a second time.

### 3. Build the dataset (no internet)

```
node pipeline/build.mjs --out data/parity-dataset-us-northeast.json --name us-northeast
```

This reads everything under `pipeline/cache/`, turns it into `Place` records, joins the records that
describe the same physical place, sorts them by id, and writes one file. It prints how many records
came from each source, how many were joined, and how many were dropped and why.

### 4. Build the sample dataset (no internet)

```
node pipeline/build-sample.mjs
```

Writes `data/sample-dataset.json` from the hand-written extracts in `cache-samples/`. **Everything
in that file is made up.** It carries `"sample": true` and a warning saying so, and the app shows a
standing warning the whole time a sample dataset is loaded, so nobody plans a night stop around an
invented coordinate.

### 5. Run the tests (no internet)

```
node pipeline/test.mjs
```

or, for the same tests through Node's own test reporter:

```
node --test pipeline/test.mjs
```

(On Node 22, passing the folder rather than the file — `node --test pipeline/` — tries to load the
folder as a program and fails. Name the file.)

---

## How two sources become one place

Two records are the same physical place when they are within about 150 metres of each other, their
kinds could describe one site, and they do not disagree about the road or the direction of travel.
A field only counts against a match when both records have an answer — one source saying nothing is
not evidence of anything.

When records are joined:

- Anything one source knows and the other does not is filled in. **A real value is never written
  over by a null.**
- When both know something and they disagree, the more trusted source wins. A state transport
  department outranks the federal roll-up, which outranks OpenStreetMap. The department runs the
  buildings it publishes and updates its own list when a restroom is closed or rebuilt;
  OpenStreetMap tags are entered by volunteers passing through and can be years behind.
- A name a source published beats a name this pipeline made up.
- Every source that contributed is listed in the record, so a disagreement can be traced back.
- The id comes from the most trusted source in the group, and is chosen the same way on every
  rebuild. That matters because a driver's observations point at that id.

---

## Yes, no, and nobody checked are three different things

Every flag in a `Place`'s `base` is `true`, `false`, or `null`, and **`null` means the source said
nothing**. It is not a quiet way of saying no.

This is the rule the whole record shape exists for, and it is the one thing in here most worth being
careful about. A source that never mentioned a restroom must not come out saying there is none —
that would tell a driver at two in the morning that a place is no use, on the strength of nobody
ever having written it down. Anything a source publishes that cannot be read as a clear yes or a
clear no — a blank, `UNKNOWN`, `N/A`, `-9999` — becomes `null`.

The same care applies to the rest. A road name nobody can identify comes back as nothing rather than
a guess: a bare `95` could be I-95 or state route 95, and picking the wrong one sends a driver to
the wrong road. A direction that is not clearly one carriageway comes back as nothing too.

---

## What the flags do and do not say

These flags say a source claims something exists. They do not say it is open, clean, lit, or safe.
That is what a driver's own observations are for, and the app keeps the two apart on purpose — see
`docs/SCHEMA.md`.
