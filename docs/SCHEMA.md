# Local data schema

Everything the app knows lives on the phone. There are two kinds of records and they are kept
strictly apart:

- **Places** — the base map data. Imported from public sources (OpenStreetMap, federal and state
  transport departments). Read-only inside the app. Replaced wholesale when a newer dataset is loaded.
- **Observations** — what a driver actually saw when they stopped there. Written only by the person
  holding the phone. Never overwritten by a dataset refresh, never overwritten by an import.

Keeping them apart is what makes a dataset refresh safe: new base data can land without touching a
single thing a driver wrote.

---

## Where records are stored

| Store | Browser storage | Why |
|---|---|---|
| `places` | IndexedDB object store, key `id` | Thousands of rows, queried by area. Too big for localStorage. |
| `observations` | IndexedDB object store, key `obs_id`, index on `place_id` | Grows over time, exported as a file. |
| `place_stubs` | IndexedDB object store, key `id` | Locations that arrived with an imported observation but are not in this phone's dataset. Keeps an imported note usable. |
| `settings` | localStorage, key `parity:settings` | Small, read on every launch, wants to be synchronous. |
| `meta` | localStorage, key `parity:meta` | Which dataset is loaded, when it was built, the device id. |

There is no server-side copy of any of this, because there is no server.

---

## Place

A location that might have a restroom. One record per physical site.

```json
{
  "id": "osm:node/1234567890",
  "name": "I-95 Northbound Rest Area",
  "kind": "rest_area",
  "lat": 39.4102,
  "lon": -75.6231,
  "route": "I-95",
  "direction": "N",
  "milepost": 12.4,
  "state": "DE",
  "base": {
    "restroom": true,
    "family_restroom": null,
    "ada": true,
    "showers": false,
    "food": null,
    "fuel": false,
    "truck_parking_spots": 47,
    "hours": "24/7",
    "staffed": null
  },
  "sources": [
    { "source": "osm", "native_id": "node/1234567890", "fetched_at": "2026-08-01T00:00:00Z" }
  ]
}
```

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | `"<source>:<native id>"`. Stable across dataset rebuilds — this is what an observation points at, and what a merge keys on. |
| `name` | string | Best available name. Falls back to a generated one such as `"Rest area — I-95 N, MP 12.4"`. |
| `kind` | enum | `rest_area`, `services`, `truck_stop`, `toilets`, `fuel`, `welcome_center`, `weigh_station`, `other`. |
| `lat`, `lon` | number | Decimal degrees, WGS84. Rounded to 6 places (about 10 cm — far more than enough). |
| `route` | string or null | Highway designation, normalized to `I-95`, `US-30`, `SR-1`. |
| `direction` | enum or null | `N`, `S`, `E`, `W`, `both`, or null when the source does not say. Used by the direction-of-travel filter, and only as a hint — the live heading check does the real work. |
| `milepost` | number or null | Where the source publishes one. |
| `state` | string or null | Two-letter code. |
| `base` | object | What the *source* claims exists. See below. |
| `sources` | array | Every source that contributed, so a disagreement can be traced back. |

### `base` — source-asserted flags

Every one of these is `true`, `false`, or `null`, and **`null` means the source was silent**, which is
not the same as `false`. The app renders the three states differently: a missing fact is never shown
as an absent amenity.

`restroom`, `family_restroom`, `ada`, `showers`, `food`, `fuel`, `staffed` are the three-state flags.
`truck_parking_spots` is a count or null. `hours` is a free string such as `"24/7"` or `"6am-10pm"`,
or null.

**These flags say a restroom exists. They do not say it is usable, or that it is safe.** That is the
entire reason the observation record below exists.

---

## Observation

One visit, by one driver, to one place. A driver logs the same place as many times as they stop
there; nothing is ever edited in place, so conditions can be read as a run over time instead of a
single frozen verdict.

```json
{
  "obs_id": "8f14e45f-ea6c-4d1b-9f2a-77c0b1d3e5a9",
  "place_id": "osm:node/1234567890",
  "observed_at": "2026-08-08T02:14:00Z",
  "created_at": "2026-08-08T02:16:31Z",
  "author": "dev-7c1a9e",
  "access": {
    "interior": "detached",
    "hours": "24h",
    "hours_note": "",
    "door": "single_locking",
    "stalls": 2,
    "requires": "none"
  },
  "safety": {
    "light_lot": 4,
    "light_path": 2,
    "light_interior": 5,
    "sightline": "partial",
    "walk_m": 70,
    "staffed": false,
    "security": false,
    "cameras": true,
    "comfort": 3
  },
  "practical": {
    "cleanliness": 4,
    "parking_spots": 40,
    "parking_availability": { "morning": "plenty", "day": "some", "evening": "some", "night": "full" },
    "showers": false,
    "laundry": false,
    "food": true
  },
  "notes": "Door faces away from the truck lot. Lot light out at the north end."
}
```

