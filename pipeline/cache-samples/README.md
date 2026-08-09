# Sample raw extracts

Small files written by hand, in exactly the shape the real services answer with: an Overpass reply
is `{"elements": [...]}`, an ArcGIS reply is `{"features": [{"attributes": {...}, "geometry": {...}}]}`.

**Every coordinate in here is invented.** None of these stops exist. The files are here so the
offline half of the pipeline can be run and tested on a machine with no internet, and so the app has
something to load before anyone has fetched a real dataset.

They are laid out the same way `pipeline/cache/` is, so `build.mjs` reads them with no special
handling:

    cache-samples/
      osm/<square>.json            + <square>.meta.json
      arcgis/<source id>/page-0.json + page-0.meta.json

Between them the records cover every path through the code: a point, an area with a centre, a road
name written five different ways, a direction written six different ways, a flag the source is
silent about, a flag the source says no to, two records of one place from two sources that have to
be joined, and a record with no coordinates that has to be thrown away.

Build them with `node pipeline/build-sample.mjs`.
