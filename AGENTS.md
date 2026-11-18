# AGENTS.md

Guidance for agents working in this repository.

## What this is

A single-page 3D viewer of Singapore's terrain, plus the Python pipeline that
produces the DEM it consumes.

- **No framework, no SSR, no component tree.** A Vite build is the only toolchain:
  it bundles `three` and `geotiff` from `node_modules` so the page has no external
  origins, and hashes the filenames so a redeploy cannot serve a stale bundle.
  Keep it plain HTML + vanilla JS; do not add React/Vue/Astro, a CSS framework, or
  a router for a page this small.
- **Commit the source and dataset, not the build.** `dist/`, `node_modules/`, and
  the virtualenv are ignored. `data/gem15_singapore/` is generated, but it is kept in
  the repository so the deployable build can be produced without re-downloading the
  13.6 MB source window.
- **No test suite.** Verification is a served page that loads without console
  errors, plus a visual check of the result — in dev and again from `dist/`.

## Layout

| Path | Contents |
| --- | --- |
| `index.html` | Markup + all CSS (tokens in `:root`, landscape split-view base, portrait and wide-screen media blocks). Vite's single HTML entry. |
| `src/app.js` | Everything else: palettes, controls, UI wiring, contour styling, and the tile-driven scene built on `src/terrain-cog.js`. |
| `src/terrain-cog.js` | Streamed terrain: opens the COG, reads tiles by byte range, chooses a level per tile, builds tile meshes/shaders. |
| `src/terrain-relief.js` | Pure tile preparation: separable relief pass and RG texture packing, shared by the main thread fallback and the worker. |
| `src/terrain-tile-worker.js` | Worker entry that runs `src/terrain-relief.js` and transfers the packed tile back. |
| `pipeline/gem15_singapore.py` | Downloads GEM-15, masks to Singapore, writes the COG and manifest. |
| `data/gem15_singapore/` | Generated data. Never patch these files by hand — re-run the script. `data/` is Vite's `publicDir`, so the folder is served at `/gem15_singapore` and copied into `dist/`. |
| `vite.config.mjs` | Relative `base`, `data/` as the public directory, and one fixed port for dev and preview. |
| `package.json` | Pins `three@0.169.0` and `geotiff@2.1.3` exactly; `dev`/`build`/`preview` scripts. |

## Workflow

```bash
python3 -m venv .venv                                        # once
.venv/bin/python -m pip install rasterio pyproj numpy requests
.venv/bin/python pipeline/gem15_singapore.py                 # writes data/gem15_singapore (~13.6 MB)
npm install                                                  # once
npm run dev                                                  # then open localhost:8123
```

`npm run build` writes `dist/`, which is the deployable artefact; `npm run preview`
serves it with Range support on the same port as dev (8123), so the built page can be
checked as it will ship. Run one server at a time. Check a change in dev and again
from `dist/`. HMR is disabled in `vite.config.mjs`
(`server.hmr: false`): hot updates kept old terrain streams and base-map textures
alive in this long-lived scene. Reload the page manually after a change.

The page must be served over HTTP **with Range support**; `fetch` on `file://` fails
and the UI falls back to its "elevation model not found" card. Vite's dev and preview
servers both honour `Range`; `python3 -m http.server` does not, so the COG cannot be
read tile by tile through it. GitHub Pages honours `Range`.

## Dataset

`pipeline/gem15_singapore.py` writes `data/gem15_singapore/` (or `--out DIR`):

- `singapore_dtm.tif` — Float32 metres, UTM zone 48N, `NaN` no-data, 256 px tiles,
  DEFLATE with the floating-point predictor, and overviews at 30/60/120/240 m built
  by averaging. Level 0 is the source grid untouched. This is the only file the
  viewer loads; the first view fetches about 1 MB of the 13.6 MB file.
- `manifest.json` — grid and level geometry, height range, geographic and land
  bounds, boundary checksum, and the COG SHA-256.

Heights are EGM96 orthometric metres. Valid cells below 0 m inside the land polygon
(reservoirs, water surfaces, about 35,000 cells) are kept; anything below −40 m is
clamped and counted in the manifest. GEM-15 has no data for several small southern
islands (Pulau Jong, Pulau Tekukor, Pulau Hantu, the Sisters, Pulau Sudong, Pulau
Pawai, Pulau Senang, Pulau Biola); the pipeline reports this and leaves them empty.
The model is a visualisation, not survey-grade data, and mixes bare earth with
water surfaces.