### Fields

| Field | Type | Notes |
|---|---|---|
| `obs_id` | string | Random id generated on the device. The merge key. Never reused. |
| `place_id` | string | The `Place.id` this is about. |
| `observed_at` | ISO timestamp | When the driver was actually there. Defaults to now, editable — a note can be written the next morning. |
| `created_at` | ISO timestamp | When the record was written. Used only to break a tie on an identical `obs_id`. |
| `author` | string | A random per-device id such as `dev-7c1a9e`. **Not a name, not an account, not derived from anything about the person or the phone.** It exists only so that after a merge you can tell "these six notes came from one person" apart from "six people agree". Regenerate it any time from the data screen. |

**Access** — `interior` is `inside` (inside a staffed building) or `detached` (standalone structure).
`hours` is `24h`, `daytime`, `business_hours`, or `unknown`, with `hours_note` for the specifics.
`door` is `single_locking` (single-occupancy, locks), `multi_stall`, or `multi_stall_locking`
(multi-stall behind an outer locking door). `stalls` is a count. `requires` is `none`, `key`,
`purchase`, or `code`.

**Safety** — `light_lot`, `light_path`, `light_interior` are rated 1–5 separately, because a bright
parking lot and a dark path to the door is a real and common combination that a single lighting score
hides. `sightline` is `clear`, `partial`, or `blind` — whether the restroom door can be seen from
truck parking. `walk_m` is the walking distance in metres (shown in feet). `staffed`, `security`,
`cameras` are yes/no/unknown. `comfort` is the overall 1–5 "would I stop here again".

**Practical** — `cleanliness` 1–5. `parking_spots` counted or estimated. `parking_availability` is
per time band (`morning`, `day`, `evening`, `night`), each `plenty`, `some`, or `full`, because
whether a lot has room at 9pm has nothing to do with whether it has room at 9am. `showers`,
`laundry`, `food` are yes/no/unknown.

Every field is optional. A note that says only "lot light out at the north end" is worth saving, and
the app saves it.

---

## Files

Two file formats, both plain JSON so they can be read, checked, and edited by hand.

### Dataset file — `parity-dataset-<name>.json`

Produced by the import pipeline, loaded once over Wi-Fi, then used offline forever.

```json
{
  "format": "parity.dataset",
  "version": 1,
  "name": "us-northeast",
  "generated_at": "2026-08-08T00:00:00Z",
  "sample": false,
  "bbox": [-80.5, 36.5, -66.9, 47.5],
  "attribution": ["OpenStreetMap contributors (ODbL)", "US DOT BTS Truck Stop Parking"],
  "counts": { "places": 4812 },
  "places": [ /* Place records */ ]
}
```

`sample: true` marks the small demonstration dataset that ships with the app. The app shows a
standing warning while a sample dataset is loaded, so nobody plans a night stop around invented
coordinates.

### Observation file — `parity-observations-<date>.json`

What a driver sends another driver. This is the whole sharing mechanism.

```json
{
  "format": "parity.observations",
  "version": 1,
  "exported_at": "2026-08-08T12:00:00Z",
  "device": "dev-7c1a9e",
  "counts": { "observations": 214, "places": 96 },
  "observations": [ /* Observation records */ ],
  "places": [ /* trimmed Place records: id, name, kind, lat, lon, route, direction, state */ ]
}
```

The trimmed places ride along so an observation stays usable on a phone whose dataset does not cover
that area. They are stored as `place_stubs` and are replaced the moment the real dataset covers them.

### Merge rules on import

1. Key on `obs_id`.
2. An `obs_id` already on the phone is **kept as-is**. Nothing a driver wrote is ever silently
   replaced by a file someone handed them.
3. An `obs_id` that is new is added, whoever wrote it.
4. Two records about the same `place_id` both survive. They are shown side by side, newest first,
   each with its date and its author id. There is no averaging into one score that hides a
   disagreement — if one driver rated the lighting 5 and another rated it 1 last week, the driver
   reading it needs to see both.
5. Place stubs fill gaps only. A stub never overwrites a place from the real dataset.

Import is additive and it is safe to run the same file twice.
