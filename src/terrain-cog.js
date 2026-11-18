/**
 * Streamed terrain from a Cloud-Optimised GeoTIFF.
 *
 * The DEM stays on disk (or on the CDN) as a COG with five levels (15 m to 240 m).
 * Each level is split into 256-sample tiles. A tile is drawn at the coarsest level
 * whose cells are still small on screen, so full 15 m detail appears only where the
 * camera is close enough to resolve it. Tiles are fetched with HTTP Range requests
 * (geotiff.js), cached, and evicted when they leave the view.
 *
 * Tiles share world coordinates across levels: tile (level L, tx, ty) covers the same
 * ground at every level, and its samples sit on that level's cell centres. Each tile
 * carries a one-sample apron on every side (read from the neighbouring tile at the
 * same level), so adjacent tiles meet without cracks and normals stay continuous.
 */
import * as THREE from 'three';
import { fromUrl, Pool } from 'geotiff';
import { packTileData } from './terrain-relief.js';


export const TILE = 256;     // samples per tile edge, at every level (COG block size)
// Extra samples on each side. 1 is enough for normals; the flat-land relief mask
// reads a ±RELIEF_REACH window, so the apron is at least that wide to keep it seam-free.
export const RELIEF_REACH = 3;
export const APRON = RELIEF_REACH;
export const SEA_FLOOR = -90;
// Target on-screen size of one cell, in device pixels. Below this a coarser level is
// indistinguishable, so the selector steps down a level. Touch devices trade detail
// for a lower vertex load: coarse pointers render at a lower pixel ratio anyway, and
// 256-sample tiles are vertex-bound on mobile GPUs.
export const CELL_PX_TARGET = 1.6;
export const CELL_PX_TARGET_TOUCH = 2.4;
// LOD hysteresis: a tile has to be clearly over the target to refine, and clearly
// under it to merge back. Without the dead band, a camera resting near a threshold
// flips a tile's level every frame, which reads as flicker.
const SPLIT_MARGIN = 1.25;
const MERGE_MARGIN = 0.78;
// A tile window (TILE plus the apron on both sides) straddles four COG blocks, so
// four decoders saturate one read; larger pools only leave workers idle.
const DECODE_POOL_SIZE = Math.min(4, navigator.hardwareConcurrency || 2);
// A tile whose reads all failed is retried after a pause instead of being dropped
// for the rest of the session: geotiff's block race makes a failure a normal
// transient, and a permanent blacklist leaves that quadrant coarse forever.
const TILE_RETRY_MS = 8000;
// A tile that appears where a coarser fallback was drawn crossfades in over this
// long; the fallback is held beneath it for the same span. Short enough to read as
// a transition, long enough that the level change is not a single-frame pop.
const TILE_FADE_MS = 220;
// After a tile leaves the selection, keep it on screen this long while its
// replacement streams in. Without this the old surface is hidden the moment the
// selector changes, so a read that takes a few hundred milliseconds reads as a hole
// or a coarse flash rather than a level change.
const TILE_HOLD_MS = 900;
// Never evict anything coarser than level 0: the overviews are a few handfuls of
// tiles that every zoom-out needs again, so evicting them only makes the way back
// out re-fetch tiles it already had. The limit still bounds how many fine tiles are
// kept, which is where the memory actually goes.
const COARSE_KEEP_LEVEL = 1;
function tileKeyLevel(key) {
  return Number(key.slice(0, key.indexOf('/')));
}
function rectsOverlap(a, b) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
}

/**
 * Open the COG and return its level table.
 * `url` is any Range-capable URL (local dev server or GitHub Pages).
 */
export async function openCog(url) {
  // blockSize matches one COG tile (256×256 float32) so a tile read maps to few
  // byte-range requests; a larger block cache stops concurrent reads evicting blocks
  // each other (geotiff then reports "Request failed").
  const tiff = await fromUrl(url, { blockSize: 256 * 256 * 4, cacheSize: 512 });
  // DEFLATE + predictor decoding is the expensive part of a tile read. It runs in
  // workers, off the main thread. fromUrl does not forward `pool`, so it is attached
  // to each level and passed to readRasters explicitly.
  const pool = new Pool(DECODE_POOL_SIZE);
  const count = await tiff.getImageCount();
  const levels = [];
  for (let i = 0; i < count; i++) {
    const image = await tiff.getImage(i);
    levels.push({
      index: i,
      image,
      pool,
      width: image.getWidth(),
      height: image.getHeight(),
      // level 0 is the source grid; each overview doubles the cell size
      cell: 15 * 2 ** i,
    });
  }
  return { tiff, levels };
}

/**
 * Tile grid of one level. Tiles are addressed by (tx, ty) in the level's own
 * 256-sample grid, so a tile at level L covers 256 × cell metres.
 */
export function tileCount(level) {
  return {
    cols: Math.ceil(level.width / TILE),
    rows: Math.ceil(level.height / TILE),
  };
}

/**
 * Read one tile through the limiter, retrying a few times. geotiff's block source
 * drops blocks when several readRasters calls overlap on one source ("Request failed",
 * with every HTTP request having succeeded), so a transient failure here is normal
 * and clears on a retry.
 */
export async function readTileQueued(level, tx, ty, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await scheduleRead(() => readTile(level, tx, ty));
    } catch (error) {
      last = error;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw last;
}

/**
 * Read one tile (plus apron) at one level from the COG. Samples outside the raster
 * come back as NaN, which the shader treats as no-data.
 */