## Architecture notes

- `PALETTES` at the top of `src/app.js` is the single source of truth for colour:
  each entry has `sea` and either continuous `stops` or `bands` + `colors`. The
  panel buttons, legend gradient and terrain colours all derive from it, so adding
  a palette is a data-only change.
- Contour mode keeps the palette hues but replaces the terrain ramp with
  `CONTOUR_FILL`. Contours are built **per tile**, one tile at a time, from that
  tile's own samples (`contourTileSegments`), into minor and index `LineSegments2`
  layers (each with a dark casing). Line materials bias their logarithmic fragment
  depth (`vFragDepth *= 0.997`) so the small world-space lift stays in front of the
  terrain instead of breaking into dashes; keep that bias tied to the log depth
  buffer, not a fixed distance. `recolorContours()` edits the instance colour buffers
  and label textures in place when the palette changes.
- Contours use a **coarser level than the terrain** (`CONTOUR_MIN_LEVEL = 1`, 30 m)
  and their own tile set, derived from the visible ground rectangle, not from the
  terrain tiles. Contouring every visible level-0 tile is both too slow (a single tile
  is a ~160 ms burst) and too big (over 100k segments each), and a 10 m interval does
  not need 15 m cells. `CONTOUR_MAX_TILES` bounds how much line geometry can exist.
  Builds are debounced until the camera has been still for `CONTOUR_SETTLE_MS`, and run
  against `CONTOUR_BUILD_BUDGET_MS` per frame.
- Each contour tile spans only the levels it actually contains (its valid-sample min
  to max), so the 10 m sweep is a handful of levels, not all of them. Index-contour
  parity must come from the absolute level number, not the loop counter.
- A contour tile read keeps its key in `pending` until the build finishes. Deleting it
  when the read is dequeued lets the per-frame sync re-queue the same tile while its
  read is in flight, building it repeatedly.
  Labels are canvas-texture `Sprite`s with `sizeAttenuation: false` and
  `depthTest: false` (map-style overlays, so the surface never slices them); their
  geometry stores raw levels and follows exaggeration through
  `lineGroup.scale.y`, while sprites are repositioned on exaggeration and thinned
  per frame by screen-space collision. Label visibility is therefore
  view-dependent — do not treat the sprite list as the set of labels currently
  on screen.
- The base map is two layers. `ensureBaseMap()` builds a z12 overview of the
  island (35 tiles) at `MAP_Y`. `refreshDetail()` then streams a finer level for
  the ground in front of the camera: zoom = 12 + round(log2(fitDistance / distance)),
  capped at 18 and stepped down until the level fits `DETAIL_BUDGET` tiles. That
  level is laid at `MAP_DETAIL_Y` above the overview, so zooming in gains street
  detail without ever leaving a hole. Tile textures are cached in `baseMap.textures`
  with LRU eviction above 260; `baseMap.pinned` protects tiles on screen.
- The source is OneMap. `BASE_MAP_STYLES` holds the three styles: Default and
  Grey come from `tiles.onemap.gov.sg/{Default,Grey}_HD_webp` as WebP; Orthophoto
  is OneMap's `Satellite` set on `www.onemap.gov.sg`, which is still PNG and has no
  WebP equivalent. `state.baseMapStyle` selects one, the style picker is built from
  the same list, and every cache key carries the style id, so switching styles
  cannot show a texture from the previous one. A style change builds the new
  overview and detail off stage, then swaps both in one task while the old style
  stays visible; clearing first would briefly show the coarse overview (large
  labels) at a zoomed-in view. Textures stay cached per style, and a failed rebuild
  leaves the previous style mounted. Keep the OneMap/SLA credit visible while the
  layer is on.
- Tile coordinates come from the manifest's geographic bounds, and
  `lonLatToWorld` maps lon/lat linearly onto the terrain's world extent — fine at
  this latitude, where Mercator and UTM differ by centimetres across 50 km.
  Enabling the layer hides the water-depth sheet; disabling it restores the
  checkerboard background and resets terrain opacity to 100% with Normal blending,
  since the blend controls only apply over the map.
