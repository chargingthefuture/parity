# Parity

An offline restroom and rest-stop finder for long-haul truck drivers.

Built for one situation: a driver alone in a cab, phone clamped to the windscreen, somewhere with no
signal, needing to know where to stop next — and whether that stop is one she can actually use.

Public data says a restroom exists. It does not say whether the door locks, whether the walk from
truck parking is lit, or whether anyone would see you at that door. That gap is what this app is
for.

**Everything is on the phone. Nothing is sent anywhere. There is no account and no server.**

- [What the app stores, in plain words](docs/WHERE-YOUR-DATA-LIVES.md) — written for a driver, not a lawyer
- [Local data schema](docs/SCHEMA.md)
- [The import pipeline](pipeline/README.md)

---

## What it does

**Where do I stop next.** The stop screen counts down to your next break — two and a half hours by
default — and shows the stops coming up around that time, far enough ahead that you can choose one
instead of taking whatever appears when you can't wait any longer. It works out where the window
falls on the road from the speed you are actually doing.

**Only what you can reach.** Stops behind you are not shown. Stops across the median of a divided
highway are not shown. This is the thing most worth getting right, and it is the thing most easily
got wrong — see [Direction of travel](#direction-of-travel-the-part-that-has-to-be-right).

**What drivers found.** Each stop carries the notes drivers have written about it: whether the door
locks, how many stalls, lighting rated separately for the lot, the walk and the interior, whether the
door can be seen from truck parking, how far the walk is, whether anyone is on site, cleanliness,
truck parking by time of day, and free text. Logged with a date, and logged again next time, so
conditions can be read as a run over time rather than one frozen verdict.

**An honest fallback.** When nothing well-rated is in range, it says so and shows the nearest stops
ahead anyway, marked as unrated. It never pretends the answer is better than it is.

**Sharing without a server.** Export your notes as one file, hand it to another driver, import
theirs. Merging adds what is new and never overwrites what you wrote.

It is not a navigation app and does not try to be. Offline routing is out of scope — keep using
whatever navigation you already run.

---

## The stack, and why

Weighted for reliability with no signal and low battery draw, not for developer convenience.

### Plain HTML, CSS and ES modules. No framework, no bundler, no build step, no dependencies.

The whole app is served exactly as it sits in this repo. What you read here is what runs on the
phone.

The reason is not minimalism. A build step is a thing that can break on the day someone needs to
change a label, and it puts a computer between a fix and a driver. A framework is 40–150 KB to parse
and execute before the first screen appears, on a mid-range phone, every launch. There is nothing
here that a framework would make meaningfully easier: five screens, one click handler, and strings of
HTML. It also means there is no dependency tree that could quietly add a network call or a tracker in
a future version — a supply chain of zero packages cannot be compromised.

### An installable web app, not a native one

One codebase runs on any phone, installs to the home screen, and needs no app store account, no
review, no signing certificate, and no yearly developer fee. For an app that a group of drivers
should be able to fork and keep running themselves, that matters more than native polish.

The service worker copies every file — including the stop dataset — onto the phone at install. The
first launch in airplane mode is a normal launch. There is no "connect to continue" state anywhere,
because there is nothing to connect to.

The real cost is honest: the browser can evict stored data under heavy storage pressure. The app asks
for persistent storage to reduce that, and the data screen pushes exporting a backup. Nothing else
about the design would have avoided it — a native app that keeps its only copy on one phone loses it
when the phone is lost.

### IndexedDB for records, localStorage for settings

Thousands of stops and a growing pile of notes need a real database with indexes; localStorage is a
few megabytes of synchronous strings and would stall the screen. Settings are small and wanted before
the first paint, which is exactly what localStorage is good at.

### A coarse grid index instead of SQLite with R-Tree

The obvious answer is SQLite with an R\*Tree spatial index, and in a native app it would be right. In
a browser it means shipping SQLite compiled to WebAssembly — roughly a megabyte to download, parse and
keep in memory, plus its own copy of the data — to answer one query: everything within N miles of
here.

Instead the places are bucketed into quarter-degree grid cells and a lookup walks only the cells the
search circle touches. For a few thousand rows this reads a handful of buckets and takes under a
millisecond, against a megabyte of WebAssembly and a second engine to keep fed. The test suite checks
it returns exactly what a full scan returns.

If the dataset ever grows to national scale — hundreds of thousands of rows — this is the piece to
revisit first, and it is deliberately behind two functions (`buildIndex`, `near`) so it can be
swapped without touching anything else.

### Battery

The satellite receiver is by far the most expensive thing this app can touch, on a phone that is
already warm in the sun and probably charging from the truck.

- It runs only while a screen that needs it is open, and stops the moment the app goes to the
  background.
- Precise positioning can be turned down to coarse from the settings screen.
- The screen redraws at most once every four seconds while driving, however fast fixes arrive. The
  numbers barely change in between, and redrawing on every fix keeps the processor awake for nothing.
- No map tiles are rendered. No map is drawn at all — a moving map is the most expensive thing a
  travel app normally does, and "which stop, how far, which side" does not need one.
- Nothing polls, nothing syncs in the background, and no radio is ever woken by this app.

### No third-party anything

No analytics, no crash reporter, no advertising, no tags, no map tiles, no fonts from a font service.
The fonts are in this repo. A browser page that loads a font from someone else's server tells that
server the reader's address and rough location on every launch, which would quietly undo the whole
point. The browser tests assert that the app makes no request to any host but its own.

---

## Direction of travel, the part that has to be right

Showing a stop that is behind the driver, or on the far side of a divided highway, is worse than
showing nothing: it costs an exit, a turnaround, and the time back, at night, for nothing.

The sideways offset from your heading only means something close up. Two things swamp it further out.
The road bends. And the earth is curved — a point 130 miles due east of you is not on a bearing of
exactly 90°, it is nearly a degree off, which works out as about 2.8 km sideways. A median is 20
metres wide. An early version of this app read that as "she is on the far carriageway" and hid a
perfectly good rest area that was straight ahead.

So the question is answered from whichever evidence is actually good:

| Range | What is used |
|---|---|
| Within about 2 km | The measured sideways offset. Right of travel is your carriageway (right-hand traffic). |
| Further out | The direction the transport department published for that stop — northbound, southbound. That stays true at any distance. |
| Neither available | Unknown. The screen says "side unknown" and the stop is still shown. |

Only what is **known** to be across the median is hidden. Unclear and unknown are both shown with the
warning on them, because a wrongly hidden stop costs a driver the stop.

The heading behind all of this is worked out from where the truck has actually been, because phones
report an unreliable heading at low speed. That trail is thrown away when the receiver jumps rather
than the truck moving — a fix implying more than about 150 mph, or one arriving after three minutes
of silence. Coming out of a tunnel or a long dead zone otherwise produces a heading pointing back the
way she came, which would put every stop she can reach on the "behind you" side and hide all of them.
No heading for a few seconds beats a wrong one.

---

## Running it

No build, no install:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/`. A service worker needs http rather than opening the file
directly.

### Tests

```
node --test tests/app.test.mjs       # what decides which stops a driver sees
node --test tests/browser.test.mjs   # the real app in a real browser
node --test pipeline/test.mjs        # normalizing and merging the public data
```

The browser tests need Chromium through Playwright, reached with a `node_modules/playwright` link;
everything else runs on Node alone with no dependencies. Name the test files rather than the folder —
`node --test tests/` does not work on Node 22.

---

## The data

### The dataset that ships here is made up

`data/sample-dataset.json` is 33 invented places, so the app has something to run against. It carries
`"sample": true` and a warning, and the app shows a standing banner while it is loaded. **Do not plan
a stop around any of it.** Build a real one before relying on the app.

### Building a real dataset

`pipeline/` turns public sources into a dataset file. It pulls from:

- **OpenStreetMap via the Overpass API** — `highway=rest_area`, `highway=services`, `amenity=toilets`,
  `amenity=fuel`, with truck-relevant tags.
- **US DOT / Bureau of Transportation Statistics "Truck Stop Parking"** — position, mile post, route,
  spot counts.
- **State transport department open data** (ArcGIS feature services). Field names differ per state,
  so each source carries a map from its own field names onto the schema. Several states publish
  restroom, family restroom, step-free access, food, fuel and shower flags directly.

Records within about 150 m that agree on route and direction are treated as the same physical place
and merged: names and flags are filled in field by field, a real value is never replaced by a blank,
and a state transport department is trusted over OpenStreetMap for amenity flags.

Only the fetch step needs a network, it is run by hand over Wi-Fi, and **the app never calls any of
these services**. Everything after the fetch runs offline against cached extracts, so a dataset can be
rebuilt without going back to the network.

Most of the ArcGIS addresses in `pipeline/sources.json` are marked `"verified": false` — they were
written without being checked against the live services, and each carries a note saying exactly what
to open and correct. The fetcher refuses to call an unchecked source unless told to. See
[pipeline/README.md](pipeline/README.md).

---

## What is deliberately not here

No social features, feeds, comments or followers. No live location sharing of any kind. No ads, no
purchases, no subscription. No cloud account. None of these are switched off behind a setting; they
were never built.

The no-server design is a safety property, not a shortcut. A shared service holding these records
would be a database of where women stopped, when, and how often — subpoena-able, sellable, leakable,
and a standing target. Because sharing is a file passed between people who choose to, that database
does not exist anywhere and cannot be handed to anyone.

---

## Credit

Stop data from OpenStreetMap contributors (ODbL) and United States federal and state transport
department open data. The look is the shared design system from `offline-os`.