async function readTile(level, tx, ty) {
  const x0 = tx * TILE - APRON;
  const y0 = ty * TILE - APRON;
  const x1 = (tx + 1) * TILE + APRON;
  const y1 = (ty + 1) * TILE + APRON;
  const side = TILE + 2 * APRON;
  const out = new Float32Array(side * side).fill(NaN);

  // Clip the requested window to the raster; the rest stays NaN.
  const cx0 = Math.max(0, x0);
  const cy0 = Math.max(0, y0);
  const cx1 = Math.min(level.width, x1);
  const cy1 = Math.min(level.height, y1);
  if (cx1 <= cx0 || cy1 <= cy0) return out;

  const [band] = await level.image.readRasters({
    window: [cx0, cy0, cx1, cy1],
    interleave: false,
    pool: level.pool,
  });
  const w = cx1 - cx0;
  const h = cy1 - cy0;
  for (let y = 0; y < h; y++) {
    const dstY = cy0 - y0 + y;
    for (let x = 0; x < w; x++) {
      out[dstY * side + (cx0 - x0 + x)] = band[y * w + x];
    }
  }
  return out;
}

/** Wrap the worker-prepared RG buffer in the per-tile GPU texture. */
function makeTileTexture(data, side, coast) {
  const texture = new THREE.DataTexture(data, side, side, THREE.RGFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.userData.coast = coast;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Height in metres at world (x, z) from one apron-padded tile grid, bilinearly.
 * Returns null where the surrounding samples are no-data (NaN), so the readout
 * can stay quiet over the sea and the raster's empty corners.
 */
export function tileSamplesAt(samples, rect, x, z, strict = false) {
  const side = TILE + 2 * APRON;
  const fi = Math.min(TILE, Math.max(0, (x - rect.x0) / rect.cell));
  const fj = Math.min(TILE, Math.max(0, (z - rect.z0) / rect.cell));
  const i0 = Math.floor(fi);
  const j0 = Math.floor(fj);
  const i1 = Math.min(TILE, i0 + 1);
  const j1 = Math.min(TILE, j0 + 1);
  const at = (i, j) => samples[(j + APRON) * side + (i + APRON)];
  const h00 = at(i0, j0);
  const h10 = at(i1, j0);
  const h01 = at(i0, j1);
  const h11 = at(i1, j1);
  const di = fi - i0;
  const dj = fj - j0;
  const valid = Number.isFinite(h00) && Number.isFinite(h10)
    && Number.isFinite(h01) && Number.isFinite(h11);
  if (!valid) {
    // Strict reads are for no-data detection: a bilinear cell touching a hole is a
    // hole, not a value borrowed from the nearest valid corner.
    if (strict) return null;
    // the coast: fall back to the nearest valid corner rather than reporting a gap
    const nearest = [[h00, di, dj], [h10, 1 - di, dj], [h01, di, 1 - dj], [h11, 1 - di, 1 - dj]]
      .filter(([h]) => Number.isFinite(h))
      .sort((a, b) => (a[1] ** 2 + a[2] ** 2) - (b[1] ** 2 + b[2] ** 2));
    return nearest.length ? nearest[0][0] : null;
  }
  const top = h00 + (h10 - h00) * di;
  const bottom = h01 + (h11 - h01) * di;
  return top + (bottom - top) * dj;
}

// Tile preparation runs in a worker: the relief passes are O(N) over a 258² grid
// and packing touches every sample, which used to stall a frame per arrival. The
// decoded samples stay on the main thread for hover/profile reads; the worker gets
// a copy and returns the packed buffer by transfer.
const tileJobs = new Map();
const TILE_WORK_TIMEOUT_MS = 12000;
let nextTileJob = 1;
let tileWorker = null;

function failTileWorker(reason) {
  const worker = tileWorker;
  tileWorker = null;
  if (worker) worker.terminate();
  for (const job of tileJobs.values()) {
    clearTimeout(job.timer);
    job.reject(new Error(reason));
  }
  tileJobs.clear();
}

try {
  if (typeof Worker !== 'undefined') {
    tileWorker = new Worker(new URL('./terrain-tile-worker.js', import.meta.url), { type: 'module' });
    tileWorker.onmessage = (event) => {
      const { id, data, coast, error } = event.data;
      const job = tileJobs.get(id);
      if (!job) return;
      tileJobs.delete(id);
      clearTimeout(job.timer);
      if (error) job.reject(new Error(error));
      else job.resolve({ data: new Float32Array(data), coast });
    };
    tileWorker.onerror = (event) => {
      console.warn('[terrain] tile worker failed:', event.message || event);
      failTileWorker('tile worker failed');
    };
  }
} catch (error) {
  console.warn('[terrain] tile worker unavailable:', error);
}

function packTileAsync(samples, side, heightMin, span) {
  if (!tileWorker) {
    return Promise.resolve(packTileData(samples, side, heightMin, span, RELIEF_REACH));
  }
  const heights = samples.slice(); // keep the original for hover/profile sampling
  return new Promise((resolve, reject) => {
    const id = nextTileJob++;
    const timer = setTimeout(() => {
      if (!tileJobs.delete(id)) return;
      console.warn('[terrain] tile worker timed out; falling back to the main thread');
      failTileWorker('tile worker timed out');
      // The original samples are still here, so this tile can finish synchronously.
      try {
        resolve(packTileData(samples, side, heightMin, span, RELIEF_REACH));
      } catch (error) {
        reject(error);
      }
    }, TILE_WORK_TIMEOUT_MS);
    tileJobs.set(id, { resolve, reject, timer });
    try {
      tileWorker.postMessage(
        { id, heights, side, heightMin, span, reach: RELIEF_REACH },
        [heights.buffer],
      );
    } catch (error) {
      tileJobs.delete(id);
      clearTimeout(timer);
      failTileWorker('tile worker postMessage failed');
      resolve(packTileData(samples, side, heightMin, span, RELIEF_REACH));
    }
  });
}

/**
 * LRU cache of tile textures keyed by level/tx/ty. Tiles that are on screen are
 * pinned so eviction never drops something being drawn.
 */
/**
 * Serialise tile reads so a burst of them does not exceed the browser's per-origin
 * connection limit. Without this, zooming issues hundreds of overlapping range
 * requests and the browser fails some of them with "Request failed".
 */
const READ_CONCURRENCY = 1;
let activeReads = 0;
const readQueue = [];
function scheduleRead(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeReads++;
      fn().then(resolve, reject).finally(() => {
        activeReads--;
        const next = readQueue.shift();
        if (next) next();
      });
    };
    if (activeReads < READ_CONCURRENCY) run();
    else readQueue.push(run);
  });
}