- Terrain compositing has an explicit **blend mode** (`state.blendMode`) separate
  from the opacity slider. Normal scales `diffuseColor.a`; Multiply mixes the
  terrain toward white (`mix(vec3(1.0), …)`) and uses `MultiplyBlending`; Screen
  mixes toward black (`mix(vec3(0.0), …)`) and uses `CustomBlending` with
  `OneMinusDstColor` / `One` for `src * (1 - dst) + dst`. All three use the shared
  `uDemOpacity` strength in the fragment shader via `onBeforeCompile`. Multiply
  suits the cartographic styles, Screen keeps orthophoto shadows readable. Flip
  `material.transparent` (with `needsUpdate`) only when it actually changes, and
  keep multiply/screen transparent so their blend equations apply.
- Hovering the terrain shows two cross-sections: north–south down the left edge
  and east–west along the bottom edge of the map. `pickTerrainPoint()` ray-marches
  the drawn tiles and returns ground `{x, z, h}` or an enclosed hole
  `{x, z, h: null}`; the profile samplers walk the ground rectangle under the
  viewport (the four screen corners intersected with the y = 0 plane, clamped to the
  raster) through `stream.heightAt()`. A hole is a strict no-data read, detected
  with `heightAt(..., true)` (`tileSamplesAt(..., strict)`): the normal read borrows
  the nearest valid corner so the surface and charts stay continuous, while the
  strict read keeps a hole from being mistaken for that borrowed ground. The numeric
  readout does not use the bilinear value: `heightAtSource()` reads the nearest stored
  cell of the tile being drawn (at wide zoom that is an overview cell, not a 15 m
  level-0 cell) and the tooltip rounds it to whole metres with `≈`, because the
  15 m model does not justify one-decimal precision. The pick classifies the y = 0
  point to find holes, but open water is not a veto: the water plane is see-through,
  so a valid terrain hit along the ray is still the terrain under the cursor. Using
  the sea-level point to reject the hit caused the readout to drop out at random
  coastal/low spots. A no-data hole has no surface, so once one is
  found the pick is reprojected onto a horizontal plane at the hole's surrounding
  height (`holeSurfaceHeight` then `holePointAtHeight`); returning the first rim
  crossing put the chart cursor on the hole edge instead of under the pointer.
  `isTerrainHole()` casts in eight directions
  and looks outward for valid land until it finds some or reaches 2.6 km; an
  enclosed hole has land on all eight sides, while open water has at least one
  direction that stays no-data. Searching each direction independently is what
  makes this work for holes wider than the old fixed-radius ring. Profiles draw
  no-data at 0 m so the area chart stays continuous instead of breaking into land
  fragments, but the top line is solid for valid ground and dashed in the warm
  `noData` colour for holes/water, so a flat 0 m stretch is not ambiguous. The
  area fill uses the same height-to-colour mapping as the terrain shader (normalise
  to the summit, `pow(t, 0.42)`, then the palette) and colours across the profile's
  own valid height range, not fixed palette stops: a low green profile must not pick
  up the palette's red high end. The cursor line is the neutral theme line, not a
  palette colour. For positive terrain the domain floor is 0 m rather than a
  negative pad, so the area sits on the plot floor and stays there as the chart
  height changes. The panel and area fill stay close to opaque so the chart is
  legible over the checkerboard and the terrain. They are drawn on a 2D `<canvas>` overlay
  (`pointer-events: none`) in CSS pixels at the current DPR, with the area filled
  from the active palette and the line/labels from the theme. `drawCrossSections()`
  hides both when the cursor is over sea or outside the drawn tiles, and the readout
  and profiles share one rAF (`scheduleTerrainTip`) so a pointer move does one pick,
  not three. `crossSides` starts as left + bottom; pointing at a panel flips that
  panel to the opposite edge and the side persists until the pointer reaches it
  there, so the charts do not block the terrain being inspected.
- `Exclude flat land` (`state.flatMask`, base map only) scales that strength by a
  per-vertex relief attribute: the local height range over ±3 vertices, put
  through `smoothstep(2.5 m, 11 m, range)` in `buildTerrain`. `computeRelief` is a
  separable sliding min/max (monotone deque, O(N)); it uses in-bounds windows at the
  grid edge, and no-data cells are excluded from both passes. Do not replace it with a
  per-vertex window loop, which is ~49 reads per vertex at full resolution. The shader branches
  on `uBlendMode` — Multiply mixes toward white, Screen toward black, Normal scales
  `diffuseColor.a` — so a mask of 0 leaves the map untouched either way, and in
  Normal mode the terrain becomes transparent (`transparent = true` whenever the
  mask is on) instead of covering the map. Flat ground is only masked while
  `state.baseMapOn`; in the two RGB blend modes the mask reads as a lighter or
  dimmer tint rather than absence.
- Lighting is baked into the terrain shader, not scene lights (`MeshBasicMaterial`
  with `onBeforeCompile`); the scene deliberately has no lights. The vertex stage
  reads the height DataTexture, displaces Y by `uExaggeration`, builds the normal
  from neighbouring texels and shades it, then looks the colour up in the
  `uLut` texture; the fragment stage outputs that as `diffuseColor`. Use
  `updateTerrainUniforms` (LUT texture upload plus uniforms) for palette and
  exaggeration changes — never a per-vertex loop. If you add real lights, remove
  the shading term in the shader or the terrain will be lit twice.
- **The terrain is streamed from a COG (`src/terrain-cog.js`), not decoded from an image.**
  `data/gem15_singapore/singapore_dtm.tif` is a Cloud-Optimised GeoTIFF (Float32, DEFLATE +
  float predictor, 256 px tiles) with overviews at 30/60/120/240 m. Level 0 is the
  source grid untouched; every overview is an average. This is the only dataset file.
- **Tile model.** A tile is `TILE` (256) samples square at one level, plus an `APRON`
  of extra samples on each side read from the neighbouring tile, so normals and
  contour crossings agree across tile borders. Level L's tile (tx, ty) covers the same
  ground as the four level L−1 tiles that subdivide it, so `tileRect()` maps a tile to
  world metres at any level.
- **Level of detail.** `TerrainStream.select()` walks the quadtree from the coarsest
  level and splits a tile into its four children while its cells would still exceed
  `CELL_PX_TARGET` on screen. Leaves are drawn, each at the coarsest level that meets
  the target, so full 15 m detail appears only where the camera can resolve it. The
  screen target is in **device** pixels, so the frame loop passes the drawing-buffer
  height, not CSS pixels. Touch-first devices use the coarser
  `CELL_PX_TARGET_TOUCH` (2.4) instead. The split threshold has **hysteresis**
  (`SPLIT_MARGIN` / `MERGE_MARGIN` against the set of nodes `refined` last frame):
  a node has to rise clearly above the target to split and fall clearly below it to
  merge, so a camera resting near a threshold cannot flip a tile's level every frame.
- **Touch profile.** A coarse, non-hovering pointer switches the page to a cheaper
  render: pixel ratio capped at 1.5, MSAA off, the coarser LOD target above, a
  half-resolution terrain mesh (`geometryStep: 2`, a quarter of the vertices, same
  texture samples), contour tiles no finer than level 2 (60 m) and capped at 24,
  and a 96-tile cache. Tiles that contain both land and no-data keep `step = 1`, so
  the coastline silhouette does not get flattened; the worker returns this `coast`
  flag with the packed texture. While a
  gesture moves the camera, `TerrainStream.deferReads` lets only the coarsest
  overview tiles load; fine reads resume 160 ms after the camera settles. Without
  that gate, a tile upload lands mid-drag exactly when the frame budget is tightest.
  The gate must transition back through `invalidate()`, or the release update never
  runs.
- **A fallback tile owns its whole quadrant.** `update()` resolves each leaf to the
  nearest loaded ancestor (`resolveDraw`) and then hides any resolved tile that sits
  inside a coarser resolved one (`hasDrawnAncestor`). Drawing a coarse fallback *and*
  the finer siblings already loaded under it puts two surfaces at slightly different
  heights in the same place, and they interpenetrate as the camera moves — the LOD
  flicker. Suppressing the finer tiles keeps the quadrant uniformly coarse until every
  sibling has loaded, at the cost of a brief coarser patch rather than a shimmer.
  When the siblings do arrive, they **crossfade** over the held fallback
  (`TILE_FADE_MS`): the fading tile is transparent, does not write depth, and its
  `vFragDepth` is biased a few metres toward the camera by `uDepthPush`, because a
  log-depth fragment shader discards `polygonOffset`. The fallback is drawn opaquely
  beneath it and dropped once the fade ends, so two opaque surfaces never share the
  place. Only Normal blending can crossfade; Multiply and Screen compound two
  surfaces, so they keep the hard swap. `resolveDraw` also requests the coarsest tile
  when nothing on the path is cached, so a cold start gets a fallback instead of a
  hole.