/**
 * LRU cache of tile textures keyed by level/tx/ty. Tiles that are on screen are
 * pinned so eviction never drops something being drawn.
 */
export class TileCache {
  constructor(limit = 200, range = { heightMin: 0, span: 1 }) {
    this.limit = limit;
    this.range = range;
    this.entries = new Map(); // key -> { texture, used, pinned }
    this.inflight = new Map(); // key -> Promise
    // The textures are GPU-only, so a pointer readout cannot read the surface back
    // from them. Keep the decoded grid for the most recent tiles instead — those are
    // the ones on screen — in a cache far smaller than the texture one, since a
    // sample is needed for one point at a time.
    this.probes = new Map(); // key -> Float32Array (apron-padded samples)
    this.probeLimit = 16;
    this.probeReads = new Map(); // key -> Promise, dedupes a hover's reads
  }

  get(key) {
    const hit = this.entries.get(key);
    if (hit) hit.used = performance.now();
    return hit ? hit.texture : null;
  }

  async load(key, level, tx, ty) {
    const hit = this.get(key);
    if (hit) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const side = TILE + 2 * APRON;
    const promise = readTileQueued(level, tx, ty).then(async (samples) => {
      const { data, coast } = await packTileAsync(samples, side, this.range.heightMin, this.range.span);
      const texture = makeTileTexture(data, side, coast);
      // Pin a freshly loaded tile until the next stream update. If the visible set
      // is larger than the cache limit, an unpinned new entry would be evicted by
      // the next load before it is ever drawn, then requested again — an endless
      // reload loop. `pin()` recomputes the real set on the next frame.
      this.entries.set(key, { texture, used: performance.now(), pinned: true });
      this.rememberSamples(key, samples);
      this.inflight.delete(key);
      this.evict();
      return texture;
    });
    promise.catch(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /** Keep one decoded tile for pointer sampling, dropping the oldest past the limit. */
  rememberSamples(key, samples) {
    this.probes.delete(key);
    this.probes.set(key, samples);
    while (this.probes.size > this.probeLimit) {
      this.probes.delete(this.probes.keys().next().value);
    }
  }

  /**
   * Samples for one tile, or null while a read started here is still in flight.
   * A tile built from `load` is already kept; anything else is read once and
   * remembered, so a hover over a tile that streamed in long ago fills in shortly.
   */
  samplesFor(key, level, tx, ty) {
    const hit = this.probes.get(key);
    if (hit) {
      this.probes.delete(key); // LRU: touch
      this.probes.set(key, hit);
      return hit;
    }
    if (!this.probeReads.has(key)) {
      this.probeReads.set(key, readTileQueued(level, tx, ty)
        .then((samples) => {
          this.rememberSamples(key, samples);
          return samples;
        })
        .catch(() => null)
        .finally(() => this.probeReads.delete(key)));
    }
    return null;
  }

  pin(keys) {
    for (const entry of this.entries.values()) entry.pinned = false;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) entry.pinned = true;
    }
  }