- **Current tiles are held, not dropped.** When the selection moves away from a
  tile (`update`), the tile stays drawn for `TILE_HOLD_MS` if nothing opaque has
  replaced it yet, and for as long as a selected tile over it is still fading. The
  backdrop test is **overlap in ground space**, so it works in both directions: a
  coarser tile fading in holds the finer tiles it replaces, and a finer tile fading
  in holds the coarser fallback. A tile overlapped by an opaque *coarser* tile is
  dropped at once (two opaque surfaces would shimmer); opaque *finer* descendants
  end a hold instead of starting one. A tile appearing with no visible surface under
  it appears immediately rather than fading in from the background. Held tiles are
  pinned in the cache and their hold deadline is not refreshed, so a stale surface
  cannot live for ever.
- **Coarse levels stay cached.** `TileCache.evict` protects every level at or above
  `COARSE_KEEP_LEVEL` (1): the overviews are a few dozen tiles that every zoom-out
  needs again, and evicting them made a zoom-in/zoom-out cycle re-fetch tiles it
  already had. The `limit` still bounds the cached level-0 tiles, which is where the
  memory goes. Touch devices use a smaller limit because each RG-float tile texture
  is over 500 kB; 160 of them is more than a phone tab should hold. A freshly loaded
  texture starts **pinned** until the next `pin()` pass: when the visible set is larger
  than the limit, an unpinned new entry would be evicted before it was drawn and then
  requested again, producing a perpetual reload loop and a spinner that never stops.
- **Meshes are per tile, shaders are shared.** Each tile gets its own material, but
  every material's `onBeforeCompile` body is identical, so three.js compiles one
  program. Per-tile values are uniform *holders* created in `makeTileMaterial` — not
  inside `onBeforeCompile`, which only runs at first render, so a caller that sets
  uniforms at build time would find no shader yet. `buildMesh` writes to
  `material.userData.uniforms`. The common uniforms are shared holders, so one write
  updates every tile.
- **Meshes and materials are retired.** `TerrainStream.update` hides tiles not drawn
  and deletes those unused for a while; without that, meshes and materials accumulate
  as the camera moves and a long session runs out of memory.
- **Reads are serialised and retried.** `readTileQueued` runs at `READ_CONCURRENCY = 1`
  and retries. geotiff's block source aborts and re-fetches blocks when several
  `readRasters` calls overlap on one source (the browser logs `Failed to fetch` for
  each abort, and geotiff then throws `Request failed` with every HTTP request having
  succeeded), so concurrency must stay at 1 and a transient failure is expected.
- **Decoding happens in a worker pool.** `openCog` creates a geotiff `Pool` of four
  workers (one tile window straddles four 256² blocks) and attaches it to each level.
  geotiff 2.1.3's `fromUrl` does not forward a `pool`, so `readTile` passes
  `level.pool` to every `readRasters` call; a pool option on `fromUrl` would silently
  do nothing. The first pooled read pays the worker bootstrap (~100 ms), which overlaps
  the initial range requests. Keep `READ_CONCURRENCY = 1`: the pool speeds up decode,
  it does not fix the block-source race above.
- **Tile preparation is a second worker.** Decoding alone still left the main thread
  with `tileRelief` (four separable O(N) passes) and the per-sample packing, so a
  tile arrival could stall a frame. `src/terrain-tile-worker.js` imports the pure
  `src/terrain-relief.js`, receives a **copy** of the decoded samples (the main thread
  keeps the original for hover/profiles), and returns the RG buffer by transfer plus
  a `coast` flag. The main thread only wraps it in a `DataTexture` and uploads it.
  If worker creation fails, `packTileAsync` falls back to the same code synchronously.
  A job that gets no reply for 12 s terminates the worker, rejects the other queued
  jobs, and finishes the timed-out tile on the main thread, so a wedged worker cannot
  leave `pending`/`inflight` non-zero for ever.
- **Skirts hide seams.** A fine tile meeting a coarse neighbour can step (the overview
  is an average; measured ~0.15 m mean, up to ~5.9 m on steep ground). Each tile's
  geometry carries a skirt ring flagged `aSkirt` that the shader drops by
  `SKIRT_DROP_M`, so the gap cannot be seen.
- **Heights are normalised in the texture.** A tile texture is RG float: R holds the
  height normalised to 0..1 with `-1` for no-data (exactly as the old single-mesh
  viewer did — raw metres would break the land test, since real land here sits below
  sea level), G holds the precomputed relief. Relief is computed when the tile loads
  (`tileRelief` in `src/terrain-relief.js`, a separable sliding min/max) in the tile
  preparation worker; do not put the 49-sample window in the vertex shader.
- World axes: +X east, −Z north, +Y up, 1 unit = 1 metre. Vertical exaggeration
  multiplies only Y.
- **2D/3D is a mode, defaulting to 2D.** `state.mode3D` gates two things:
  `effectiveExaggeration()` returns 0 in 2D (the terrain draws flat, a top-down
  colour map) and the orbit locks top-down via `applyPolarLock()`. 3D restores the
  slider's exaggeration and lets the camera tilt; toggling tweens the polar angle
  between `POLAR_2D` and `TILT_3D`, and the 2D lock is applied only when the tween
  settles (`polarLockPending`), or `controls.update()` snaps the camera. The sea
  floor is never multiplied by exaggeration (`transformed.y` in the tile shader), so
  it stays below the water plane at 0× instead of covering it with a tinted plate.
- **Layout is a split view, not an overlay.** `.app` is a grid of `#map` and
  `.sidebar`; landscape puts the map left with a compact right rail, portrait puts
  the map above a scrollable controls section. Every control (header, compass,
  zoom, legend, panel) lives in the sidebar, so nothing floats over the canvas.
  `measureMap()`/`viewWidth`/`viewHeight` size the renderer and camera from the
  pane, and `resize()` re-measures on both `window.resize` and a `ResizeObserver`.
  Do not reintroduce `window.innerWidth/Height` for scene sizing or fixed HUD
  positioning; `resetView()` fits the full pane with no `setViewOffset`.
- `resetView()` fits the camera to the island's land bounding box (not the data
  grid, whose sea corners are empty) by projecting its corners and iterating the
  orbit distance. It re-runs on resize until the user moves the camera. The
  default view is near top-down (`PLAN_TILT`).
- Fog range is recomputed on every rendered frame from the camera-to-target
  distance. A fixed range fogged the island itself when the fit pushed the camera
  far back on a narrow screen — keep it distance-relative.
- **Detail loading has its own indicator.** A fixed-slot `.load-spinner` trails the
  zoom buttons and appears while `stream.pending` or `cache.inflight` is non-empty,
  so zooming in shows that higher resolution is still arriving without a full-screen
  card or moving the controls. `onArrival` updates it as well as the frame loop,
  because a throttled tab may not run another rAF when the last tile lands.
- **Rendering is on demand.** `frameLoop` keeps running (orbit tweens, inertia,
  `controls.update`, compass — all cheap) but repaints only when `needsRender`
  is set: camera movement arrives through the controls' `change` event, scene
  and uniform mutations call `invalidate()`, a landed tile read calls it via the
  stream's `onArrival`, and `stream.update()` returns whether the drawn set
  changed. Otherwise the frame skips the quadtree walk, the label pass and
  `renderer.render` — repainting a still scene at the display's refresh rate
  (≈1.6 M triangles at 120 fps) is what warmed the machine while idle. A 1 Hz
  keep-alive (`IDLE_RENDER_MS`) bounds any mutation path that forgets
  `invalidate()` to one second, so new render-affecting code should still call
  it. The fog update and label pass live inside the render branch for the same
  reason.
- Touch mapping is explicit in the controls setup: one finger pans; two fingers
  pinch to zoom and use `DOLLY_PAN` in 2D or `DOLLY_ROTATE` in 3D, switched by
  `setView3D()`. MapControls defaults would leave touch without any way to tilt.
  OrbitControls maps two-finger **midpoint drag** to azimuth, which reads as the
  map sliding sideways, so that horizontal component is suppressed. Azimuth
  instead comes from the **twist angle** between the two pointers, applied to
  `_sphericalDelta` from a capture-phase pointermove before OrbitControls calls
  update; positive screen angle maps to positive theta. In 3D the vertical
  component still tilts and the pinch still zooms, so the gesture is
  twist-to-rotate like a mobile map. The instance-level overrides leave mouse
  rotation and keyboard arrows unaffected.