  evict() {
    if (this.entries.size <= this.limit) return;
    const candidates = [...this.entries.entries()]
      .filter(([key, entry]) => !entry.pinned && tileKeyLevel(key) < COARSE_KEEP_LEVEL)
      .sort((a, b) => a[1].used - b[1].used);
    for (const [key, entry] of candidates) {
      if (this.entries.size <= this.limit) break;
      entry.texture.dispose();
      this.entries.delete(key);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Tile meshes
 * ------------------------------------------------------------------ */

// One geometry per level and sample step, shared by every tile at that level.
// Vertices sit on the tile's interior samples (TILE × TILE grid, or every `step`
// samples on touch), plus a skirt: a ring of vertices duplicating the outer edge,
// flagged with aSkirt = 1, that the shader drops below the surface. Skirts hide the
// small height steps where a fine tile meets a coarse one, without matching edge
// samples across levels. Each vertex carries its (i, j) sample index; the shader
// finds its texel from it.
const SKIRT_DROP_M = 60;   // how far a skirt hangs below the surface, metres
const geometryCache = new Map();
function tileGeometry(levelIndex, step = 1) {
  const cacheKey = `${levelIndex}/${step}`;
  const cached = geometryCache.get(cacheKey);
  if (cached) return cached;
  const cells = Math.round(TILE / step);
  const stride = cells + 1;
  const grid = stride * stride;

  // skirt: one extra copy of each edge vertex, linked to its neighbour
  // Walk the outline once. Each corner is listed once: the sides run [0, cells)
  // and the ring closes back to the start, so no consecutive duplicates exist.
  const edge = [];
  for (let i = 0; i < cells; i++) edge.push([i * step, 0]);
  for (let j = 0; j < cells; j++) edge.push([TILE, j * step]);
  for (let i = cells; i > 0; i--) edge.push([i * step, TILE]);
  for (let j = cells; j > 0; j--) edge.push([0, j * step]);
  const skirtStart = grid;
  const count = grid + edge.length;

  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const skirt = new Float32Array(count);
  for (let j = 0; j <= cells; j++) {
    for (let i = 0; i <= cells; i++) {
      const k = j * stride + i;
      const x = i * step;
      const z = j * step;
      positions[k * 3] = x;
      positions[k * 3 + 2] = z;
      uvs[k * 2] = x;
      uvs[k * 2 + 1] = z;
    }
  }
  edge.forEach(([i, j], n) => {
    const k = skirtStart + n;
    positions[k * 3] = i;
    positions[k * 3 + 2] = j;
    uvs[k * 2] = i;
    uvs[k * 2 + 1] = j;
    skirt[k] = 1;
  });

  const quads = cells * cells * 6;
  const skirtQuads = edge.length * 6;
  const indices = new Uint32Array(quads + skirtQuads);
  let n = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices[n++] = a; indices[n++] = c; indices[n++] = b;
      indices[n++] = b; indices[n++] = c; indices[n++] = d;
    }
  }
  // each skirt segment joins one edge sample to the next, dropping the second one
  for (let e = 0; e < edge.length; e++) {
    const [ai, aj] = edge[e];
    const [bi, bj] = edge[(e + 1) % edge.length];
    const top0 = (aj / step) * stride + ai / step;
    const top1 = (bj / step) * stride + bi / step;
    const low0 = skirtStart + e;
    const low1 = skirtStart + ((e + 1) % edge.length);
    indices[n++] = top0; indices[n++] = low0; indices[n++] = top1;
    indices[n++] = top1; indices[n++] = low0; indices[n++] = low1;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('aSkirt', new THREE.BufferAttribute(skirt, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometryCache.set(cacheKey, geometry);
  return geometry;
}

/**
 * Build a material whose shader samples a per-tile height texture. `shared` holds the
 * uniforms common to every tile (palette LUT, exaggeration, lighting, opacity, relief
 * mask). Per-tile values (texture, origin, cell size, texel size) are uniforms too,
 * so tiles at every level compile to one program.
 */
export function makeTileMaterial(shared) {
  const material = new THREE.MeshBasicMaterial();
  // Per-tile uniform holders are created now, not inside onBeforeCompile: three.js
  // first runs onBeforeCompile at render time, so a caller that set uniforms at build
  // time would find no shader yet and silently draw every tile at the default origin.
  // These same objects are referenced by the shader, so setting them any time works.
  const perTile = {
    uHeight: { value: null },
    uOrigin: { value: new THREE.Vector2() },   // world XZ of sample (0,0) of this tile
    uCell: { value: 15 },                      // level cell size, metres
    uTexel: { value: 1 / (TILE + 2 * APRON) },
    uSeaFloor: { value: SEA_FLOOR },
    uFade: { value: 1 },                      // 0..1 while a tile crossfades in
    uDepthPush: { value: 0 },                 // metres toward the camera while fading
  };
  material.userData.uniforms = perTile;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, perTile);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aSkirt;
        varying float vRelief;
        varying vec3 vTerr;
        uniform sampler2D uHeight, uLut;
        uniform float uExaggeration, uHeightMin, uSpan, uMaxH, uSeaFloor, uCell, uTexel;
        uniform float uDepthPush;
        uniform vec2 uOrigin;
        uniform vec3 uSeaColor, uContourFill, uLight;
        uniform float uContours;
        float sampleH(vec2 p) {
          float v = texture2D(uHeight, p).r;
          return v < 0.0 ? uSeaFloor : v * uSpan + uHeightMin;
        }`)
      .replace('#include <logdepthbuf_vertex>', `#include <logdepthbuf_vertex>
        #ifdef USE_LOGDEPTHBUF
          // Fading tiles are biased toward the camera by a few metres of view depth:
          // they must win the depth test against their own coarser underlay, whose
          // averaged surface can sit above them. This is a world-space offset, unlike
          // polygonOffset, which a log-depth fragment shader discards.
          vFragDepth += uDepthPush;
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // position.xz is the sample index (i, j) inside the TILE grid; world X/Z
        // follow from the tile origin and the level's cell size.
        vec2 ij = position.xz;
        transformed.x = uOrigin.x + ij.x * uCell;
        transformed.z = uOrigin.y + ij.y * uCell;
        vec2 uvT = (ij + vec2(${(APRON + 0.5).toFixed(1)})) * uTexel;
        float ownv = texture2D(uHeight, uvT).r;
        float isLand = step(0.0, ownv);
        float ownH = isLand > 0.5 ? ownv * uSpan + uHeightMin : uSeaFloor;
        // The sea floor is never scaled by exaggeration. At 0x (the flat 2D view) a
        // scaled sea would sit above the water plane and cover it with a differently
        // tinted plate, so the raster edge would show as a rectangle; keeping it at
        // depth leaves the sea plane visible from any exaggeration.
        // Skirt vertices hang below the surface so tile seams cannot show a gap.
        transformed.y = (isLand > 0.5 ? ownH * uExaggeration : ownH)
          - aSkirt * ${SKIRT_DROP_M.toFixed(1)};
        // Relief is precomputed per tile on the CPU (green channel), so the shader does
        // one texture read here instead of a 49-sample window per vertex.
        vRelief = texture2D(uHeight, uvT).g;
        float hL = sampleH(uvT - vec2(uTexel, 0.0));
        float hR = sampleH(uvT + vec2(uTexel, 0.0));
        float hU = sampleH(uvT - vec2(0.0, uTexel));
        float hD = sampleH(uvT + vec2(0.0, uTexel));
        float dhdx = uExaggeration * (hR - hL) / (2.0 * uCell);
        float dhdz = uExaggeration * (hD - hU) / (2.0 * uCell);
        float inv = inversesqrt(1.0 + dhdx * dhdx + dhdz * dhdz);
        vec3 nrm = vec3(-dhdx * inv, inv, -dhdz * inv);
        float shade = max(0.0, dot(nrm, uLight));
        float lightF = 0.45 + 0.82 * shade + 0.06 * nrm.y;
        float ramp = pow(clamp(ownH / uMaxH, 0.0, 1.0), 0.42);
        vec3 baseCol = isLand > 0.5
          ? texture2D(uLut, vec2(ramp, 0.5)).rgb
          : (uSeaColor * 0.5);
        if (uContours > 0.5) baseCol = uContourFill;
        vTerr = min(vec3(1.0), baseCol * lightF);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTerr;
        varying float vRelief;
        uniform float uDemOpacity, uFlatMask, uBlendMode, uFade;`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `vec4 diffuseColor = vec4( diffuse, opacity );
        diffuseColor.rgb = vTerr;
        float strength = uDemOpacity * mix(1.0, vRelief, uFlatMask) * uFade;
        if (uBlendMode > 1.5) diffuseColor.rgb = mix(vec3(0.0), diffuseColor.rgb, strength);
        else if (uBlendMode > 0.5) diffuseColor.rgb = mix(vec3(1.0), diffuseColor.rgb, strength);
        else diffuseColor.a *= strength;`);
    material.userData.shader = shader;
  };
  return material;
}

/* ------------------------------------------------------------------ *
 * Streaming controller
 * ------------------------------------------------------------------ */

/**
 * Owns the tile meshes for one COG. Each frame, `update(camera, viewport)` works out
 * which tiles overlap the view, picks a level per tile from its projected size, and
 * makes sure those tiles are loaded. Tiles whose level is not loaded yet keep showing
 * their coarser parent (or nothing), so the view never shows holes for long.
 */
export class TerrainStream {
  /**
   * @param {object} cog     result of openCog()
   * @param {object} opts    { origin: {x,z} world XZ of sample (0,0) of level 0,
   *                           shared: uniforms for every tile material,
   *                           scene: THREE.Scene, cache: TileCache }
   */
  constructor(cog, opts) {
    this.cog = cog;
    this.origin = opts.origin;
    this.shared = opts.shared;
    this.scene = opts.scene;
    this.cache = opts.cache || new TileCache(260);
    // Applied to each material as it is created. Blend state (terrain opacity,
    // flat-land mask) is per material and lives in the app, so the stream cannot
    // know it; without this a tile that streams in after a settings change keeps
    // the default NormalBlending and three draws it with no blending at all.
    this.materialStyle = opts.materialStyle || null;
    // 2 halves the mesh resolution in each direction (a quarter of the vertices)
    // while keeping the same texture samples; touch devices use it because the
    // vertex shader does several texture reads per vertex.
    this.geometryStep = opts.geometryStep || 1;
    // Called whenever a tile read settles, so the app can repaint: by the next
    // frame `pending` is already clear and nothing else would wake the loop.
    this.onArrival = opts.onArrival || null;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.meshes = new Map(); // key -> mesh currently drawn for the tile slot
    this.materials = new Map(); // key -> material, one per tile
    this.tick = 0;
    this.pending = new Set();
    this.failed = new Map(); // key -> time of the last failed read, for the retry above
    // Touch devices set this while a gesture is in flight: fine tile reads would
    // otherwise land mid-drag and stall the frame with decode/upload work. Coarse
    // overview reads still run so panning into a new area has a fallback surface.
    this.deferReads = false;
    // Nodes that were split last frame, so the selector can apply hysteresis.
    this.refined = new Set();
    // Depth bias (metres) for crossfading tiles, recomputed each update.
    this.depthPush = -8;
  }

  tileKey(levelIndex, tx, ty) {
    return `${levelIndex}/${tx}/${ty}`;
  }

  /** World-space rectangle of tile (levelIndex, tx, ty). */
  tileRect(levelIndex, tx, ty) {
    const level = this.cog.levels[levelIndex];
    const cell = level.cell;
    const span = TILE * cell;
    const x0 = this.origin.x + tx * span;
    const z0 = this.origin.z + ty * span;
    return { x0, z0, x1: x0 + span, z1: z0 + span, cell };
  }

  /**
   * The tiles currently drawn, with their world rectangles. Taken once per pointer
   * readout so a ray march can test many samples without recomputing geometry.
   */
  drawnTiles() {
    const tiles = [];
    for (const [key, mesh] of this.meshes) {
      if (!mesh.visible) continue;
      const { li, tx, ty } = mesh.userData.tile;
      tiles.push({ key, li, tx, ty, rect: this.tileRect(li, tx, ty) });
    }
    return tiles;
  }

  /**
   * Ground elevation in metres at world (x, z), or null where no drawn tile covers
   * the point or the samples there are no-data. `tiles` comes from drawnTiles() and
   * may be reused across samples of one ray. A normal read borrows the nearest valid
   * corner when a bilinear cell touches no-data; `strict` returns null instead, which
   * is how pointer picking and the profile charts find holes.
   */
  heightAt(x, z, tiles = this.drawnTiles(), strict = false) {
    let best = null;
    for (const tile of tiles) {
      const { x0, z0, x1, z1 } = tile.rect;
      if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
      if (!best || tile.rect.cell < best.rect.cell) best = tile;
    }
    if (!best) return null;
    const samples = this.cache.samplesFor(best.key, this.cog.levels[best.li], best.tx, best.ty);
    return samples ? tileSamplesAt(samples, best.rect, x, z, strict) : null;
  }

  /**
   * The stored height of the nearest source cell, without bilinear interpolation.
   * The hover readout uses this so the number is an actual GEM-15 sample rather than
   * a value invented between four cells.
   */
  heightAtSource(x, z, tiles = this.drawnTiles()) {
    let best = null;
    for (const tile of tiles) {
      const { x0, z0, x1, z1 } = tile.rect;
      if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
      if (!best || tile.rect.cell < best.rect.cell) best = tile;
    }
    if (!best) return null;
    const samples = this.cache.samplesFor(best.key, this.cog.levels[best.li], best.tx, best.ty);
    if (!samples) return null;
    const side = TILE + 2 * APRON;
    const i = Math.min(TILE, Math.max(0, Math.round((x - best.rect.x0) / best.rect.cell)));
    const j = Math.min(TILE, Math.max(0, Math.round((z - best.rect.z0) / best.rect.cell)));
    const h = samples[(j + APRON) * side + (i + APRON)];
    return Number.isFinite(h) ? h : null;
  }

  /**
   * Quadtree selection. Starting from the coarsest level's tiles, a tile splits into
   * its four children (one level finer) while its cells would still exceed the screen
   * target at its distance. Leaves are drawn this frame, each at the coarsest level
   * that meets the target, so full 15 m detail appears only where the camera is close
   * enough to resolve it.
   *
   * A node that split last frame keeps splitting until its cells fall below
   * MERGE_MARGIN × the target; a node that did not keeps merging until they rise
   * above SPLIT_MARGIN × the target. The dead band between the two stops a tile on
   * the threshold from flipping level every frame as the camera drifts.
   *
   * @returns {Array<{li, tx, ty}>} leaves to draw
   */
  select(camera, viewportHeight, fovDeg, cellPxTarget = CELL_PX_TARGET) {
    const levels = this.cog.levels;
    const top = levels.length - 1;
    const topCells = tileCount(levels[top]);
    const leaves = [];
    const wasRefined = this.refined;
    const nowRefined = new Set();
    const pxPerM = (distance) =>
      viewportHeight / (2 * Math.tan((fovDeg * Math.PI) / 360) * Math.max(distance, 1));

    const visit = (li, tx, ty) => {
      const r = this.tileRect(li, tx, ty);
      const cx = (r.x0 + r.x1) / 2;
      const cz = (r.z0 + r.z1) / 2;
      const distance = Math.hypot(cx - camera.position.x, camera.position.y, cz - camera.position.z);
      const key = this.tileKey(li, tx, ty);
      const metric = (r.cell * pxPerM(distance)) / cellPxTarget;
      const margin = wasRefined.has(key) ? MERGE_MARGIN : SPLIT_MARGIN;
      if (li === 0 || metric <= margin) {
        leaves.push({ li, tx, ty });
        return;
      }
      nowRefined.add(key);
      const child = li - 1;
      const cc = tileCount(levels[child]);
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const ctx = tx * 2 + dx;
          const cty = ty * 2 + dy;
          if (ctx < cc.cols && cty < cc.rows) visit(child, ctx, cty);
        }
      }
    };

    for (let ty = 0; ty < topCells.rows; ty++) {
      for (let tx = 0; tx < topCells.cols; tx++) visit(top, tx, ty);
    }
    this.refined = nowRefined;
    return leaves;
  }

  /**
   * Draw the selected leaves and request any that are not loaded. A leaf that is not
   * loaded yet falls back to its nearest loaded ancestor, so the view does not show a
   * hole while the finer tile streams in.
   */
  update(camera, viewportHeight, fovDeg, cellPxTarget = CELL_PX_TARGET) {
    const leaves = this.select(camera, viewportHeight, fovDeg, cellPxTarget);
    const wantKeys = new Set();
    const resolved = new Map(); // drawn key -> { key, li, tx, ty }
    for (const { li, tx, ty } of leaves) {
      wantKeys.add(this.tileKey(li, tx, ty));
      const drawn = this.resolveDraw(li, tx, ty);
      if (drawn) resolved.set(drawn.key, drawn);
    }

    // A coarse tile drawn as a fallback covers its whole quadrant, including any
    // finer leaves inside it whose own tile is already loaded. Drawing both puts two
    // surfaces at slightly different heights (the overview averages the detail) in the
    // same place, and they interpenetrate as the camera moves — the flicker. So a
    // fallback tile owns its quadrant: a resolved tile that sits inside a coarser
    // resolved tile is hidden until every sibling at its level has loaded and the
    // fallback is no longer needed.
    const drawKeys = new Set();
    for (const entry of resolved.values()) {
      if (!this.hasDrawnAncestor(entry, resolved)) drawKeys.add(entry.key);
    }

    // Crossfade and grace hold. Multiply and screen cannot crossfade (two blended
    // surfaces compound each other), so they keep the hard swap; the hold still
    // applies there, so tiles are not dropped before their replacements exist.
    const canFade = !this.shared.uBlendMode || this.shared.uBlendMode.value === 0;
    // The coarse/fine height step grows with vertical exaggeration, so the fading
    // tile's depth bias has to grow with it too.
    const exaggeration = this.shared.uExaggeration ? this.shared.uExaggeration.value : 0;
    this.depthPush = -(8 + 6 * exaggeration);
    const now = performance.now();

    // Which tiles are about to fade in: they are newly drawn, or returning after
    // being hidden. A tile with nothing visible beneath it appears at once — a fade
    // from an empty background reads as a flash, not a transition.
    const appearing = new Set();
    if (canFade) {
      for (const entry of resolved.values()) {
        if (!drawKeys.has(entry.key)) continue;
        const mesh = this.meshes.get(entry.key);
        if (!mesh) continue;
        if (mesh.userData.faded && !mesh.visible) {
          mesh.userData.faded = false;
          mesh.userData.fadeStart = null;
        }
        if (!mesh.userData.faded) appearing.add(entry.key);
      }
      for (const key of appearing) {
        const mesh = this.meshes.get(key);
        const rect = this.meshRect(mesh);
        let backdrop = false;
        for (const [otherKey, other] of this.meshes) {
          if (otherKey === key || !other.visible) continue;
          if (rectsOverlap(rect, this.meshRect(other))) {
            backdrop = true;
            break;
          }
        }
        if (!backdrop) {
          mesh.userData.faded = true;
          appearing.delete(key);
        }
      }
    }

    // Keep the current surface up while its replacement streams in. A visible tile
    // that is no longer selected stays as a backdrop while a selected tile over it is
    // still fading, and for a grace period when no opaque tile has taken its place
    // yet. A tile fully covered by an opaque *coarser* tile is dropped at once: two
    // opaque surfaces in the same place is the shimmer this pipeline avoids. Finer
    // descendants never block a hold (they are the ones fading in over it).
    const heldKeys = new Set();
    for (const [key, mesh] of this.meshes) {
      if (!mesh.visible || drawKeys.has(key)) continue;
      const tile = mesh.userData.tile;
      const rect = this.meshRect(mesh);
      let backdrop = false;
      let blocked = false;
      let descendantDrawn = false;
      for (const otherKey of drawKeys) {
        const other = this.meshes.get(otherKey);
        if (!other) continue;
        if (!rectsOverlap(rect, this.meshRect(other))) continue;
        const otherTile = other.userData.tile;
        if (otherTile.li < tile.li) {
          // A finer descendant is drawn over this tile: it is the replacement.
          descendantDrawn = true;
          if (appearing.has(otherKey) || other.userData.fadeStart != null) backdrop = true;
        } else if (otherTile.li > tile.li) {
          // A coarser ancestor covers this tile: hold only while it is fading.
          if (appearing.has(otherKey) || other.userData.fadeStart != null) backdrop = true;
          else blocked = true;
        }
      }
      if (blocked) continue;
      if (backdrop) {
        mesh.userData.holdUntil = now + TILE_HOLD_MS;
      } else if (descendantDrawn || !(mesh.userData.holdUntil > now)) {
        // Fully covered by opaque descendants, or the grace period has run out.
        continue;
      }
      // A held tile is an old surface, not one appearing: it must not start a fresh
      // fade from zero while it is being used as a backdrop.
      if (mesh.userData.fadeStart == null) mesh.userData.faded = true;
      heldKeys.add(key);
      drawKeys.add(key);
    }

    // Draw this frame's tiles and retire the rest. Meshes and their materials are
    // removed once a tile has gone unused for a while: keeping every tile ever drawn
    // grows without bound as the camera moves, and a long session runs out of memory.
    // Report whether the drawn set changed (a tile arrived, appeared or was
    // retired), so the caller knows a repaint is due without diffing itself.
    let changed = false;
    this.tick++;
    for (const [key, mesh] of this.meshes) {
      if (drawKeys.has(key)) {
        // a mesh with no lastDrawn was created this pass — its texture just landed
        if (!mesh.visible || mesh.userData.lastDrawn === undefined) changed = true;
        mesh.visible = true;
        mesh.userData.lastDrawn = this.tick;
        // A held tile is on borrowed time: refreshing its deadline every frame would
        // keep a stale surface around for ever.
        if (!heldKeys.has(key)) mesh.userData.holdUntil = now + TILE_HOLD_MS;
        if (this.stepFade(key, mesh, now, canFade)) changed = true;
        continue;
      }
      if (mesh.visible) {
        // A tile hidden mid-fade has not finished appearing; restore it to opaque and
        // let it start a fresh fade if it comes back, rather than resuming from an old
        // timestamp (or reappearing at whatever alpha it was hidden at).
        if (mesh.userData.fadeStart != null) {
          mesh.userData.fadeStart = null;
          this.applyFade(this.materials.get(key), 1);
        }
        mesh.visible = false;
        changed = true;
      }
      if (this.tick - (mesh.userData.lastDrawn || 0) > 240) {
        this.retire(key, mesh);
        changed = true;
      }
    }
    this.cache.pin([...wantKeys, ...drawKeys]);
    return changed;
  }

  /**
   * Advance this tile's fade. A newly drawn tile starts at 0 and reaches 1 after
   * TILE_FADE_MS; the frame after it lands is spent restoring the material's normal
   * blend state, once its underlay has been dropped. Returns true while animating (or
   * on that restore frame), so the caller keeps repainting.
   */
  stepFade(key, mesh, now, canFade) {
    const material = this.materials.get(key);
    let start = mesh.userData.fadeStart;
    if (start == null) {
      if (material && material.userData.fading) {
        // The frame after the fade finished: its fallback was dropped last frame, so
        // the normal opaque/blend state can come back now.
        this.applyFade(material, 1);
        return true;
      }
      if (mesh.userData.faded) return false;
      // Fading is off (Multiply or Screen blending): this tile is already fully
      // visible, and it must not start fading later just because the mode changed.
      if (!canFade) {
        mesh.userData.faded = true;
        return false;
      }
      mesh.userData.fadeStart = start = now;
    }
    const fade = Math.min(1, (now - start) / TILE_FADE_MS);
    if (fade >= 1) {
      // Full colour, but stay transparent for this frame: the fallback beneath it is
      // still in this frame's draw set, and restoring depth writes here would put two
      // opaque surfaces in the same place for a frame.
      mesh.userData.fadeStart = null;
      mesh.userData.faded = true;
      const uniforms = material && material.userData.uniforms;
      if (uniforms && uniforms.uFade) uniforms.uFade.value = 1;
      return true;
    }
    this.applyFade(material, fade);
    return true;
  }

  /**
   * A fading tile is transparent, does not write depth, and is biased toward the
   * camera so it draws over its own fallback instead of z-fighting with it. Restoring
   * hands the material back to the app's blend rule, which knows the current terrain
   * opacity and flat-land mask.
   */
  applyFade(material, fade) {
    if (!material) return;
    const uniforms = material.userData.uniforms;
    if (uniforms && uniforms.uFade) uniforms.uFade.value = fade;
    const fading = fade < 1;
    if (uniforms && uniforms.uDepthPush) uniforms.uDepthPush.value = fading ? this.depthPush : 0;
    if (material.userData.fading === fading) return;
    material.userData.fading = fading;
    if (fading) {
      material.transparent = true;
      material.depthWrite = false;
    } else {
      material.depthWrite = true;
      if (this.materialStyle) this.materialStyle(material);
      else material.transparent = false;
    }
  }

  /** World rectangle of a mesh's tile. */
  meshRect(mesh) {
    const tile = mesh.userData.tile;
    return this.tileRect(tile.li, tile.tx, tile.ty);
  }

  /** True if any drawn tile is a coarser ancestor of `entry`. */
  hasDrawnAncestor(entry, resolved) {
    let li = entry.li;
    let tx = entry.tx;
    let ty = entry.ty;
    const top = this.cog.levels.length - 1;
    while (li < top) {
      li += 1;
      tx = Math.floor(tx / 2);
      ty = Math.floor(ty / 2);
      if (resolved.has(this.tileKey(li, tx, ty))) return true;
    }
    return false;
  }

  /**
   * Draw tile (li, tx, ty) if loaded, else request it and draw the nearest loaded
   * ancestor. Returns the drawn tile `{ key, li, tx, ty }`, or null if nothing at
   * this location is loaded yet.
   */
  resolveDraw(li, tx, ty) {
    let l = li;
    let x = tx;
    let y = ty;
    for (;;) {
      const key = this.tileKey(l, x, y);
      if (this.cache.get(key)) {
        this.show(l, x, y);
        if (l !== li) this.request(li, tx, ty, this.tileKey(li, tx, ty));
        return { key, li: l, tx: x, ty: y };
      }
      if (l === this.cog.levels.length - 1) {
        // Nothing on this path is loaded (a cold start, or every level evicted): ask
        // for the coarsest tile as well as the leaf, so a fallback can appear now
        // instead of leaving a hole until the fine read lands.
        this.request(l, x, y, this.tileKey(l, x, y));
        this.request(li, tx, ty, this.tileKey(li, tx, ty));
        return null;
      }
      l += 1;
      x = Math.floor(x / 2);
      y = Math.floor(y / 2);
    }
  }

  retire(key, mesh) {
    this.group.remove(mesh);
    this.meshes.delete(key);
    const material = this.materials.get(key);
    if (material) {
      material.dispose();
      this.materials.delete(key);
    }
  }

  /** Every tile material created so far (for blend state changes). */
  allMaterials() {
    return [...this.materials.values()];
  }

  /** Show tile (li, tx, ty) if loaded, otherwise start loading it. */
  show(li, tx, ty) {
    const key = this.tileKey(li, tx, ty);
    const texture = this.cache.get(key);
    if (!texture) {
      this.request(li, tx, ty, key);
      return;
    }
    let mesh = this.meshes.get(key);
    if (!mesh) {
      const material = this.materialFor(key);
      mesh = this.buildMesh(li, tx, ty, texture, material);
      this.meshes.set(key, mesh);
      this.group.add(mesh);
    }
  }

  materialFor(key) {
    let material = this.materials.get(key);
    if (!material) {
      material = makeTileMaterial(this.shared);
      if (this.materialStyle) this.materialStyle(material);
      this.materials.set(key, material);
    }
    return material;
  }

  buildMesh(li, tx, ty, texture, material) {
    const r = this.tileRect(li, tx, ty);
    // Coast tiles keep full mesh resolution; the mobile step only decimates wholly
    // interior or wholly sea tiles, where it cannot flatten the island outline.
    const step = texture.userData.coast ? 1 : this.geometryStep;
    const mesh = new THREE.Mesh(tileGeometry(li, step), material);
    mesh.frustumCulled = false;
    const u = material.userData.uniforms;
    u.uHeight.value = texture;
    u.uOrigin.value.set(r.x0, r.z0);
    u.uCell.value = r.cell;
    mesh.userData.tile = { li, tx, ty };
    return mesh;
  }

  request(li, tx, ty, key) {
    // While a touch gesture is moving the camera, only let the coarsest overview
    // through. Fine reads resume after the settle delay, when their upload cannot
    // compete with the interaction frames.
    if (this.deferReads && this.meshes.size > 0
      && li < this.cog.levels.length - 1) return;
    const failedAt = this.failed.get(key);
    if (failedAt !== undefined) {
      if (performance.now() - failedAt < TILE_RETRY_MS) return;
      this.failed.delete(key);
    }
    if (this.pending.has(key)) return;
    this.pending.add(key);
    const level = this.cog.levels[li];
    this.cache.load(key, level, tx, ty)
      .catch((error) => {
        this.failed.set(key, performance.now());
        console.warn('[terrain] tile failed', key, error);
      })
      .finally(() => {
        this.pending.delete(key);
        if (this.onArrival) this.onArrival();
      });
  }
}