- The view tools (`rotateToNorth`, `zoomBy`) animate in spherical orbit space
  around `controls.target` — radius, phi, theta — instead of lerping positions, so
  a turn keeps its distance and a zoom keeps its bearing. `rotateToNorth` takes the
  shortest wrapped path to theta 0, so the compass button always returns to north
  regardless of the current bearing; it is not a quarter-turn stepper. One
  `orbitTween` at a time: a second press retargets from the pending destination, and
  any control `start` cancels it. The compass needle is driven by
  `controls.getAzimuthalAngle()` in the frame loop, so it stays honest after a free
  drag.
- `window.__dem` exposes the scene, camera, controls, renderer, viewer state,
  terrain stream and COG handle for console debugging.
- **Dependencies are first-party.** `three` and `geotiff` are exact-pinned in
  `package.json` and bundled; there is no import map and no jsDelivr. Three's addons
  resolve through the package's own `./addons/*` export. geotiff's decode pool worker
  is already inlined as a base64 blob by geotiff itself (`web-worker`), so no
  `?worker` import or `worker.format` setting is needed — verify a tile actually
  decodes after upgrading geotiff. The build prints a 500 kB chunk warning for the
  three.js chunk (about 160 kB gzipped); that is expected, not a regression.
- The dataset lives at `data/gem15_singapore/`, where the pipeline writes it. `data/`
  is Vite's `publicDir`: the dev server serves the folder at `/gem15_singapore`, and a
  build copies it to the same path under `dist/`. The app keeps using the relative
  `gem15_singapore/manifest.json` URL, so both hosts work without a second copy.

## Gotchas that have already bitten once

- **Depth precision is the flicker.** The scene spans 200 m to 2,000 km, and
  ~2,000 terrain vertices sit within 1 m of sea level; with a 24-bit depth buffer
  and a 50 m near plane they z-fought the water-depth sheet, which read as flicker while
  zooming. Keep `logarithmicDepthBuffer: true`, keep `camera.near` at 200, and
  keep the sea plane at `WATER_Y` rather than at 0. `updateMinDistance()` lets the
  2D map orbit down to about 240 m but raises the floor with effective exaggeration
  (`240 + maxHeight × exaggeration × 1.2`), so in 3D the nearest summit cannot
  cross the near plane.
- **Never put `backdrop-filter` over the canvas.** A blurred panel over a
  continuously repainted WebGL canvas flickers in Chromium; the panel is a solid
  fill and the decorative vignette overlay is gone for the same reason. The panel
  and legend carry a semi-transparent fill (`--panel-bg`); keep it a flat fill,
  never a blur.
- **Control feel: 1:1 drag with a measured glide.** `enableDamping` is off, so a drag
  applies in the frame the pointer moves instead of trailing it. The release glide is
  `stepInertia()` instead: while a pointer is down, `sampleDrag()` reads how the camera
  actually moved each frame (so rotate/pan/pinch all work without repeating the control
  mappings), `releaseDrag()` seeds a decaying velocity from it, and `stepInertia()`
  plays it out in orbit space around the target, like `stepOrbit()`. `INERTIA_TAU`
  sets glide length (velocity × TAU); spin is clamped to `INERTIA_SPIN_LIMIT` and pan
  to `state.size × 1.5`. Pointer counting is on the canvas, not the controls' own
  start/end events, because those also fire around a wheel zoom and must not fling.
  `start`, `tweenOrbit` and a new pointerdown all cancel a glide. Speeds are
  `rotateSpeed 1`, `panSpeed 1` (both 1:1), `zoomSpeed 2.2`.

- **The COG is the only dataset.** No WebP, PNG or archive is written any more. The
  viewer reads `singapore_dtm.tif` by byte range and never loads the whole file: the
  default view fetches about 1 MB of the 13.6 MB. Do not reintroduce a second encoded
  format "for the first paint" — the overviews already serve that.
- **The float predictor works, but only geotiff.js ≥ 2.1 does it.** Level 0 round-trips
  exactly through geotiff.js 2.1.3 with `Predictor: 3`; a decoder that ignores the
  predictor returns noise, so check `predictor === 3` decodes correctly before
  changing the package version. `readRasters()` returns one `Float32Array` per band; the
  `{ interleave: true }` form returns a differently-shaped result.
- **No-data is `NaN` in the COG** and becomes the `-1` sentinel when a tile texture is
  built. Pointer sampling has two reads: the normal one borrows the nearest valid
  bilinear corner (so a tile spanning a small hole still has a continuous surface),
  and the strict one returns null (so holes can be found). Do not use the strict read
  for ordinary surface picking or the chart silhouette; it is only for deciding
  whether a sample is a hole. In the shader, `sampleH` returns `uSeaFloor` for no-data neighbours (not 0 m),
  so coastal land does not get a fake cliff on its shaded edge.
- **Boundary is pinned.** `pipeline/gem15_singapore.py` fetches the boundary from a fixed commit
  and checks its SHA-256. It takes all polygons in the file (main island and outlying
  islands), not just the first match. Changing the source means updating both the
  commit and the digest together.
- **Negative land heights are real, not noise.** About 35,000 valid cells sit below
  0 m inside the land polygon (reservoirs, water surfaces). They are kept. Anything
  below `MIN_LAND_HEIGHT_M` (-40 m) is clamped and counted in the manifest.
- **`manifest.land_cells` is the fit.** `resetView()` fits the camera to the valid-cell
  bounds the pipeline writes, not to the raster rectangle (whose sea corners would fit
  the camera too far out) and not to a coarse overview (whose sea edges shift the box).
- **The pinhole fill must read a snapshot.** `buildTerrain` closes isolated
  no-data voids (a lone dropped vertex shows the base map through a hillside as a
  bright speck), but it reads `base` and writes a copy. Filling in place lets the
  first coastal fills feed their neighbours, the cascade runs offshore, and about
  53,000 sea vertices become fake low land — the island ends up sitting on a flat
  green plate that hides the coastline. Valid vertices should stay near 30 % of the
  grid (the source mask is 29.4 %).
- **Clamp before the exponent.** `Math.max(0, h / maxH) ** 0.55` — exponent first
  produces `NaN` colours for the below-sea-level coastal cells.
- **Lift contour colours toward white, not by scaling.** Multiplying a near-black
  palette colour up to a legible luminance clips the dominant channels (Viridis at
  0 m went bright pink); mixing with white keeps the hue and hits the target
  luminance exactly.
- **`manifest.files[*].pixel_size_m` must stay `15 × width / file_width`.** Only
  same-grid outputs exist now, but the original script had this inverted, which
  distorted the aspect-to-relief ratio when resampled PNGs were written.
- **Block-averaged resampling is gone.** The old decimation placed each vertex at
  the corner of its block, which misregistered terrain against contours and the base
  map by up to half a block. Full resolution places each vertex on its pixel centre,
  so this cannot recur unless the grid is decimated again.
- **The sea is a colourless depth sheet, not a painted plane.** The renderer has
  `alpha: true` and clears to transparent; `.map` supplies a CSS checkerboard, and
  the water plane writes only depth (`colorWrite: false`, `renderOrder: -10`). That
  hides the pipeline's `SEA_FLOOR` skirt and anything below sea level while the
  canvas shows the page behind it. Removing the depth sheet exposes the skirt;
  painting the plane removes the checkerboard.
- Keep `camera.far` well beyond the sea plane's extent, or its clipping edge shows
  up as a straight line across the water.

## Style

- British/Commonwealth spelling in prose ("colour", "visualisation") matching the
  existing copy; sentence-case UI labels; uppercase-tracked micro-labels.
- Copy is factual and short: no gesture instructions in the UI (the controls are
  discoverable), no marketing language, no emoji. State numbers instead of mood.
- Both credits live in `.credit` at the foot of the legend: the GEM-15 line is
  always visible, the OneMap/Singapore Land Authority line appears only while the
  base map is on (`.credit.map-on`). Keep the element visible at every breakpoint.
  GEM-15 is CC-BY 4.0 and its required attribution is the exact phrase “This dataset
  is produced by Google”; link it to the Earth Engine catalog entry
  (`projects_climate-and-sustainability_assets_gem-15_v1`), not the old Maps
  Elevation API page. The paper citation is Batchu et al. (2026),
  doi:10.31223/X55N75.
- Vanilla DOM APIs; no dependencies beyond three.js.
