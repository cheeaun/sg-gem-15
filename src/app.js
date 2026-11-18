/**
 * Singapore — Digital Elevation Model viewer.
 *
 * Everything is rendered from the GEM-15 DTM exported by
 * `pipeline/gem15_singapore.py` into ./data/gem15_singapore/.
 */
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import {
  openCog, TerrainStream, TileCache, readTileQueued, TILE, APRON,
  CELL_PX_TARGET_TOUCH,
} from './terrain-cog.js';

// Touch-first devices get a cheaper render: lower fill rate, no MSAA, a coarser LOD
// target, deferred fine-tile reads during gestures, and a smaller tile cache. The
// geometry is the expensive part on mobile GPUs, not the download.
const TOUCH_UI = window.matchMedia('(pointer: coarse)').matches
  && window.matchMedia('(hover: none)').matches;
const PIXEL_RATIO_CAP = TOUCH_UI ? 1.5 : 2;
const TILE_SETTLE_MS = 160;
const LOD_CELL_PX = TOUCH_UI ? CELL_PX_TARGET_TOUCH : undefined;
const TILE_CACHE_LIMIT = TOUCH_UI ? 96 : 160;

const MANIFEST_URL = 'gem15_singapore/manifest.json';
// Shared uniform holders for every tile material; set in buildScene().
let shared = null;

/* ------------------------------------------------------------------ *
 * Palettes — perceptual scientific ramps. Stops are 0..1 of the highest
 * point on the island.
 * ------------------------------------------------------------------ */
const PALETTES = [
  {
    id: 'rdylgn',
    name: 'RdYlGn',
    sea: '#0b1b12',
    stops: [
      [0.0, '#006837'], [0.1, '#1a9850'], [0.2, '#66bd63'], [0.3, '#a6d96a'],
      [0.4, '#d9ef8b'], [0.5, '#ffffbf'], [0.6, '#fee08b'], [0.7, '#fdae61'],
      [0.8, '#f46d43'], [0.9, '#d73027'], [1.0, '#a50026'],
    ],
  },
  {
    id: 'turbo',
    name: 'Turbo',
    sea: '#0a0824',
    stops: [
      [0.0, '#30123b'], [0.0714, '#4145ab'], [0.1429, '#4675ed'], [0.2143, '#39a2fc'],
      [0.2857, '#1bcfd4'], [0.3571, '#24eca6'], [0.4286, '#61fc6c'], [0.5, '#a4fc3b'],
      [0.5714, '#d1e834'], [0.6429, '#f3c63a'], [0.7143, '#fe9b2d'], [0.7857, '#f36315'],
      [0.8571, '#d93806'], [0.9286, '#b11901'], [1.0, '#7a0403'],
    ],
  },
  {
    id: 'viridis',
    name: 'Viridis',
    sea: '#071b25',
    stops: [
      [0.0, '#440154'], [0.125, '#472d7b'], [0.25, '#3b528b'], [0.375, '#2c728e'],
      [0.5, '#21918c'], [0.625, '#28ae80'], [0.75, '#5ec962'], [0.875, '#addc30'],
      [1.0, '#fde725'],
    ],
  },
  {
    id: 'plasma',
    name: 'Plasma',
    sea: '#120a24',
    stops: [
      [0.0, '#0d0887'], [0.125, '#4c02a1'], [0.25, '#7e03a8'], [0.375, '#aa2395'],
      [0.5, '#cc4778'], [0.625, '#e66c5c'], [0.75, '#f89540'], [0.875, '#fdc527'],
      [1.0, '#f0f921'],
    ],
  },
  {
    id: 'ylgnbu',
    name: 'YlGnBu',
    sea: '#071f2d',
    stops: [
      [0.0, '#ffffd9'], [0.125, '#edf8b1'], [0.25, '#c7e9b4'], [0.375, '#7fcdbb'],
      [0.5, '#41b6c4'], [0.625, '#1d91c0'], [0.75, '#225ea8'], [0.875, '#253494'],
      [1.0, '#081d58'],
    ],
  },
];

const SEA_FLOOR = -90;      // metres: no-data cells sink below the opaque sea plane
const LUT_SIZE = 512;

const PLAN_TILT = Math.PI / 2 - 0.015; // near top-down default view, off the pole by ~0.9°
const TILT_3D = THREE.MathUtils.degToRad(52);   // 3D view: oblique elevation angle
const POLAR_2D = Math.PI / 2 - PLAN_TILT;        // orbit polar angle matching PLAN_TILT
const POLAR_MAX = Math.PI * 0.492;               // near-horizontal tilt limit
const CONTOUR_INTERVAL = 10;       // metres between contour lines
const CONTOUR_INDEX_EVERY = 5;     // every fifth line is an index contour (50 m)
const CONTOUR_LIFT = 2;            // world metres above the surface, avoids z-fighting
const CONTOUR_LABEL_LIFT = 2.6;
const CONTOUR_MIN_LABEL_LENGTH = 700;  // shorter loops are too small to carry a label
const CONTOUR_LABEL_SPACING = 6500;     // metres of line between repeated labels

/* ------------------------------------------------------------------ *
 * Colour helpers (sRGB hex -> linear-sRGB for vertex colours)
 * ------------------------------------------------------------------ */
function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function hexToLinear(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [
    srgbToLinear(((n >> 16) & 255) / 255),
    srgbToLinear(((n >> 8) & 255) / 255),
    srgbToLinear((n & 255) / 255),
  ];
}

// The sea plane fills the stage around the island. Its palette colour is a dark
// tint that matches the dark theme; on a light page that same fill reads as a
// black hole, so lift it toward white to sit with the light background.
const SEA_LIGHT_MIX = 0.86;

function lightenHex(hex, amount) {
  const n = parseInt(hex.replace('#', ''), 16);
  const channel = (c) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
  return `#${channel((n >> 16) & 255)}${channel((n >> 8) & 255)}${channel(n & 255)}`;
}

function seaHex(hex = state.palette.sea) {
  return themeQuery.matches ? hex : lightenHex(hex, SEA_LIGHT_MIX);
}

// Contour mode drops the terrain ramp for a neutral, shaded surface; the
// lines and labels carry the elevation instead.
const CONTOUR_FILL = hexToLinear('#26302b');
const CONTOUR_SEA = '#081315';

function paletteStops(palette) {
  if (palette.stops) return palette.stops.map(([t, hex]) => [t, hexToLinear(hex)]);
  return palette.colors.map((hex, i) => [
    i / (palette.colors.length - 1),
    hexToLinear(hex),
  ]);
}

function sampleStops(stops, t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    if (t <= t1) {
      const [t0, c0] = stops[i - 1];
      const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return [
        c0[0] + (c1[0] - c0[0]) * f,
        c0[1] + (c1[1] - c0[1]) * f,
        c0[2] + (c1[2] - c0[2]) * f,
      ];
    }
  }
  return stops[stops.length - 1][1];
}

function linearToSrgb(v) {
  v = Math.min(1, Math.max(0, v));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function relativeLuminance([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Palette colours are authored for broad terrain fills, so the darkest ones
// disappear as 1 px lines. Lift them toward white rather than scaling channels:
// scaling clips the dominant channels of near-black colours (Viridis at sea
// level turned pink) while mixing keeps the hue and lands on the target
// luminance exactly.
function liftLinear(rgb, minLuminance) {
  const luminance = relativeLuminance(rgb);
  if (luminance >= minLuminance) return rgb;
  const f = (minLuminance - luminance) / Math.max(1 - luminance, 1e-4);
  return [
    rgb[0] + (1 - rgb[0]) * f,
    rgb[1] + (1 - rgb[1]) * f,
    rgb[2] + (1 - rgb[2]) * f,
  ];
}

function contourPaletteRgb(level) {
  const palette = state.palette;
  const stops = paletteStops(palette);
  let t = Math.min(1, Math.max(0, level / Math.max(1, currentMaxHeight))) ** 0.42;
  if (palette.bands) t = (Math.floor(t * palette.bands) + 0.5) / palette.bands;
  return sampleStops(stops, t);
}

function contourLineRgb(level) {
  return liftLinear(contourPaletteRgb(level), 0.55);
}

function contourTextColor(level) {
  const [r, g, b] = liftLinear(contourPaletteRgb(level), 0.68);
  return `rgb(${Math.round(linearToSrgb(r) * 255)}, `
    + `${Math.round(linearToSrgb(g) * 255)}, `
    + `${Math.round(linearToSrgb(b) * 255)})`;
}

function buildLut(palette) {
  const stops = paletteStops(palette);
  const lut = new Float32Array(LUT_SIZE * 3);
  for (let i = 0; i < LUT_SIZE; i++) {
    let t = i / (LUT_SIZE - 1);
    if (palette.bands) t = (Math.floor(t * palette.bands) + 0.5) / palette.bands;
    const [r, g, b] = sampleStops(stops, t);
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  return lut;
}

/* ------------------------------------------------------------------ *
 * Scene
 * ------------------------------------------------------------------ */
const canvas = document.getElementById('scene');
const mapPane = document.getElementById('map');
// The canvas fills the map pane, not the window. These are the CSS-pixel
// dimensions the camera, contour labels and fit all use; measureMap() refreshes
// them whenever the pane changes size (including an orientation change).
let viewWidth = 1;
let viewHeight = 1;
function measureMap() {
  const rect = canvas.getBoundingClientRect();
  viewWidth = Math.max(1, Math.round(rect.width));
  viewHeight = Math.max(1, Math.round(rect.height));
}
measureMap();

const renderer = new THREE.WebGLRenderer({
  canvas,
  // MSAA is a large fill-rate cost on mobile Safari's tiled GPU; the reduced pixel
  // ratio already keeps the terrain edges dense enough.
  antialias: !TOUCH_UI,
  alpha: true,
  powerPreference: 'high-performance',
  // 200 m to 2,000 km is a depth range no 24-bit buffer handles cleanly; without
  // a logarithmic buffer the sea plane and the 0 m terrain coplanar with it
  // z-fight, which shows up as flicker while the camera moves.
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP));
renderer.setClearColor(0x000000, 0);

function maxAnisotropy() {
  const max = renderer.capabilities.getMaxAnisotropy();
  return TOUCH_UI ? Math.min(4, max) : max;
}

const scene = new THREE.Scene();
const themeQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applySceneTheme() {
  if (state.water) updateWaterTint();
  if (state.terrain) updateTerrainUniforms();
  scheduleTerrainTip();
  invalidate();
}
themeQuery.addEventListener('change', applySceneTheme);

const camera = new THREE.PerspectiveCamera(42, 1, 200, 2000000);

const controls = new MapControls(camera, renderer.domElement);
// Damping is off: OrbitControls' damping only trades drag lag for a release glide,
// so a drag would trail the pointer. Without it a drag applies in the frame the
// pointer moves, which is the 1:1 feel. The post-release glide is supplied instead
// by stepInertia(), which starts from the velocity measured during the drag.
controls.enableDamping = false;
controls.rotateSpeed = 1;
controls.panSpeed = 1;
controls.zoomSpeed = 2.2;
controls.screenSpacePanning = false;
controls.maxPolarAngle = POLAR_MAX;
controls.zoomToCursor = true;
// Touch: one finger pans; two fingers pinch to zoom, pan in the flat 2D map, tilt in
// 3D, and twist to rotate. setView3D() switches the two-finger mapping with the mode.
controls.touches.ONE = THREE.TOUCH.PAN;
controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
// OrbitControls maps two-finger midpoint drag to azimuth rotation, which reads as
// the map sliding sideways rather than turning. Keep its vertical tilt and pinch,
// suppress that midpoint azimuth, and drive azimuth from a real two-finger twist
// instead — the gesture maps use.
const orbitRotateLeft = controls._rotateLeft.bind(controls);
let touchMidpointRotate = false;
controls._rotateLeft = (angle) => {
  if (!touchMidpointRotate) orbitRotateLeft(angle);
};
const touchMoveRotate = controls._handleTouchMoveRotate.bind(controls);
controls._handleTouchMoveRotate = (event) => {
  touchMidpointRotate = true;
  try {
    touchMoveRotate(event);
  } finally {
    touchMidpointRotate = false;
  }
};

// Twist tracking uses capture-phase pointer events so the angle update lands in
// OrbitControls' spherical delta before its own move handler calls update().
const touchTwist = new Map();
let twistAngle = null;
function twoFingerAngle() {
  const [a, b] = touchTwist.values();
  return Math.atan2(b.y - a.y, b.x - a.x);
}
function rememberTwist() {
  twistAngle = touchTwist.size === 2 ? twoFingerAngle() : null;
}
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'touch') return;
  touchTwist.set(event.pointerId, { x: event.clientX, y: event.clientY });
  rememberTwist();
}, true);
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!touchTwist.has(event.pointerId)) return;
  touchTwist.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (touchTwist.size !== 2) {
    twistAngle = null;
    return;
  }
  const angle = twoFingerAngle();
  if (twistAngle !== null) {
    let delta = angle - twistAngle;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    // Positive theta turns the map clockwise; the screen-space angle grows clockwise
    // too, so the map follows the fingers. `_rotateLeft` subtracts from theta.
    if (delta !== 0) orbitRotateLeft(-delta);
  }
  twistAngle = angle;
}, true);
function endTouchTwist(event) {
  if (!touchTwist.delete(event.pointerId)) return;
  rememberTwist();
}
renderer.domElement.addEventListener('pointerup', endTouchTwist, true);
renderer.domElement.addEventListener('pointercancel', endTouchTwist, true);


// All lighting is baked into the vertex colours, so the scene needs no lights.

const state = {
  palette: PALETTES[0],
  exaggeration: 1,
  mode3D: false,   // 2D by default: the terrain drawn flat, the camera locked top-down
  lut: buildLut(PALETTES[0]),
  maxHeight: 1,
  terrain: null,
  water: null,
  baseMapOn: false,
  baseMapStyle: 'default',
  blendMode: 'normal',
  flatMask: false,
  contoursOn: false,
  contour: null,
  sourcePixelSize: 15,
  fitDistance: 0,
  opacity: 1,
  geo: null,
  size: 1,
};

// Fixed-function WebGL can do these three compositing modes without sampling the
// base map inside the terrain shader. Multiply suits the cartographic styles;
// Screen keeps shadowed orthophoto detail visible instead of crushing it.
const BLEND_MODES = [
  { id: 'normal', name: 'Normal', value: 0 },
  { id: 'multiply', name: 'Multiply', value: 1 },
  { id: 'screen', name: 'Screen', value: 2 },
];
const blendModeValue = () => (
  BLEND_MODES.find((mode) => mode.id === state.blendMode) || BLEND_MODES[0]
).value;

const WATER_Y = -1.5;  // below the 0 m terrain, so the two never share a depth
const MAP_Y = -6;      // overview map, under the terrain it annotates
const MAP_DETAIL_Y = MAP_Y + 2; // streamed tiles, layered over the overview

const lightDir = new THREE.Vector3(
  Math.cos(THREE.MathUtils.degToRad(38)) * Math.sin(THREE.MathUtils.degToRad(305)),
  Math.sin(THREE.MathUtils.degToRad(38)),
  -Math.cos(THREE.MathUtils.degToRad(38)) * Math.cos(THREE.MathUtils.degToRad(305)),
).normalize();

let currentMaxHeight = 1;

// The exaggeration actually applied. In 2D the terrain is drawn flat (0×) so it
// reads as a top-down colour map; the slider's value is kept for the return to 3D.
function effectiveExaggeration() {
  return state.mode3D ? state.exaggeration : 0;
}

function updateTerrainUniforms() {
  // Palette: rewrite the shared LUT texture. Exaggeration, max height and sea colour
  // are shared uniform holders, so every tile sees the change with no per-tile loop.
  if (!shared) return;
  const lutTex = shared.uLut.value;
  const data = lutTex.image.data;
  const lut = state.lut;
  for (let i = 0; i < LUT_SIZE; i++) {
    const s = i * 3;
    const d = i * 4;
    data[d] = lut[s];
    data[d + 1] = lut[s + 1];
    data[d + 2] = lut[s + 2];
    data[d + 3] = 1;
  }
  lutTex.needsUpdate = true;
  const sea = hexToLinear(seaHex());
  shared.uExaggeration.value = effectiveExaggeration();
  shared.uMaxH.value = Math.max(1, currentMaxHeight);
  shared.uSeaColor.value.set(sea[0], sea[1], sea[2]);
  shared.uContours.value = state.contoursOn ? 1 : 0;
  invalidate();
}

function applyPalette(palette) {
  state.palette = palette;
  state.lut = buildLut(palette);
  if (state.terrain) updateTerrainUniforms();
  if (state.contoursOn) recolorContours();
  updateWaterTint();
  updateLegend();
  scheduleTerrainTip();
}

function updateWaterTint() {
  if (!state.water) return;
  state.water.material.color.set(seaHex(state.contoursOn ? CONTOUR_SEA : state.palette.sea));
  invalidate();
}

/* ------------------------------------------------------------------ *
 * Contour mode — contours the terrain triangles, with one polyline per
 * level segment and screen-sized labels along the longer lines. The
 * terrain shader drops its ramp while this mode is on; the line geometry
 * is built once and only scaled in Y with exaggeration.
 * ------------------------------------------------------------------ */
function traceContourPolylines(segments, edgePoints) {
  const byEdge = new Map();
  for (let i = 0; i < segments.length; i++) {
    const { a, b } = segments[i];
    let list = byEdge.get(a);
    if (!list) byEdge.set(a, (list = []));
    list.push(i);
    list = byEdge.get(b);
    if (!list) byEdge.set(b, (list = []));
    list.push(i);
  }

  const visited = new Uint8Array(segments.length);
  const lines = [];

  const walk = (startSegment, startEdge) => {
    const points = [edgePoints.get(startEdge)];
    let segmentIndex = startSegment;
    let edge = startEdge;
    for (;;) {
      visited[segmentIndex] = 1;
      const segment = segments[segmentIndex];
      const nextEdge = segment.a === edge ? segment.b : segment.a;
      points.push(edgePoints.get(nextEdge));
      if (nextEdge === startEdge) break;
      const options = byEdge.get(nextEdge);
      let next = -1;
      for (let k = 0; k < options.length; k++) {
        if (!visited[options[k]]) { next = options[k]; break; }
      }
      if (next === -1) break;
      segmentIndex = next;
      edge = nextEdge;
    }
    return points;
  };

  // Open lines start at a dangling edge; closed loops have none.
  for (let i = 0; i < segments.length; i++) {
    if (visited[i]) continue;
    const { a, b } = segments[i];
    const startEdge = byEdge.get(a).length === 1
      ? a
      : byEdge.get(b).length === 1 ? b : -1;
    if (startEdge === -1) continue;
    const points = walk(i, startEdge);
    if (points.length > 1) lines.push(points);
  }
  for (let i = 0; i < segments.length; i++) {
    if (visited[i]) continue;
    const points = walk(i, segments[i].a);
    if (points.length > 1) lines.push(points);
  }
  return lines;
}

function contourLabelAnchors(line, levelIndex, lineIndex) {
  const distances = [0];
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    total += Math.hypot(
      line[i][0] - line[i - 1][0],
      line[i][1] - line[i - 1][1],
    );
    distances.push(total);
  }
  if (total < CONTOUR_MIN_LABEL_LENGTH) return null;

  const count = total < CONTOUR_LABEL_SPACING * 1.5
    ? 1
    : Math.min(3, Math.round(total / CONTOUR_LABEL_SPACING));
  // Stagger where along parallel lines labels land, so neighbouring levels do
  // not stack their numbers on the same slope.
  const phase = ((levelIndex * 5 + lineIndex * 3) % 7) / 7;
  const anchors = [];
  for (let k = 0; k < count; k++) {
    let fraction = count === 1
      ? 0.08 + 0.84 * phase
      : (k + 0.5 + 0.8 * (phase - 0.5)) / count;
    fraction = Math.min(0.94, Math.max(0.06, fraction));
    const target = total * fraction;

    let i = 1;
    while (i < distances.length && distances[i] < target) i++;
    if (i >= line.length) { anchors.push(line[line.length - 1]); continue; }
    const span = distances[i] - distances[i - 1];
    const t = span > 0 ? (target - distances[i - 1]) / span : 0;
    anchors.push([
      line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t,
      line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t,
    ]);
  }
  return { anchors, total };
}

function contourLabelTexture(text, strong, options = {}) {
  const { fill = '#eef3e6', halo = 1 } = options;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const font = `${strong ? 700 : 600} 62px ui-sans-serif, -apple-system, `
    + '"SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif';
  context.font = font;
  context.letterSpacing = '1px';
  canvas.width = Math.ceil((context.measureText(text).width + 44) / 2) * 2;
  canvas.height = 104;
  context.font = font;
  context.letterSpacing = '1px';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  context.lineWidth = 7 * halo;
  context.strokeStyle = `rgba(4, 9, 8, ${0.9 * Math.min(1, halo)})`;
  context.strokeText(text, canvas.width / 2, canvas.height / 2 + 2);
  context.fillStyle = fill;
  context.fillText(text, canvas.width / 2, canvas.height / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = maxAnisotropy();
  return { texture, aspect: canvas.width / canvas.height };
}

/* --- Tiled contour mode -------------------------------------------------
 * Contours are built one tile at a time, from the tile's own level samples, so
 * detail matches the terrain LOD: full 15 m contours where level 0 is drawn,
 * coarser lines where a coarser level is. Each tile carries its apron, so the
 * crossings on a shared edge are identical on both sides and the lines join.
 * Building is spread across frames against a time budget, so enabling contours
 * never blocks a frame.
 * ---------------------------------------------------------------------- */
const CONTOUR_BUILD_BUDGET_MS = 6;
const CONTOUR_SETTLE_MS = 220; // wait for the camera to stop before building contours
// A tile that failed all of its read attempts is retried after a pause rather than
// being blank for the rest of the session (see processContourQueue).
const CONTOUR_RETRY_MS = 8000;

function contourKey(li, tx, ty) {
  return `${li}/${tx}/${ty}`;
}

// Bias a line material toward the camera in logarithmic depth space so the small
// world-space lift stays in front of the terrain instead of breaking into dashes.
function biasContourDepth(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <logdepthbuf_vertex>',
      '#include <logdepthbuf_vertex>\n'
      + '#ifdef USE_LOGDEPTHBUF\n'
      + '  vFragDepth *= 0.997;\n'
      + '#endif',
    );
  };
}

function contourLineMaterial(width, opacity, resolution) {
  const material = new LineMaterial({
    vertexColors: true,
    linewidth: width,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: true,
    fog: false,
    worldUnits: false,
  });
  material.resolution.set(resolution.x, resolution.y);
  biasContourDepth(material);
  return material;
}

function contourCasingMaterial(width, resolution) {
  const material = new LineMaterial({
    color: 0x070c0a,
    linewidth: width + 1.7,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
    depthTest: true,
    fog: false,
    worldUnits: false,
  });
  material.resolution.set(resolution.x, resolution.y);
  biasContourDepth(material);
  return material;
}

/**
 * Contour one tile. `samples` are the apron-padded heights in metres (NaN = no data),
 * laid out side × side with the tile's first interior sample at (APRON, APRON).
 * Returns line positions/colours split into minor and index sets, plus label specs.
 */
function contourTileSegments(samples, side, cell, originX, originZ) {
  const minorPositions = [];
  const minorColors = [];
  const minorLevels = [];
  const indexPositions = [];
  const indexColors = [];
  const indexLevels = [];
  const labelLines = []; // { levelIndex, isIndex, points }
  const half = (side) => -1; // unused; world coords come from originX/originZ
  void half;

  const vertexCount = side * side;
  const edgeId = (u, v) => (u < v ? u * vertexCount + v : v * vertexCount + u);
  // world XZ of padded sample (i, j)
  const worldX = (i) => originX + (i - APRON) * cell;
  const worldZ = (j) => originZ + (j - APRON) * cell;

  // Only sweep the levels this tile actually spans. A tile is ~3.8 km of ground, so
  // most of the 10 m levels above or below it cannot cross it; skipping them removes
  // most of the per-tile cost. Index-contour parity must still come from the absolute
  // level number, so levelIndex is derived from the level, not the loop counter.
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < samples.length; k++) {
    const h = samples[k];
    if (!Number.isFinite(h)) continue;
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  if (!(hi >= lo)) return {
    minorPositions, minorColors, minorLevels, indexPositions, indexColors, indexLevels, labelLines,
  };
  const firstIndex = Math.max(0, Math.floor(lo / CONTOUR_INTERVAL));
  const lastIndex = Math.min(
    Math.floor(currentMaxHeight / CONTOUR_INTERVAL),
    Math.ceil(hi / CONTOUR_INTERVAL),
  );
  for (let levelIndex = firstIndex; levelIndex <= lastIndex; levelIndex++) {
    const level = levelIndex * CONTOUR_INTERVAL;
    const isIndex = levelIndex % CONTOUR_INDEX_EVERY === 0;
    const positions = isIndex ? indexPositions : minorPositions;
    const colors = isIndex ? indexColors : minorColors;
    const levels = isIndex ? indexLevels : minorLevels;
    const lineRgb = contourLineRgb(level);
    const segments = [];
    const edgePoints = new Map();

    const crossingKey = (u, v) => {
      const key = edgeId(u, v);
      if (edgePoints.has(key)) return key;
      const hu = samples[u];
      const hv = samples[v];
      const t = (level - hu) / (hv - hu);
      const ui = u % side;
      const uj = (u - ui) / side;
      const vi = v % side;
      const vj = (v - vi) / side;
      edgePoints.set(key, [
        worldX(ui) + (worldX(vi) - worldX(ui)) * t,
        worldZ(uj) + (worldZ(vj) - worldZ(uj)) * t,
      ]);
      return key;
    };

    // Only this tile's own cells become geometry. The apron is there so both
    // sides of a shared edge compute the same crossing; sweeping the apron would
    // draw the neighbour's cells too and double every line and casing at the seam.
    const firstCell = APRON;
    const endCell = APRON + TILE;
    for (let j = firstCell; j < endCell; j++) {
      const row = j * side;
      const nextRow = row + side;
      for (let i = firstCell; i < endCell; i++) {
        const a = row + i;
        const b = a + 1;
        const c = nextRow + i;
        const d = c + 1;
        if (!Number.isFinite(samples[a]) || !Number.isFinite(samples[b])
          || !Number.isFinite(samples[c]) || !Number.isFinite(samples[d])) continue;
        for (const triangle of [[a, c, b], [b, c, d]]) {
          const hits = [];
          for (let k = 0; k < 3; k++) {
            const u = triangle[k];
            const v = triangle[(k + 1) % 3];
            if ((samples[u] >= level) !== (samples[v] >= level)) hits.push(crossingKey(u, v));
          }
          if (hits.length !== 2) continue;
          const pa = edgePoints.get(hits[0]);
          const pb = edgePoints.get(hits[1]);
          if (pa[0] === pb[0] && pa[1] === pb[1]) continue;
          positions.push(pa[0], level, pa[1], pb[0], level, pb[1]);
          colors.push(lineRgb[0], lineRgb[1], lineRgb[2], lineRgb[0], lineRgb[1], lineRgb[2]);
          levels.push(level);
          segments.push({ a: hits[0], b: hits[1] });
        }
      }
    }

    if (!segments.length) continue;
    const polylines = traceContourPolylines(segments, edgePoints);
    for (const points of polylines) {
      if (points.length > 1) labelLines.push({ level, isIndex, points });
    }
  }

  return {
    minorPositions, minorColors, minorLevels,
    indexPositions, indexColors, indexLevels,
    labelLines,
  };
}

/**
 * Build one contour tile and attach its meshes and label sprites to the scene.
 * Returns a record kept in state.contour.tiles for later recolour/height updates.
 */
function buildTileContour(li, tx, ty, samples, range) {
  const level = state.terrain.cog.levels[li];
  const cell = level.cell;
  const span = TILE * cell;
  const originX = state.terrain.origin.x + tx * span;
  const originZ = state.terrain.origin.z + ty * span;
  const side = TILE + 2 * APRON;
  const data = contourTileSegments(samples, side, cell, originX, originZ);

  const lineGroup = new THREE.Group();
  lineGroup.position.y = CONTOUR_LIFT;
  lineGroup.scale.y = effectiveExaggeration();
  const labelGroup = new THREE.Group();
  const lineMaterials = [];
  const lineSets = [];
  const resolution = { x: viewWidth, y: viewHeight };

  const addSet = (positions, colors, levels, width, opacity) => {
    if (!positions.length) return;
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    geometry.setColors(colors);
    const casing = new LineSegments2(geometry, contourCasingMaterial(width, resolution));
    casing.renderOrder = 1;
    casing.frustumCulled = false;
    const line = new LineSegments2(geometry, contourLineMaterial(width, opacity, resolution));
    line.renderOrder = 2;
    line.frustumCulled = false;
    lineGroup.add(casing, line);
    lineMaterials.push(casing.material, line.material);
    lineSets.push({ geometry, levels });
  };
  addSet(data.minorPositions, data.minorColors, data.minorLevels, 1.6, 0.95);
  addSet(data.indexPositions, data.indexColors, data.indexLevels, 2.5, 1);

  // Labels: one sprite pair per polyline that is long enough to carry one.
  const labels = [];
  const materialsByLevel = new Map();
  for (const { level, isIndex, points } of data.labelLines) {
    const placement = contourLabelAnchors(points, Math.round(level / CONTOUR_INTERVAL), labels.length);
    if (!placement) continue;
    let entry = materialsByLevel.get(level);
    if (!entry) {
      const { texture, aspect } = contourLabelTexture(`${level} m`, isIndex, {
        fill: contourTextColor(level),
      });
      const casing = contourLabelTexture(`${level} m`, isIndex, { fill: '#070c0a', halo: 1.45 });
      entry = {
        aspect,
        pixels: isIndex ? 32 : 28,
        material: new THREE.SpriteMaterial({
          map: texture, transparent: true, depthWrite: false, depthTest: false,
          sizeAttenuation: false, fog: false,
        }),
        casing: new THREE.SpriteMaterial({
          map: casing.texture, transparent: true, depthWrite: false, depthTest: false,
          sizeAttenuation: false, fog: false,
        }),
      };
      materialsByLevel.set(level, entry);
    }
    for (const [x, z] of placement.anchors) {
      const sprite = new THREE.Sprite(entry.material);
      sprite.position.set(x, level * effectiveExaggeration() + CONTOUR_LABEL_LIFT, z);
      sprite.userData = {
        level, pixels: entry.pixels, aspect: entry.aspect,
        lineLength: placement.total, index: isIndex, casing: null,
      };
      sprite.visible = false;
      sprite.renderOrder = 11;
      sprite.frustumCulled = false;
      const casing = new THREE.Sprite(entry.casing);
      casing.position.copy(sprite.position);
      casing.userData = { ...sprite.userData, casing: true };
      casing.visible = false;
      casing.renderOrder = 10;
      casing.frustumCulled = false;
      sprite.userData.casing = casing;
      labelGroup.add(casing, sprite);
      labels.push(sprite);
    }
  }

  const record = { li, tx, ty, lineGroup, labelGroup, labels, lineMaterials, lineSets, range };
  state.contour.tiles.set(contourKey(li, tx, ty), record);
  state.contour.group.add(lineGroup, labelGroup);
  for (const sprite of labels) state.contour.labels.push(sprite);
  for (const material of lineMaterials) state.contour.lineMaterials.push(material);
  syncContourVisibility();
  updateContourLabelScale();
  return record;
}

function disposeLabelSprite(sprite, disposed) {
  const material = sprite.material;
  if (!material || disposed.has(material)) return;
  disposed.add(material);
  // The canvas backing each label is a unique GPU texture; disposing only the
  // material leaves it resident, and contour tiles are rebuilt constantly.
  material.map?.dispose();
  material.dispose();
}

function disposeTileContour(record) {
  state.contour.group.remove(record.lineGroup, record.labelGroup);
  for (const { geometry } of record.lineSets) geometry.dispose();
  for (const material of record.lineMaterials) material.dispose();
  const disposed = new Set();
  for (const sprite of record.labels) {
    const casing = sprite.userData.casing;
    if (casing) {
      casing.removeFromParent();
      disposeLabelSprite(casing, disposed);
    }
    sprite.removeFromParent();
    disposeLabelSprite(sprite, disposed);
  }
  state.contour.labels = state.contour.labels.filter((x) => !record.labels.includes(x));
  state.contour.lineMaterials = state.contour.lineMaterials.filter(
    (x) => !record.lineMaterials.includes(x),
  );
}

function clearContours() {
  if (!state.contour) return;
  for (const record of state.contour.tiles.values()) disposeTileContour(record);
  state.contour.tiles.clear();
  state.contour.group.clear();
  state.contour.labels.length = 0;
  state.contour.lineMaterials.length = 0;
  // A fresh enable gets a fresh chance: queued reads and tiles already read belong
  // to the view that has just been discarded, so drop them and release their keys.
  // Reads still in flight keep their key in `pending` — they resolve, see the mode
  // is off, and release it themselves; re-enabling in the meantime simply reuses
  // that read instead of starting a second one for the same tile.
  for (const { key } of state.contour.queue) state.contour.pending.delete(key);
  state.contour.queue.length = 0;
  for (const { key } of state.contour.ready) state.contour.pending.delete(key);
  state.contour.ready.length = 0;
  state.contour.failed.clear();
  invalidate();
}

function syncContourVisibility() {
  if (!state.contour) return;
  state.contour.group.visible = state.contoursOn;
  invalidate();
}

// Contours do not need the terrain's full resolution: a 10 m interval is already at
// the Nyquist limit of a 15 m grid, and contouring every level-0 tile is both slow
// (one tile is a ~160 ms burst) and memory-hungry (well over 100k segments per tile).
// So contours are built no finer than CONTOUR_MIN_LEVEL, over the visible ground.
const CONTOUR_MIN_LEVEL = TOUCH_UI ? 2 : 1;   // 60 m cells on touch, 30 m otherwise
const CONTOUR_MAX_TILES = TOUCH_UI ? 24 : 48; // bound on contour line geometry

/**
 * Queue contour reads for the visible ground, drop tiles that scrolled away, and
 * start their reads; the builds those reads feed are budgeted in processContourBuilds.
 * Contour tiles are chosen independently of the terrain tiles: at level C there are 4×
 * fewer of them than at level C−1, so the work stays flat as the camera zooms in.
 */
function syncContours() {
  if (!state.contour || !state.contoursOn || !state.terrain.stream) return;
  if (performance.now() - lastCameraMove < CONTOUR_SETTLE_MS) return;

  const stream = state.terrain.stream;
  const terrainMeshes = [...stream.meshes.values()].filter((m) => m.visible);
  if (!terrainMeshes.length) return;

  let finest = Number.MAX_SAFE_INTEGER;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const mesh of terrainMeshes) {
    const { li, tx, ty } = mesh.userData.tile;
    if (li < finest) finest = li;
    const r = stream.tileRect(li, tx, ty);
    minX = Math.min(minX, r.x0);
    maxX = Math.max(maxX, r.x1);
    minZ = Math.min(minZ, r.z0);
    maxZ = Math.max(maxZ, r.z1);
  }

  const li = Math.max(finest, CONTOUR_MIN_LEVEL);
  const level = state.terrain.cog.levels[li];
  const span = TILE * level.cell;
  const origin = state.terrain.origin;
  const tx0 = Math.max(0, Math.floor((minX - origin.x) / span));
  const tx1 = Math.min(Math.ceil(level.width / TILE) - 1, Math.floor((maxX - origin.x) / span));
  const ty0 = Math.max(0, Math.floor((minZ - origin.z) / span));
  const ty1 = Math.min(Math.ceil(level.height / TILE) - 1, Math.floor((maxZ - origin.z) / span));

  const visible = new Set();
  for (let ty = ty0; ty <= ty1 && visible.size < CONTOUR_MAX_TILES; ty++) {
    for (let tx = tx0; tx <= tx1 && visible.size < CONTOUR_MAX_TILES; tx++) {
      const key = contourKey(li, tx, ty);
      visible.add(key);
      const failedAt = state.contour.failed.get(key);
      if (!state.contour.tiles.has(key) && !state.contour.pending.has(key)
        && (failedAt === undefined || performance.now() - failedAt >= CONTOUR_RETRY_MS)) {
        if (failedAt !== undefined) state.contour.failed.delete(key);
        state.contour.pending.add(key);
        state.contour.queue.push({ key, li, tx, ty });
      }
    }
  }
  state.contour.wanted = visible;
  for (const [key, record] of state.contour.tiles) {
    if (!visible.has(key)) {
      disposeTileContour(record);
      state.contour.tiles.delete(key);
    }
  }
  // Runs on the settle timer, long after the camera move's own repaint, so a
  // disposal here must ask for one: without it the removed lines linger until
  // the next keep-alive.
  invalidate();
  processContourQueue();
}

// Reads are started from the settle-gated sync; the builds they produce are run
// separately against a per-frame budget (processContourBuilds), because a read can
// complete while the frame is already busy and the build itself is a synchronous
// burst on the main thread.
function processContourQueue() {
  if (!state.contour.queue.length) return;
  const deadline = performance.now() + CONTOUR_BUILD_BUDGET_MS;
  while (state.contour.queue.length) {
    if (performance.now() >= deadline) return;
    const { key, li, tx, ty } = state.contour.queue.shift();
    if (state.contour.tiles.has(key)) {
      state.contour.pending.delete(key);
      continue;
    }
    // The key stays in `pending` until the build finishes. Deleting it here would let
    // the per-frame sync re-queue the same tile while its read is in flight, building
    // it again and again.
    const level = state.terrain.cog.levels[li];
    readTileQueued(level, tx, ty).then((samples) => {
      // the tile may have left the view, or the mode been turned off, while reading
      if (!state.contoursOn || state.contour.tiles.has(key)
        || (state.contour.wanted && !state.contour.wanted.has(key))) {
        state.contour.pending.delete(key);
        return;
      }
      // Hand the samples to the budgeted builder; `pending` stays set until that
      // build runs, so the sync still cannot queue the tile a second time.
      state.contour.ready.push({ key, li, tx, ty, samples });
    }).catch((error) => {
      state.contour.failed.set(key, performance.now());
      state.contour.pending.delete(key);
      console.warn('[contours] tile failed', key, error);
    });
  }
}

// Build tiles that have already been read, a budget's worth per frame. This is what
// the budget actually bounds: the read is asynchronous, but contouring one tile is a
// single synchronous pass over its samples, so it has to be paid for out of the frame
// that starts it rather than out of whichever frame the read happens to finish in.
function processContourBuilds() {
  if (!state.contour || !state.contour.ready.length) return;
  const deadline = performance.now() + CONTOUR_BUILD_BUDGET_MS;
  while (state.contour.ready.length) {
    if (performance.now() >= deadline) return;
    const { key, li, tx, ty, samples } = state.contour.ready.shift();
    state.contour.pending.delete(key);
    // re-check: the view can have moved on while the read was in flight
    if (!state.contoursOn || state.contour.tiles.has(key)) continue;
    if (state.contour.wanted && !state.contour.wanted.has(key)) continue;
    buildTileContour(li, tx, ty, samples);
  }
}

// The palette is the colour legend for contour mode too: recolour the existing
// line buffers and label textures in place instead of rebuilding the geometry.
function recolorContours() {
  const contour = state.contour;
  if (!contour) return;

  const lineColors = new Map();
  const sets = [];
  for (const record of contour.tiles.values()) sets.push(...record.lineSets);
  for (const { geometry, levels } of sets) {
    const attr = geometry.attributes.instanceColorStart;
    const array = attr.data.array;
    for (let i = 0; i < levels.length; i++) {
      let rgb = lineColors.get(levels[i]);
      if (!rgb) {
        rgb = contourLineRgb(levels[i]);
        lineColors.set(levels[i], rgb);
      }
      const [r, g, b] = rgb;
      const offset = i * 6;
      array[offset] = r;
      array[offset + 1] = g;
      array[offset + 2] = b;
      array[offset + 3] = r;
      array[offset + 4] = g;
      array[offset + 5] = b;
    }
    attr.data.needsUpdate = true;
  }

  const seen = new Set();
  for (const sprite of contour.labels) {
    if (seen.has(sprite.material)) continue;
    seen.add(sprite.material);
    const level = sprite.userData.level;
    const { texture } = contourLabelTexture(`${level} m`, sprite.userData.index, {
      fill: contourTextColor(level),
    });
    sprite.material.map.dispose();
    sprite.material.map = texture;
  }
  invalidate();
}

// Labels are screen-space and would pile up where contours crowd together, so
// the visible set is chosen per frame: every level gets a turn on its longest
// lines, then labels are dropped if their screen rectangles overlap. The map
// pane is now a clean stage, so the only bounds are its edges.

function updateContourLabels() {
  const contour = state.contour;
  if (!contour || !contour.group.visible) return;
  const width = viewWidth;
  const height = viewHeight;
  const cameraSpace = new THREE.Vector3();
  const projected = new THREE.Vector3();

  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

  const buckets = new Map();
  for (const sprite of contour.labels) {
    sprite.visible = false;
    if (sprite.userData.casing) sprite.userData.casing.visible = false;
    cameraSpace.copy(sprite.position).applyMatrix4(camera.matrixWorldInverse);
    if (cameraSpace.z > -camera.near) continue;
    projected.copy(sprite.position).project(camera);
    if (projected.z < -1 || projected.z > 1) continue;
    const x = (projected.x * 0.5 + 0.5) * width;
    const y = (-projected.y * 0.5 + 0.5) * height;
    // Reject the whole sprite box against the map pane, not just its centre.
    const halfW = sprite.userData.pixels * sprite.userData.aspect / 2;
    const halfH = sprite.userData.pixels / 2;
    if (x + halfW < 0 || x - halfW > width
      || y + halfH < 0 || y - halfH > height) continue;
    sprite.userData.screenX = x;
    sprite.userData.screenY = y;
    let bucket = buckets.get(sprite.userData.level);
    if (!bucket) buckets.set(sprite.userData.level, (bucket = []));
    bucket.push(sprite);
  }

  // Higher ground is rarer on screen; let the summit labels place first, then
  // the lower contours fill the space around them.
  const levels = [...buckets.keys()].sort((a, b) => b - a);
  for (const level of levels) {
    buckets.get(level).sort(
      (a, b) => b.userData.lineLength - a.userData.lineLength,
    );
  }

  const maxLabels = width < 761 ? 42 : 72;
  const rects = [];
  let shown = 0;

  const tryShow = (sprite) => {
    if (shown >= maxLabels) return false;
    const labelWidth = sprite.userData.pixels * sprite.userData.aspect;
    const labelHeight = sprite.userData.pixels;
    const x = sprite.userData.screenX;
    const y = sprite.userData.screenY;
    const rect = [
      x - labelWidth / 2 - 3,
      y - labelHeight / 2 - 2,
      x + labelWidth / 2 + 3,
      y + labelHeight / 2 + 2,
    ];
    for (const other of rects) {
      if (!(rect[2] < other[0] || rect[0] > other[2]
        || rect[3] < other[1] || rect[1] > other[3])) return false;
    }
    sprite.visible = true;
    if (sprite.userData.casing) sprite.userData.casing.visible = true;
    rects.push(rect);
    shown++;
    return true;
  };

  // Give every level a chance at the longest lines first, so the labels stay
  // distributed across the height range rather than crowding the low ground.
  let more = true;
  for (let round = 0; more && shown < maxLabels; round++) {
    more = false;
    for (const level of levels) {
      const bucket = buckets.get(level);
      if (round >= bucket.length) continue;
      more = true;
      tryShow(bucket[round]);
      if (shown >= maxLabels) break;
    }
  }
}

function updateContourHeights() {
  if (!state.contour) return;
  const exaggeration = effectiveExaggeration();
  for (const record of state.contour.tiles.values()) {
    record.lineGroup.scale.y = exaggeration;
    for (const sprite of record.labelGroup.children) {
      sprite.position.y = sprite.userData.level * exaggeration + CONTOUR_LABEL_LIFT;
    }
  }
  invalidate();
}

// Sprites with sizeAttenuation off are sized in screen space, so their scale is
// a projection constant rather than a world size. Labels are 28 or 32 px tall.
function updateContourLabelScale() {
  if (!state.contour) return;
  const pixelsPerUnit = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))
    / viewHeight;
  // Both the label sprite and its casing are in the tile's label group; each needs
  // its scale set, or an unset sprite stays at scale 1 and fills the viewport.
  for (const record of state.contour.tiles.values()) {
    for (const sprite of record.labelGroup.children) {
      const scale = pixelsPerUnit * sprite.userData.pixels;
      sprite.scale.set(scale * sprite.userData.aspect, scale, 1);
    }
  }
  invalidate();
}

function updateContourLineResolution() {
  if (!state.contour) return;
  const width = viewWidth;
  const height = viewHeight;
  for (const material of state.contour.lineMaterials) {
    material.resolution.set(width, height);
  }
  invalidate();
}

function initContourLayer() {
  if (state.contour) return state.contour;
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  state.contour = {
    group,
    tiles: new Map(),
    labels: [],
    lineMaterials: [],
    queue: [],
    ready: [], // read tiles waiting for a budgeted build
    pending: new Set(),
    failed: new Map(), // key -> time of the last failed read, for the retry
    wanted: new Set(),
  };
  return state.contour;
}

function setContourMode(on) {
  if (!state.terrain) return;
  state.contoursOn = on;
  initContourLayer();
  state.contour.group.visible = on;
  if (on) {
    // retry the sync from the loop if this one lands before the camera settles
    contourSyncDue = true;
    updateContourHeights();
    recolorContours();
    syncContours();
  } else {
    // free the tile line geometry while the mode is off
    clearContours();
  }

  updateWaterTint();
  updateTerrainUniforms();
  updateLegend();
  updateContourLabels();
  invalidate();
}

/* ------------------------------------------------------------------ *
 * Base map — OneMap raster tiles, laid under the terrain so the elevation
 * can be read against real places and roads.
 *
 * A z12 sheet covers the island at overview scale. Zooming in streams a
 * higher-zoom level for the area in front of the camera and stacks it on
 * top, so the map keeps street-level detail when the DEM is inspected
 * closely — one tile level per halving of the view size.
 * ------------------------------------------------------------------ */
const COARSE_ZOOM = 12;    // overview sheet, 6 x 5 tiles over the island
const MAP_MAX_ZOOM = 18;
const DETAIL_BUDGET = 72;  // tiles permitted in one streamed level
// OneMap serves its cartographic styles as WebP from the HD tile server. The
// orthophoto is still a 256 px PNG set on the main server; there is no WebP
// variant of Satellite, so this source is the exception.
const BASE_MAP_STYLES = [
  {
    id: 'default',
    name: 'Default',
    tileUrl: (z, x, y) => `https://tiles.onemap.gov.sg/Default_HD_webp/${z}/${x}/${y}.webp`,
  },
  {
    id: 'grey',
    name: 'Grey',
    tileUrl: (z, x, y) => `https://tiles.onemap.gov.sg/Grey_HD_webp/${z}/${x}/${y}.webp`,
  },
  {
    id: 'orthophoto',
    name: 'Orthophoto',
    tileUrl: (z, x, y) => `https://www.onemap.gov.sg/maps/tiles/Satellite/${z}/${x}/${y}.png`,
  },
];
const baseMapStyle = () => (
  BASE_MAP_STYLES.find((style) => style.id === state.baseMapStyle) || BASE_MAP_STYLES[0]
);
const tileKey = (style, z, x, y) => `${style.id}/${z}/${x}/${y}`;

const tileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const tileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const tileLat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

function lonLatToWorld(lon, lat) {
  const { west, south, east, north } = state.geo;
  return {
    x: ((lon - west) / (east - west) - 0.5) * state.terrain.width,
    z: (0.5 - (lat - south) / (north - south)) * state.terrain.depth,
  };
}

function worldToLonLat(x, z) {
  const { west, south, east, north } = state.geo;
  return {
    lon: west + (x / state.terrain.width + 0.5) * (east - west),
    lat: south + (0.5 - z / state.terrain.depth) * (north - south),
  };
}

const baseMap = {
  built: false,
  group: null,
  detail: null,
  detailKey: '',
  textures: new Map(), // key -> { texture, used }
  inflight: new Map(),
  pinned: new Set(),
};

function getTileTexture(style, z, x, y) {
  const key = tileKey(style, z, x, y);
  const cached = baseMap.textures.get(key);
  if (cached) {
    cached.used = performance.now();
    return Promise.resolve(cached.texture);
  }
  const running = baseMap.inflight.get(key);
  if (running) return running;

  const pending = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const texture = new THREE.Texture(img);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = maxAnisotropy();
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.needsUpdate = true;
      baseMap.textures.set(key, { texture, used: performance.now() });
      baseMap.inflight.delete(key);
      evictTextures();
      resolve(texture);
    };
    img.onerror = () => {
      baseMap.inflight.delete(key);
      resolve(null);
    };
    img.src = style.tileUrl(z, x, y);
  });
  baseMap.inflight.set(key, pending);
  return pending;
}

// Keep GPU memory bounded: drop the least recently used tiles that no visible
// level depends on.
const TEXTURE_LIMIT = 260;
function evictTextures() {
  if (baseMap.textures.size <= TEXTURE_LIMIT) return;
  const entries = [...baseMap.textures.entries()]
    .filter(([key]) => !baseMap.pinned.has(key))
    .sort((a, b) => a[1].used - b[1].used);
  while (baseMap.textures.size > TEXTURE_LIMIT && entries.length) {
    const [key, entry] = entries.shift();
    entry.texture.dispose();
    baseMap.textures.delete(key);
  }
}

function tileMesh(z, tx, ty, texture) {
  const nw = lonLatToWorld((tx / 2 ** z) * 360 - 180, tileLat(ty, z));
  const se = lonLatToWorld(((tx + 1) / 2 ** z) * 360 - 180, tileLat(ty + 1, z));
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(Math.abs(se.x - nw.x), Math.abs(se.z - nw.z)),
    new THREE.MeshBasicMaterial({ map: texture }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((nw.x + se.x) / 2, 0, (nw.z + se.z) / 2);
  return mesh;
}

async function buildTileGroup(style, z, x0, x1, y0, y1) {
  const group = new THREE.Group();
  const jobs = [];
  const keys = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      jobs.push([tx, ty]);
      keys.push(tileKey(style, z, tx, ty));
    }
  }

  let loaded = 0;
  const queue = jobs.slice();
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const [tx, ty] = queue.shift();
      const texture = await getTileTexture(style, z, tx, ty);
      if (!texture) continue;
      loaded++;
      const mesh = tileMesh(z, tx, ty, texture);
      mesh.userData.tileKey = tileKey(style, z, tx, ty);
      group.add(mesh);
    }
  }));
  return { group, keys, loaded, tiles: jobs.length };
}

function tileRange(z, rect) {
  const nw = worldToLonLat(rect.minX, rect.minZ);
  const se = worldToLonLat(rect.maxX, rect.maxZ);
  return {
    x0: Math.floor(tileX(nw.lon, z)),
    x1: Math.floor(tileX(se.lon, z)),
    y0: Math.floor(tileY(nw.lat, z)),
    y1: Math.floor(tileY(se.lat, z)),
  };
}

function overviewPlan() {
  if (!state.geo) throw new Error('manifest has no geographic_bounds');
  const { west, south, east, north } = state.geo;
  const z = COARSE_ZOOM;
  return {
    z,
    x0: Math.floor(tileX(west, z)),
    x1: Math.floor(tileX(east, z)),
    y0: Math.floor(tileY(north, z)),
    y1: Math.floor(tileY(south, z)),
  };
}

async function buildOverviewGroup(style) {
  const plan = overviewPlan();
  const result = await buildTileGroup(style, plan.z, plan.x0, plan.x1, plan.y0, plan.y1);
  return { ...result, plan };
}

async function ensureBaseMap() {
  if (baseMap.built) return;
  const style = baseMapStyle();
  const { group, keys, loaded, tiles, plan } = await buildOverviewGroup(style);
  if (!loaded) throw new Error('base map tiles unavailable');

  group.position.y = MAP_Y;
  baseMap.group = group;
  baseMap.built = true;
  keys.forEach((key) => baseMap.pinned.add(key));
  scene.add(group);
  invalidate();
  console.info(`[base map] overview ${style.id} z${plan.z}: ${loaded}/${tiles} tiles`);
}

function detailPlan(style) {
  const distance = camera.position.distanceTo(controls.target);
  const reference = state.fitDistance || distance;

  // One tile level per halving of the view distance, never coarser than the
  // overview sheet and never finer than the tile set goes.
  let z = Math.min(MAP_MAX_ZOOM, COARSE_ZOOM + Math.round(Math.log2(reference / distance)));

  // the ground the camera is actually looking at; the overview sheet fills in
  // beyond it
  const radius = distance * 0.7;
  const target = controls.target;
  const rect = {
    minX: target.x - radius,
    maxX: target.x + radius,
    minZ: target.z - radius,
    maxZ: target.z + radius,
  };

  let range = tileRange(z, rect);
  while (z > COARSE_ZOOM) {
    const count = (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1);
    if (count <= DETAIL_BUDGET) break;
    z--;
    range = tileRange(z, rect);
  }

  if (z <= COARSE_ZOOM) return null;
  return {
    style,
    z,
    range,
    key: `${style.id}/${z}/${range.x0}/${range.x1}/${range.y0}/${range.y1}`,
  };
}

async function buildDetailGroup(plan) {
  const { style, z, range, key } = plan;
  const result = await buildTileGroup(style, z, range.x0, range.x1, range.y0, range.y1);
  result.group.position.y = MAP_DETAIL_Y;
  return { ...result, key, z };
}

let detailToken = 0;

async function refreshDetail() {
  if (!baseMap.built || !state.baseMapOn) {
    // A build started while the layer was visible must not land after it is hidden.
    detailToken += 1;
    baseMap.detailKey = '';
    return;
  }
  const style = baseMapStyle();
  const plan = detailPlan(style);
  if (!plan) {
    // Cancel any detail build still in flight; otherwise it can re-show a
    // fine level over the overview after this early return.
    detailToken += 1;
    if (baseMap.detail) baseMap.detail.visible = false;
    baseMap.detailKey = '';
    invalidate();
    return;
  }
  if (plan.key === baseMap.detailKey) return;
  baseMap.detailKey = plan.key;

  const token = ++detailToken;
  const { group, keys, loaded, tiles, key, z } = await buildDetailGroup(plan);

  // a newer view superseded this request while its tiles were in flight
  if (token !== detailToken) {
    disposeBaseMapGroup(group);
    return;
  }
  if (!state.baseMapOn) {
    // The layer was hidden without a newer refresh cancelling this build.
    baseMap.detailKey = '';
    disposeBaseMapGroup(group);
    return;
  }
  if (!loaded) {
    baseMap.detailKey = '';
    disposeBaseMapGroup(group);
    return;
  }

  group.visible = state.baseMapOn;
  if (baseMap.detail) disposeBaseMapGroup(baseMap.detail);
  baseMap.detail = group;
  scene.add(group);

  baseMap.pinned = new Set([
    ...(baseMap.group ? baseMap.group.children.map((m) => m.userData.tileKey) : []),
    ...keys,
  ]);
  invalidate();
  console.info(`[base map] detail ${style.id} z${z}: ${loaded}/${tiles} tiles`);
}

let detailTimer = 0;
function scheduleDetail() {
  window.clearTimeout(detailTimer);
  detailTimer = window.setTimeout(() => {
    refreshDetail().catch((error) => console.warn('[base map]', error));
  }, 160);
}

function disposeBaseMapGroup(group) {
  if (!group) return;
  scene.remove(group);
  group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
}

// Drop both levels of the current style. Textures stay in the cache, keyed by
// style, so switching back reuses anything still resident.
function clearBaseMapGroups() {
  detailToken += 1;
  baseMap.detailKey = '';
  disposeBaseMapGroup(baseMap.detail);
  disposeBaseMapGroup(baseMap.group);
  baseMap.detail = null;
  baseMap.group = null;
  baseMap.built = false;
  baseMap.pinned.clear();
}

let styleToken = 0;

async function changeBaseMapStyle(style) {
  if (!style || style.id === state.baseMapStyle) return;
  const previous = baseMapStyle();
  state.baseMapStyle = style.id;
  syncBaseMapStyleButtons();
  if (!state.terrain) return;

  if (!state.baseMapOn) {
    // The next enable builds the newly selected style from scratch.
    clearBaseMapGroups();
    return;
  }

  const token = ++styleToken;
  setBaseMapUiBusy(true);
  try {
    // Build both levels off stage. The old style stays on screen until the new
    // overview and detail exist, so a zoomed-in view never flashes the coarse
    // overview (large labels) while the detail tiles are still arriving.
    const overview = await buildOverviewGroup(style);
    if (token !== styleToken) {
      disposeBaseMapGroup(overview.group);
      return;
    }
    if (!overview.loaded) throw new Error('base map tiles unavailable');

    const plan = detailPlan(style);
    let detail = plan ? await buildDetailGroup(plan) : null;
    if (token !== styleToken) {
      disposeBaseMapGroup(overview.group);
      if (detail) disposeBaseMapGroup(detail.group);
      return;
    }
    if (detail && !detail.loaded) {
      disposeBaseMapGroup(detail.group);
      detail = null;
    }

    // Cancel an in-flight detail read from the old style, then swap both levels
    // in one task: no frame can render the map in between.
    detailToken += 1;
    disposeBaseMapGroup(baseMap.detail);
    disposeBaseMapGroup(baseMap.group);
    overview.group.position.y = MAP_Y;
    baseMap.group = overview.group;
    baseMap.detail = detail ? detail.group : null;
    baseMap.detailKey = detail ? detail.key : '';
    baseMap.built = true;
    baseMap.pinned = new Set([...overview.keys, ...(detail ? detail.keys : [])]);
    scene.add(overview.group);
    if (detail) {
      detail.group.visible = state.baseMapOn;
      scene.add(detail.group);
    }
    updateTerrainBlend();
    invalidate();
  } catch (error) {
    if (token !== styleToken) return;
    console.warn('[base map] style change failed:', error);
    // The previous style is still mounted; only the selection needs reverting.
    state.baseMapStyle = previous.id;
    syncBaseMapStyleButtons();
  } finally {
    if (token === styleToken) setBaseMapUiBusy(false);
  }
}

// The flat-land mask only means anything while the base map is behind the DEM.
function terrainMasked() {
  return !!(state.baseMapOn && state.flatMask);
}

// Blend state is per material, so it is applied to the existing tiles on a settings
// change and to every material as it is created: a tile that streams in after the
// mode or opacity changed must not keep the default NormalBlending with transparent
// false, which three maps to no blending at all — the RGB blend mode and the
// flat-land mask alpha would both be dropped for that tile.
function applyMaterialBlend(material) {
  const mode = state.blendMode;
  material.blending = mode === 'multiply'
    ? THREE.MultiplyBlending
    : mode === 'screen'
      ? THREE.CustomBlending
      : THREE.NormalBlending;
  if (mode === 'screen') {
    // screen = src * (1 - dst) + dst
    material.blendEquation = THREE.AddEquation;
    material.blendSrc = THREE.OneMinusDstColorFactor;
    material.blendDst = THREE.OneFactor;
    material.blendEquationAlpha = THREE.AddEquation;
    material.blendSrcAlpha = THREE.OneFactor;
    material.blendDstAlpha = THREE.ZeroFactor;
  }
  material.opacity = 1;
  // A tile mid-crossfade stays transparent even at full terrain opacity: the stream
  // drives its blend state and restores it through this rule when the fade ends.
  const transparent = mode !== 'normal'
    || state.opacity < 0.999
    || terrainMasked()
    || !!material.userData.fading;
  // Only materials whose transparency actually changes are recompiled, so the
  // slider never triggers a shader rebuild per frame.
  if (material.transparent !== transparent) {
    material.transparent = transparent;
    material.needsUpdate = true;
  }
}

function updateTerrainBlend() {
  if (!state.terrain || !state.terrain.stream) return;
  // The uniform holders are shared, so the strength and mask update every tile at once.
  shared.uDemOpacity.value = state.opacity;
  shared.uFlatMask.value = terrainMasked() ? 1 : 0;
  shared.uBlendMode.value = blendModeValue();
  for (const material of state.terrain.stream.allMaterials()) applyMaterialBlend(material);
  invalidate();
}

function setTerrainOpacity(value) {
  state.opacity = value;
  updateTerrainBlend();
}

/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */
const legendBar = document.getElementById('legend-bar');
const legendTicks = document.getElementById('legend-ticks');
const legendUnit = document.getElementById('legend-unit');
const legendNote = document.getElementById('legend-note');
const paletteBox = document.getElementById('palettes');
const exaggerationInput = document.getElementById('exaggeration');
const exaggerationOut = document.getElementById('exaggeration-out');
const resetButton = document.getElementById('reset');
const baseMapInput = document.getElementById('basemap');
const baseMapStyleBox = document.getElementById('basemap-styles');
const baseMapStyleField = document.getElementById('field-basemap-style');
const blendModeBox = document.getElementById('blend-modes');
const blendField = document.getElementById('field-blend');
const opacityInput = document.getElementById('opacity');
const opacityOut = document.getElementById('opacity-out');
const creditEl = document.getElementById('credit');
const flatInput = document.getElementById('flatland');
const contourInput = document.getElementById('contours');
const view3dInput = document.getElementById('view3d');
const exaggerationField = document.getElementById('field-exaggeration');
const flatlandField = document.getElementById('field-flatland');
const opacityField = document.getElementById('field-opacity');

// Sub-fields are shown only when they can do something: the exaggeration slider
// exists in 3D alone, and the base-map-only controls only while the map is on.
function syncDependentFields() {
  const mode3D = state.mode3D;
  exaggerationField.hidden = !mode3D;
  exaggerationInput.disabled = !mode3D;
  const withMap = state.baseMapOn && !!state.terrain;
  baseMapStyleField.hidden = !withMap;
  blendField.hidden = !withMap;
  opacityField.hidden = !withMap;
  flatlandField.hidden = !withMap;
  opacityInput.disabled = !withMap;
  flatInput.disabled = !withMap;
}

function gradientCss(palette) {
  const stops = palette.stops
    ? palette.stops.map(([t, hex]) => `${hex} ${(t * 100).toFixed(1)}%`)
    : palette.colors.map((hex, i) => `${hex} ${((i / (palette.colors.length - 1)) * 100).toFixed(1)}%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

function buildPaletteButtons() {
  paletteBox.innerHTML = '';
  for (const palette of PALETTES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'palette';
    button.dataset.id = palette.id;
    button.setAttribute('aria-pressed', String(palette.id === state.palette.id));
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = gradientCss(palette);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = palette.name;
    button.append(swatch, label);
    button.addEventListener('click', () => {
      for (const other of paletteBox.children) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      applyPalette(palette);
    });
    paletteBox.append(button);
  }
}

function buildBaseMapStyleButtons() {
  baseMapStyleBox.innerHTML = '';
  for (const style of BASE_MAP_STYLES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.id = style.id;
    button.textContent = style.name;
    button.setAttribute('aria-pressed', String(style.id === state.baseMapStyle));
    button.addEventListener('click', () => {
      changeBaseMapStyle(style).catch((error) => console.warn('[base map]', error));
    });
    baseMapStyleBox.append(button);
  }
}

function syncBaseMapStyleButtons() {
  for (const button of baseMapStyleBox.children) {
    button.setAttribute('aria-pressed', String(button.dataset.id === state.baseMapStyle));
  }
}

function setBaseMapUiBusy(busy) {
  baseMapInput.disabled = busy;
  for (const button of baseMapStyleBox.children) button.disabled = busy;
}

// The blend controls only describe how the DEM sits on the base map. Once the map
// is gone, leave the terrain at full Normal opacity instead of retaining a hidden
// Multiply or Screen mode.
function resetTerrainBlend() {
  state.blendMode = 'normal';
  state.opacity = 1;
  opacityInput.value = 100;
  opacityOut.textContent = '100%';
  for (const button of blendModeBox.children) {
    button.setAttribute('aria-pressed', String(button.dataset.id === 'normal'));
  }
  setTerrainOpacity(1);
}

function buildBlendModeButtons() {
  blendModeBox.innerHTML = '';
  for (const mode of BLEND_MODES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.id = mode.id;
    button.textContent = mode.name;
    button.setAttribute('aria-pressed', String(mode.id === state.blendMode));
    button.addEventListener('click', () => {
      state.blendMode = mode.id;
      for (const other of blendModeBox.children) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      updateTerrainBlend();
    });
    blendModeBox.append(button);
  }
}

function updateLegend() {
  legendBar.style.background = gradientCss(state.palette);
  legendUnit.textContent = state.contoursOn ? `${CONTOUR_INTERVAL} m interval` : 'm a.s.l.';

  const max = state.maxHeight;
  const mid = Math.round(max / 2);
  legendTicks.innerHTML = '';
  for (const value of [0, mid, Math.round(max)]) {
    const span = document.createElement('span');
    span.textContent = String(value);
    legendTicks.append(span);
  }
  legendTicks.style.visibility = state.contoursOn ? 'hidden' : 'visible';
  // The note is hidden on phones by default; contour mode needs the interval
  // explanation, so show it for that mode at every breakpoint.
  legendNote.style.display = state.contoursOn ? 'block' : '';

  if (state.terrain) {
    legendNote.textContent = state.contoursOn
      ? `Index contours every ${CONTOUR_INTERVAL * CONTOUR_INDEX_EVERY} m`
      : `Summit ${state.maxHeight.toFixed(1)} m · ${state.sourcePixelSize.toFixed(0)} m source cells`;
  }
}

function fitDistance(tilt, limitX, limitY) {
  // fit the island itself, not the empty sea corners of the data grid
  const { minX, maxX, minZ, maxZ } = state.terrain.land;
  const top = state.maxHeight * state.exaggeration * 1.2;
  const corners = [];
  for (const x of [minX, maxX]) {
    for (const y of [0, top]) {
      for (const z of [minZ, maxZ]) corners.push(new THREE.Vector3(x, y, z));
    }
  }

  const target = viewTarget();
  const probe = new THREE.Vector3();
  let distance = Math.max(maxX - minX, maxZ - minZ) * 1.6;

  // Fixed-point fit: project the plate's corners and scale the orbit distance
  // until both axes fit the map pane. Limits are NDC half-extents derived from
  // the canvas aspect, so the fit stays correct when the split changes.
  for (let i = 0; i < 14; i++) {
    camera.position.set(
      target.x,
      distance * Math.sin(tilt),
      target.z + distance * Math.cos(tilt),
    );
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
    let extentX = 0;
    let extentY = 0;
    for (const corner of corners) {
      probe.copy(corner).project(camera);
      extentX = Math.max(extentX, Math.abs(probe.x));
      extentY = Math.max(extentY, Math.abs(probe.y));
    }
    const factor = Math.max(extentX / limitX, extentY / limitY);
    distance *= factor;
    if (Math.abs(factor - 1) < 0.002) break;
  }
  return distance;
}

function viewTarget() {
  const { minX, maxX, minZ, maxZ } = state.terrain.land;
  return new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
}

function resetView() {
  orbitTween = null;
  const width = viewWidth;
  const height = viewHeight;
  camera.clearViewOffset();
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  const tilt = state.mode3D ? TILT_3D : PLAN_TILT;
  const margin = 0.92;
  const distance = fitDistance(tilt, margin, margin);
  state.fitDistance = distance;
  const target = viewTarget();
  camera.position.set(target.x, distance * Math.sin(tilt), target.z + distance * Math.cos(tilt));
  controls.target.copy(target);
  controls.update();
  scheduleDetail();
  invalidate();
}

exaggerationInput.addEventListener('input', () => {
  const value = Number(exaggerationInput.value);
  state.exaggeration = value;
  exaggerationOut.textContent = `${value.toFixed(1)}×`;
  if (state.terrain) updateTerrainUniforms();
  updateContourHeights();
  updateMinDistance();
  if (tipAt) scheduleTerrainTip();
});

// The camera near plane stays at 200 m for depth precision. A closer orbit is safe
// in the flat 2D map, but in 3D the nearest summit must stay well in front of it, so
// the minimum distance rises with the effective exaggeration.
function updateMinDistance() {
  if (!state.size) return;
  const clearance = 240 + state.maxHeight * effectiveExaggeration() * 1.2;
  controls.minDistance = Math.max(state.size * 0.004, clearance);
  invalidate();
}

// 2D/3D: the two modes differ in terrain relief and in whether the camera may tilt.
// 2D draws the terrain flat and pins the orbit to top-down (a colour map); 3D restores
// the exaggeration and lets the camera tilt. Toggling animates the tilt so the change
// is legible.
let polarLockPending = false;

function applyPolarLock() {
  if (state.mode3D) {
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = POLAR_MAX;
  } else {
    controls.minPolarAngle = POLAR_2D;
    controls.maxPolarAngle = POLAR_2D;
  }
}

function setView3D(on) {
  if (state.mode3D === on) return;
  state.mode3D = on;
  // Two-finger drag pans the flat map, but tilts the 3D view.
  controls.touches.TWO = on ? THREE.TOUCH.DOLLY_ROTATE : THREE.TOUCH.DOLLY_PAN;
  syncDependentFields();
  if (state.terrain) updateTerrainUniforms();
  updateContourHeights();
  updateMinDistance();
  if (!state.terrain) {
    applyPolarLock();
    return;
  }
  orbitTween = null;
  if (on) {
    // relax the top-down lock before the tween, or controls.update() clamps it
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = POLAR_MAX;
    polarLockPending = false;
  } else {
    // lock only once the tween has reached top-down, or the clamp snaps immediately
    polarLockPending = true;
  }
  tweenOrbit({ phi: on ? (Math.PI / 2 - TILT_3D) : POLAR_2D }, ORBIT_MS.rotate);
  if (tipAt) scheduleTerrainTip();
}

view3dInput.addEventListener('change', () => setView3D(view3dInput.checked));

resetButton.addEventListener('click', resetView);

opacityInput.addEventListener('input', () => {
  const value = Number(opacityInput.value) / 100;
  opacityOut.textContent = `${opacityInput.value}%`;
  if (state.terrain) setTerrainOpacity(value);
});

flatInput.addEventListener('change', () => {
  state.flatMask = flatInput.checked;
  updateTerrainBlend();
});

contourInput.addEventListener('change', () => {
  const on = contourInput.checked;
  try {
    setContourMode(on);
  } catch (error) {
    console.error('[contours]', error);
    contourInput.checked = false;
    setContourMode(false);
  }
});

baseMapInput.addEventListener('change', async () => {
  const on = baseMapInput.checked;
  if (!state.terrain) {
    baseMapInput.checked = false;
    return;
  }

  creditEl.classList.toggle('map-on', on);
  state.baseMapOn = on;
  if (state.water) state.water.visible = !on;

  if (!on) {
    detailToken += 1; // stop a build that started while the map was visible
    baseMap.detailKey = '';
    if (baseMap.group) baseMap.group.visible = false;
    if (baseMap.detail) baseMap.detail.visible = false;
    syncDependentFields();
    resetTerrainBlend();
    return;
  }

  syncDependentFields();
  if (baseMap.group) {
    baseMap.group.visible = true;
    if (baseMap.detail) baseMap.detail.visible = true;
    scheduleDetail();
    setTerrainOpacity(state.opacity);
    return;
  }

  setBaseMapUiBusy(true);
  try {
    await ensureBaseMap();
    await refreshDetail();
    updateTerrainBlend();
  } catch (error) {
    console.warn('[base map] failed:', error);
    baseMapInput.checked = false;
    creditEl.classList.remove('map-on');
    state.baseMapOn = false;
    syncDependentFields();
    resetTerrainBlend();
    if (state.water) state.water.visible = true;
  } finally {
    setBaseMapUiBusy(false);
  }
});

/**
 * The uniforms every tile material shares. Each entry is a {value} holder, so tiles
 * reference one object each: updating a holder updates every tile without a loop.
 */
function makeSharedUniforms(heightMin, heightMax) {
  const lutTexture = new THREE.DataTexture(
    new Float32Array(LUT_SIZE * 4), LUT_SIZE, 1, THREE.RGBAFormat, THREE.FloatType,
  );
  lutTexture.minFilter = THREE.NearestFilter;
  lutTexture.magFilter = THREE.NearestFilter;
  lutTexture.needsUpdate = true;
  const sea = hexToLinear(seaHex());
  return {
    uLut: { value: lutTexture },
    uExaggeration: { value: effectiveExaggeration() },
    uHeightMin: { value: heightMin },
    uSpan: { value: heightMax - heightMin },
    uMaxH: { value: Math.max(1, currentMaxHeight) },
    uSeaColor: { value: new THREE.Vector3(sea[0], sea[1], sea[2]) },
    uContourFill: { value: new THREE.Vector3(CONTOUR_FILL[0], CONTOUR_FILL[1], CONTOUR_FILL[2]) },
    uContours: { value: state.contoursOn ? 1 : 0 },
    uLight: { value: lightDir },
    uDemOpacity: { value: state.opacity },
    uFlatMask: { value: terrainMasked() ? 1 : 0 },
    uBlendMode: { value: blendModeValue() },
    uGridOrigin: { value: new THREE.Vector2() },
  };
}

// Island extent in world metres, from the valid-cell bounds the pipeline writes to
// the manifest. The raster rectangle includes sea corners, which would fit the camera
// too far out; the fit needs the land only.
function landExtent(manifest, origin, pixelSize) {
  const c = manifest.land_cells;
  return {
    minX: origin.x + c.col_min * pixelSize,
    maxX: origin.x + c.col_max * pixelSize,
    minZ: origin.z + c.row_min * pixelSize,
    maxZ: origin.z + c.row_max * pixelSize,
  };
}

/* ------------------------------------------------------------------ *
 * Load
 * ------------------------------------------------------------------ */
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
const statusCard = document.getElementById('status-card');
const loadStateEl = document.getElementById('load-spinner');

function showError(title, message, command) {
  statusEl.hidden = false;
  statusEl.classList.remove('is-done');
  statusCard.innerHTML = '';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const paragraph = document.createElement('p');
  paragraph.textContent = message;
  statusCard.append(heading, paragraph);
  if (command) {
    const pre = document.createElement('pre');
    pre.textContent = command;
    statusCard.append(pre);
  }
}

function hideStatus() {
  statusEl.classList.add('is-done');
  window.setTimeout(() => { statusEl.hidden = true; }, 750);
}

// A fixed-slot spinner beside the zoom controls for the continuous detail stream,
// which the full-screen load card cannot cover once the first scene is up.
function updateLoadState(stream) {
  const busy = !!stream && (stream.pending.size > 0 || stream.cache.inflight.size > 0);
  if (busy === !loadStateEl.hidden) return;
  loadStateEl.hidden = !busy;
}

function resize() {
  measureMap();
  const width = viewWidth;
  const height = viewHeight;
  // the device may have moved to a display with a different pixel ratio
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP));
  renderer.setSize(width, height, false);
  resizeCrossSections();
  if (crossShown) scheduleTerrainTip();
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  updateContourLabelScale();
  updateContourLineResolution();
  if (state.terrain && !viewTouched) resetView();
  else scheduleDetail();
  invalidate(); // setSize cleared the drawing buffer
}
window.addEventListener('resize', resize);
if ('ResizeObserver' in window) new ResizeObserver(resize).observe(mapPane);

let viewTouched = false;
let lastCameraMove = 0; // drives the contour settle debounce
// A camera or LOD change has altered the visible ground but the contour sync has
// not run yet — it waits for the camera to settle (CONTOUR_SETTLE_MS) first.
let contourSyncDue = false;
controls.addEventListener('start', () => {
  viewTouched = true;
  orbitTween = null; // a drag or pinch takes over from a button animation
  inertia = null;    // and from a glide still running from the last release
  if (polarLockPending) { polarLockPending = false; applyPolarLock(); }
  lastCameraMove = performance.now();
});
controls.addEventListener('change', () => {
  lastCameraMove = performance.now();
  contourSyncDue = true;
  invalidate();
});
controls.addEventListener('end', scheduleDetail);

/* ------------------------------------------------------------------ *
 * View tools: orientation and zoom buttons
 * ------------------------------------------------------------------ */
const northButton = document.getElementById('tool-north');
const zoomInButton = document.getElementById('tool-in');
const zoomOutButton = document.getElementById('tool-out');

const ORBIT_MS = { rotate: 360, zoom: 160 };
const ZOOM_STEP = 0.65;
const orbitOffset = new THREE.Vector3();
const orbitSphere = new THREE.Spherical();
let orbitTween = null;
let compassDeg = null;

function currentOrbit() {
  orbitSphere.setFromVector3(orbitOffset.copy(camera.position).sub(controls.target));
  return { radius: orbitSphere.radius, phi: orbitSphere.phi, theta: orbitSphere.theta };
}

// Animate in orbit space rather than lerping positions, so a rotation keeps its
// radius and a zoom keeps its bearing.
function tweenOrbit(next, duration) {
  const from = currentOrbit();
  const pending = orbitTween ? orbitTween.to : from;
  inertia = null; // a button animation supersedes a release glide
  orbitTween = {
    from,
    to: {
      radius: next.radius ?? pending.radius,
      phi: next.phi ?? pending.phi,
      theta: next.theta ?? pending.theta,
    },
    start: performance.now(),
    duration,
  };
}

function stepOrbit(now) {
  if (!orbitTween) return;
  const t = Math.min(1, (now - orbitTween.start) / orbitTween.duration);
  const eased = 1 - (1 - t) ** 3;
  const { from, to } = orbitTween;
  orbitSphere.set(
    from.radius + (to.radius - from.radius) * eased,
    from.phi + (to.phi - from.phi) * eased,
    from.theta + (to.theta - from.theta) * eased,
  );
  camera.position.copy(controls.target).add(orbitOffset.setFromSpherical(orbitSphere));
  lastCameraMove = now;
  if (t === 1) {
    orbitTween = null;
    if (polarLockPending) {
      polarLockPending = false;
      applyPolarLock();
    }
    scheduleDetail();
  }
}

/* ------------------------------------------------------------------ *
 * Drag inertia — the glide after the pointer is released.
 *
 * OrbitControls' damping ties drag responsiveness to the release glide with one
 * knob: snappy drags come with almost no glide and vice versa. Instead the drag is
 * left 1:1 (damping off) and the glide is measured here and played out separately:
 * each drag frame samples how the camera actually moved, and on release that
 * velocity decays to a stop in orbit space like the button tweens.
 * ------------------------------------------------------------------ */
const INERTIA_TAU = 0.24;        // seconds; glide distance ≈ release velocity × TAU
const INERTIA_SAMPLE_ALPHA = 0.4; // weight of the newest frame in the velocity EMA
const INERTIA_SPIN_LIMIT = 4;    // rad/s, caps a hard flick
const dragPan = new THREE.Vector3();
let inertia = null;    // { theta, phi, pan, time } velocities, per second
let dragVel = null;    // velocity measured during the current drag
let dragSample = null; // last frame sampled mid-drag
let pointerCount = 0;  // active pointers, so a two-finger gesture ends once

function resetDragVelocity() {
  dragSample = null;
  dragVel = { theta: 0, phi: 0, pan: new THREE.Vector3() };
}

// Read the camera itself rather than the pointer, so the velocity is right whatever
// the input did (rotate, pan, or a two-finger pinch-and-drag) without duplicating
// the control mappings here.
function sampleDrag(now) {
  const orbit = currentOrbit();
  const target = controls.target;
  if (!dragSample) {
    dragSample = { theta: orbit.theta, phi: orbit.phi, target: target.clone(), time: now };
    return;
  }
  const dt = (now - dragSample.time) / 1000;
  // skip the first frame or a jump after the tab was hidden; a long dt would read
  // as a huge velocity
  if (dt <= 0 || dt > 0.2) {
    dragSample.theta = orbit.theta;
    dragSample.phi = orbit.phi;
    dragSample.target.copy(target);
    dragSample.time = now;
    return;
  }
  let dTheta = orbit.theta - dragSample.theta;
  dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta)); // wrap-safe across ±π
  dragPan.copy(target).sub(dragSample.target).divideScalar(dt);
  const a = INERTIA_SAMPLE_ALPHA;
  dragVel.theta += (dTheta / dt - dragVel.theta) * a;
  dragVel.phi += ((orbit.phi - dragSample.phi) / dt - dragVel.phi) * a;
  dragVel.pan.lerp(dragPan, a);
  dragSample.theta = orbit.theta;
  dragSample.phi = orbit.phi;
  dragSample.target.copy(target);
  dragSample.time = now;
}

function releaseDrag(now) {
  const vel = dragVel;
  dragVel = null;
  // ignore a release after a still hold (no fresh sample) or a tiny drag
  if (!vel || !dragSample || !state.terrain || now - dragSample.time > 140) return;
  vel.theta = THREE.MathUtils.clamp(vel.theta, -INERTIA_SPIN_LIMIT, INERTIA_SPIN_LIMIT);
  vel.phi = THREE.MathUtils.clamp(vel.phi, -INERTIA_SPIN_LIMIT, INERTIA_SPIN_LIMIT);
  const panLimit = state.size * 1.5;
  if (vel.pan.length() > panLimit) vel.pan.setLength(panLimit);
  const spin = Math.hypot(vel.theta, vel.phi);
  if (spin < 0.06 && vel.pan.length() < state.size * 0.01) return;
  inertia = { theta: vel.theta, phi: vel.phi, pan: vel.pan.clone(), time: now };
}

function stepInertia(now) {
  if (!inertia) return;
  const dt = Math.min((now - inertia.time) / 1000, 0.05);
  inertia.time = now;
  if (dt <= 0) return;
  if (inertia.pan.lengthSq() > 0) {
    dragPan.copy(inertia.pan).multiplyScalar(dt);
    controls.target.add(dragPan);
    camera.position.add(dragPan);
  }
  if (inertia.theta !== 0 || inertia.phi !== 0) {
    orbitSphere.setFromVector3(orbitOffset.copy(camera.position).sub(controls.target));
    orbitSphere.theta += inertia.theta * dt;
    orbitSphere.phi = THREE.MathUtils.clamp(
      orbitSphere.phi + inertia.phi * dt, controls.minPolarAngle, controls.maxPolarAngle,
    );
    camera.position.copy(controls.target).add(orbitOffset.setFromSpherical(orbitSphere));
  }
  const decay = Math.exp(-dt / INERTIA_TAU);
  inertia.theta *= decay;
  inertia.phi *= decay;
  inertia.pan.multiplyScalar(decay);
  lastCameraMove = now;
  if (Math.abs(inertia.theta) + Math.abs(inertia.phi) < 0.004
    && inertia.pan.length() < 0.5) {
    inertia = null;
    scheduleDetail();
  }
}

// Track pointers, not the controls' own start/end: those also fire around a wheel
// zoom, which must not seed a glide.
const controlEl = renderer.domElement;
controlEl.addEventListener('pointerdown', () => {
  pointerCount++;
  if (pointerCount === 1) {
    inertia = null;
    resetDragVelocity();
  }
});
const onPointerRelease = () => {
  if (pointerCount === 0) return;
  pointerCount--;
  if (pointerCount === 0) releaseDrag(performance.now());
};
controlEl.addEventListener('pointerup', onPointerRelease);
controlEl.addEventListener('pointercancel', onPointerRelease);

/* ------------------------------------------------------------------ *
 * Pointer readout — elevation under the cursor
 * ------------------------------------------------------------------ */
const tipEl = document.getElementById('terrain-tip');
const pickRaycaster = new THREE.Raycaster();
const pickNdc = new THREE.Vector2();
const pickPoint = new THREE.Vector3();
const TIP_MARCH_STEPS = 120;
const TIP_REFINE_STEPS = 12;
const pickGroundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const pickGroundPoint = new THREE.Vector3();
const pickHolePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const pickHolePoint = new THREE.Vector3();
const HOLE_DIRECTIONS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];
let tipAt = null;      // latest client coords while the pointer rests over the canvas
let tipFrame = 0;      // pending requestAnimationFrame id
let tipShown = false;

function coveringTile(x, z, tiles) {
  let best = null;
  for (const tile of tiles) {
    const { x0, z0, x1, z1 } = tile.rect;
    if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
    if (!best || tile.rect.cell < best.rect.cell) best = tile;
  }
  return best;
}

// A no-data sample can be open sea or a hole inside the land. Look outward in
// every direction until land is found: an enclosed hole has land on all eight
// sides, while open water has at least one direction that stays no-data. Searching
// each direction independently lets this work for holes much wider than the tile
// cell without a fixed radius cap.
function isTerrainHole(x, z, tiles) {
  const stream = state.terrain.stream;
  const tile = coveringTile(x, z, tiles);
  if (!tile) return false;
  const cell = tile.rect.cell || state.sourcePixelSize;
  const start = Math.max(30, cell * 2);
  const maxRadius = 2600;
  for (const [dx, dz] of HOLE_DIRECTIONS) {
    let enclosed = false;
    for (let radius = start; radius <= maxRadius; radius *= 2) {
      if (stream.heightAt(x + dx * radius, z + dz * radius, tiles, true) !== null) {
        enclosed = true;
        break;
      }
    }
    if (!enclosed) return false;
  }
  return true;
}

// Estimate the height of a hole's surrounding surface. The first valid sample in
// each direction is enough; the median is stable if one side is a slope.
function holeSurfaceHeight(x, z, tiles) {
  const stream = state.terrain.stream;
  const tile = coveringTile(x, z, tiles);
  if (!tile) return 0;
  const cell = tile.rect.cell || state.sourcePixelSize;
  const start = Math.max(30, cell * 2);
  const heights = [];
  for (const [dx, dz] of HOLE_DIRECTIONS) {
    for (let radius = start; radius <= 2600; radius *= 2) {
      const h = stream.heightAt(x + dx * radius, z + dz * radius, tiles, true);
      if (h !== null) {
        heights.push(h);
        break;
      }
    }
  }
  if (!heights.length) return 0;
  heights.sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)];
}

// A hole has no surface to raycast, so project the cursor onto a horizontal plane
// at the surrounding terrain height. Using y = 0 instead lands well short of the
// hole when the camera is tilted or the hole is on high ground, which put the chart
// cursor on the near rim instead of under the pointer.
function holePointAtHeight(ray, height, tiles, exaggeration) {
  pickHolePlane.constant = -(Number.isFinite(height) ? height : 0) * exaggeration;
  const hit = ray.intersectPlane(pickHolePlane, pickHolePoint);
  if (!hit || !coveringTile(hit.x, hit.z, tiles)) return null;
  const stream = state.terrain.stream;
  if (stream.heightAt(hit.x, hit.z, tiles, true) !== null) return null;
  if (!isTerrainHole(hit.x, hit.z, tiles)) return null;
  return { h: null, x: hit.x, z: hit.z };
}

/**
 * Walk the cursor ray until it passes below the drawn surface, then bisect the
 * crossing. The terrain lives in the vertex shader, so there is no mesh geometry to
 * raycast: `heightAt` samples the decoded tiles the scene is currently drawing.
 * Returns `{x, z, h}` for ground, `{x, z, h: null}` for an enclosed hole, or null
 * over the sea and the empty corners of the raster.
 */
function pickTerrainPoint(clientX, clientY) {
  // The scene wrapper carries UI state; the tile methods live on its stream.
  const terrain = state.terrain?.stream;
  if (!terrain) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  pickNdc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  pickRaycaster.setFromCamera(pickNdc, camera);
  const ray = pickRaycaster.ray;
  const tiles = terrain.drawnTiles();
  if (!tiles.length) return null;

  // The sea-level point is only a fallback classification. A hill hit in front of
  // it is still valid terrain; a hole or open sea at that point must not defer to
  // terrain further along the ray.
  const ground = ray.intersectPlane(pickGroundPlane, pickGroundPoint);
  const tGround = ground ? ground.distanceTo(ray.origin) : Infinity;
  let groundKind = 'ground';
  if (ground) {
    const tile = coveringTile(ground.x, ground.z, tiles);
    if (!tile) groundKind = 'outside';
    else if (terrain.heightAt(ground.x, ground.z, tiles, true) === null) {
      groundKind = isTerrainHole(ground.x, ground.z, tiles) ? 'hole' : 'outside';
    }
  }

  const exaggeration = effectiveExaggeration();
  const distance = camera.position.distanceTo(controls.target);
  const tNear = camera.near;
  const tFar = distance * 3 + state.size * 2;
  const sample = (t) => {
    ray.at(t, pickPoint);
    const h = terrain.heightAt(pickPoint.x, pickPoint.z, tiles);
    return h === null ? null : { h, x: pickPoint.x, z: pickPoint.z, y: pickPoint.y };
  };

  let above = null;  // last t known to be above the surface
  let below = null;  // first t known to be below it
  for (let i = 0; i <= TIP_MARCH_STEPS; i++) {
    const t = tNear + ((tFar - tNear) * i) / TIP_MARCH_STEPS;
    const probe = sample(t);
    if (probe === null) { above = null; continue; } // sea or no tile: nothing to hit
    if (probe.y > probe.h * exaggeration) { above = t; continue; }
    below = t;
    break;
  }
  if (below === null) {
    if (groundKind === 'hole') {
      const estimated = holeSurfaceHeight(ground.x, ground.z, tiles);
      return holePointAtHeight(ray, estimated, tiles, exaggeration)
        ?? { h: null, x: ground.x, z: ground.z };
    }
    // If the march found no crossing but there is valid sampled ground under the
    // cursor, show that rather than dropping the readout at a random-looking spot.
    if (ground && groundKind === 'ground') {
      const h = terrain.heightAt(ground.x, ground.z, tiles);
      if (h !== null) return { h, x: ground.x, z: ground.z };
    }
    return null;
  }
  if (above === null) above = Math.max(tNear, below - (tFar - tNear) / TIP_MARCH_STEPS);

  for (let i = 0; i < TIP_REFINE_STEPS; i++) {
    const mid = (above + below) / 2;
    const probe = sample(mid);
    if (probe === null) { above = mid; continue; }
    if (probe.y > probe.h * exaggeration) above = mid;
    else below = mid;
  }

  const hit = sample(below);
  // The loose read borrows a neighbour's height across a small no-data cell, so it
  // gives the ray a surface to cross. The strict read at that crossing says whether
  // the surface is actually a hole. Do not return the rim itself: reproject onto a
  // plane at the hole's surrounding height so the pick sits under the pointer.
  if (hit && terrain.heightAt(hit.x, hit.z, tiles, true) === null
    && isTerrainHole(hit.x, hit.z, tiles)) {
    const estimated = holeSurfaceHeight(hit.x, hit.z, tiles);
    const hole = holePointAtHeight(ray, estimated, tiles, exaggeration)
      ?? holePointAtHeight(ray, hit.h, tiles, exaggeration);
    if (hole) return hole;
  }

  // A hole in front of the hit still owns the pointer: reproject onto the hole's
  // floor rather than reporting the terrain visible behind it. Open water is not a
  // surface, so a valid hit behind it is still the terrain under the cursor; treating
  // the y = 0 point as a veto made hover drop out at random coastal/low spots.
  if (groundKind === 'hole' && below > tGround + 2) {
    const estimated = holeSurfaceHeight(ground.x, ground.z, tiles);
    return holePointAtHeight(ray, estimated, tiles, exaggeration)
      ?? { h: null, x: ground.x, z: ground.z };
  }
  return hit;
}

/* ------------------------------------------------------------------ *
 * Hover cross-sections — the terrain profile through the cursor, drawn
 * along the left (north–south) and bottom (east–west) edges of the map.
 * ------------------------------------------------------------------ */
const crossCanvas = document.getElementById('cross-section');
const crossCtx = crossCanvas.getContext('2d');
const CROSS_MAX_SAMPLES = 320;
const CROSS_GAP = 10;
let crossDpr = 1;
let crossShown = false;
// The charts sit left and bottom by default. Hovering a chart flips that one to the
// opposite edge, where it stays until the pointer reaches it again.
const crossSides = { vertical: 'left', horizontal: 'bottom' };

function resizeCrossSections() {
  crossDpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(viewWidth * crossDpr));
  const height = Math.max(1, Math.round(viewHeight * crossDpr));
  if (crossCanvas.width !== width || crossCanvas.height !== height) {
    crossCanvas.width = width;
    crossCanvas.height = height;
  }
  crossCanvas.style.width = `${viewWidth}px`;
  crossCanvas.style.height = `${viewHeight}px`;
}

function crossTheme() {
  return themeQuery.matches
    ? {
      panel: 'rgba(13, 20, 23, 0.93)',
      border: 'rgba(236, 240, 236, 0.3)',
      line: 'rgba(250, 252, 249, 1)',
      muted: 'rgba(184, 192, 187, 0.95)',
      noData: 'rgba(255, 176, 84, 1)',
    }
    : {
      panel: 'rgba(250, 252, 249, 0.94)',
      border: 'rgba(17, 28, 22, 0.28)',
      line: 'rgba(10, 14, 12, 1)',
      muted: 'rgba(58, 72, 64, 0.92)',
      noData: 'rgba(158, 74, 6, 1)',
    };
}

// The chart must use the same height-to-colour mapping as the terrain shader:
// normalise by the summit, apply the 0.42 ramp exponent, then sample the palette.
// Calling this with an elevation, rather than a fixed 0..1 stop, keeps a low green
// profile from picking up the palette's red high end.
function crossColor(height, alpha = 1) {
  let rgb;
  if (state.contoursOn) {
    rgb = CONTOUR_FILL;
  } else {
    const max = Math.max(1, state.maxHeight);
    let t = Math.pow(Math.min(1, Math.max(0, height / max)), 0.42);
    if (state.palette.bands) {
      t = (Math.floor(t * state.palette.bands) + 0.5) / state.palette.bands;
    }
    rgb = sampleStops(paletteStops(state.palette), t);
  }
  const [r, g, b] = rgb;
  return `rgba(${Math.round(linearToSrgb(r) * 255)}, `
    + `${Math.round(linearToSrgb(g) * 255)}, `
    + `${Math.round(linearToSrgb(b) * 255)}, ${alpha})`;
}

function crossLayout() {
  const margin = Math.max(10, Math.round(Math.min(viewWidth, viewHeight) * 0.03));
  const leftWidth = Math.max(76, Math.min(132, Math.round(viewWidth * 0.11)));
  const bottomHeight = Math.max(64, Math.min(116, Math.round(viewHeight * 0.14)));
  const verticalOnLeft = crossSides.vertical === 'left';
  const horizontalOnBottom = crossSides.horizontal === 'bottom';

  // The two panels form an L: the vertical one keeps clear of the horizontal
  // band, and the horizontal one keeps clear of the vertical column.
  const left = {
    x: verticalOnLeft ? margin : viewWidth - margin - leftWidth,
    y: margin + (horizontalOnBottom ? 0 : bottomHeight + CROSS_GAP),
    w: leftWidth,
    h: viewHeight - margin * 2 - bottomHeight - CROSS_GAP,
  };
  const bottom = {
    x: margin + (verticalOnLeft ? leftWidth + CROSS_GAP : 0),
    y: horizontalOnBottom ? viewHeight - margin - bottomHeight : margin,
    w: viewWidth - margin * 2 - leftWidth - CROSS_GAP,
    h: bottomHeight,
  };
  if (bottom.w < 100 || left.h < 80) return null;
  return { left, bottom };
}

function crossDomain(values) {
  let min = 0;
  let max = 0;
  let has = false;
  for (const value of values) {
    if (value === null) continue;
    has = true;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const pad = Math.max(2, (max - min) * 0.08);
  // Positive terrain sits on the plot floor: no negative padding below 0 m, so the
  // area stays anchored to the bottom/left edge instead of floating above it.
  return { lo: min < 0 ? min - pad : 0, hi: max + pad, has };
}

function sampleProfile(axis, fixed, start, end, count, tiles) {
  const stream = state.terrain.stream;
  const values = new Array(count);
  const valid = new Array(count);
  for (let i = 0; i < count; i++) {
    const t = start + ((end - start) * i) / (count - 1);
    const h = axis === 'x'
      ? stream.heightAt(t, fixed, tiles, true)
      : stream.heightAt(fixed, t, tiles, true);
    // The raster has no height outside the land mask. Drawing those samples at sea
    // level keeps the profile continuous instead of breaking the area chart into
    // disjoint land fragments wherever the line crosses water.
    valid[i] = h !== null;
    values[i] = h === null ? 0 : h;
  }
  return { values, valid };
}

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawCrossChart(rect, profile, vertical, cursorFraction, cursorHole, theme) {
  const { values, valid } = profile;
  const domain = crossDomain(values);
  roundedRect(crossCtx, rect.x, rect.y, rect.w, rect.h, 7);
  crossCtx.fillStyle = theme.panel;
  crossCtx.fill();
  crossCtx.strokeStyle = theme.border;
  crossCtx.lineWidth = 1;
  crossCtx.stroke();
  if (!domain.has) return;

  const pad = 10;
  const innerX = rect.x + pad;
  const innerY = rect.y + pad;
  const innerW = Math.max(1, rect.w - pad * 2);
  const innerH = Math.max(1, rect.h - pad * 2);
  const span = Math.max(0.001, domain.hi - domain.lo);
  const position = (h) => (h - domain.lo) / span;
  const lastIndex = Math.max(1, values.length - 1);
  const xAt = (i) => (vertical
    ? innerX + position(values[i]) * innerW
    : innerX + (i / lastIndex) * innerW);
  const yAt = (i) => (vertical
    ? innerY + (i / lastIndex) * innerH
    : innerY + innerH - position(values[i]) * innerH);
  const baseline = vertical
    ? innerX + position(0) * innerW
    : innerY + innerH - position(0) * innerH;

  // Use the profile's own valid height range for the ramp, not the whole palette:
  // a chart through low green ground should stay in the palette's green band.
  let colorLo = Infinity;
  let colorHi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (!valid[i]) continue;
    colorLo = Math.min(colorLo, values[i]);
    colorHi = Math.max(colorHi, values[i]);
  }
  if (!Number.isFinite(colorLo)) {
    colorLo = 0;
    colorHi = 0;
  }
  const colorMid = (colorLo + colorHi) / 2;

  const gradient = vertical
    ? crossCtx.createLinearGradient(innerX, 0, innerX + innerW, 0)
    : crossCtx.createLinearGradient(0, innerY + innerH, 0, innerY);
  gradient.addColorStop(0, crossColor(colorLo, 0.7));
  gradient.addColorStop(0.55, crossColor(colorMid, 0.85));
  gradient.addColorStop(1, crossColor(colorHi, 0.95));

  // One continuous area: no-data samples sit on the 0 m baseline, so the chart
  // keeps its silhouette instead of breaking into missing pieces.
  crossCtx.beginPath();
  if (vertical) {
    crossCtx.moveTo(baseline, innerY);
    for (let i = 0; i < values.length; i++) crossCtx.lineTo(xAt(i), yAt(i));
    crossCtx.lineTo(baseline, innerY + innerH);
  } else {
    crossCtx.moveTo(innerX, baseline);
    for (let i = 0; i < values.length; i++) crossCtx.lineTo(xAt(i), yAt(i));
    crossCtx.lineTo(innerX + innerW, baseline);
  }
  crossCtx.closePath();
  crossCtx.fillStyle = gradient;
  crossCtx.fill();

  // Ground gets the solid line; holes and sea get a dashed warm line, so a flat
  // stretch at 0 m is not mistaken for valid ground.
  const strokeRun = (start, end, okay) => {
    if (end <= start) {
      crossCtx.beginPath();
      crossCtx.arc(xAt(start), yAt(start), 1.5, 0, Math.PI * 2);
      crossCtx.fillStyle = okay ? theme.line : theme.noData;
      crossCtx.fill();
      return;
    }
    crossCtx.beginPath();
    for (let i = start; i <= end; i++) {
      if (i === start) crossCtx.moveTo(xAt(i), yAt(i));
      else crossCtx.lineTo(xAt(i), yAt(i));
    }
    crossCtx.strokeStyle = okay ? theme.line : theme.noData;
    crossCtx.lineWidth = 1.5;
    crossCtx.lineJoin = 'round';
    crossCtx.setLineDash(okay ? [] : [3.5, 2.5]);
    crossCtx.stroke();
    crossCtx.setLineDash([]);
  };

  let i = 0;
  while (i < values.length) {
    const okay = valid[i];
    let end = i + 1;
    while (end < values.length && valid[end] === okay) end++;
    strokeRun(i, end - 1, okay);
    i = end;
  }

  if (cursorFraction >= 0 && cursorFraction <= 1) {
    crossCtx.beginPath();
    crossCtx.setLineDash([3, 3]);
    if (vertical) {
      const y = innerY + cursorFraction * innerH;
      crossCtx.moveTo(innerX, y);
      crossCtx.lineTo(innerX + innerW, y);
    } else {
      const x = innerX + cursorFraction * innerW;
      crossCtx.moveTo(x, innerY);
      crossCtx.lineTo(x, innerY + innerH);
    }
    crossCtx.strokeStyle = cursorHole ? theme.noData : theme.line;
    crossCtx.lineWidth = 1.25;
    crossCtx.stroke();
    crossCtx.setLineDash([]);
  }

  crossCtx.fillStyle = theme.muted;
  crossCtx.font = '9px ui-sans-serif, -apple-system, Helvetica, Arial, sans-serif';
  if (vertical) {
    crossCtx.textAlign = 'left';
    crossCtx.textBaseline = 'top';
    crossCtx.fillText('N', rect.x + 7, rect.y + 6);
    crossCtx.textBaseline = 'bottom';
    crossCtx.fillText('S', rect.x + 7, rect.y + rect.h - 6);
  } else {
    crossCtx.textBaseline = 'bottom';
    crossCtx.textAlign = 'left';
    crossCtx.fillText('W', rect.x + 7, rect.y + rect.h - 6);
    crossCtx.textAlign = 'right';
    crossCtx.fillText('E', rect.x + rect.w - 7, rect.y + rect.h - 6);
  }
}

const crossPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const crossRaycaster = new THREE.Raycaster();
const crossNdc = new THREE.Vector2();
const crossHit = new THREE.Vector3();

// The ground rectangle under the viewport. Projecting the four screen corners onto
// the y = 0 plane gives a tighter crop than the union of held/drawn tiles, which can
// extend far outside the view after a zoom or pan.
function visibleGroundRect(terrain) {
  const minX = terrain.origin.x;
  const maxX = minX + terrain.width;
  const minZ = terrain.origin.z;
  const maxZ = minZ + terrain.depth;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const [nx, ny] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    crossRaycaster.setFromCamera(crossNdc.set(nx, ny), camera);
    if (!crossRaycaster.ray.intersectPlane(crossPlane, crossHit)) continue;
    left = Math.min(left, crossHit.x);
    right = Math.max(right, crossHit.x);
    top = Math.min(top, crossHit.z);
    bottom = Math.max(bottom, crossHit.z);
  }
  if (!Number.isFinite(left) || !(right > left) || !(bottom > top)) return null;
  return {
    minX: Math.max(minX, left),
    maxX: Math.min(maxX, right),
    minZ: Math.max(minZ, top),
    maxZ: Math.min(maxZ, bottom),
  };
}

function pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function drawCrossSections(point) {
  const terrain = state.terrain;
  if (!terrain) {
    hideCrossSections();
    return;
  }
  resizeCrossSections();
  let layout = crossLayout();
  const tiles = terrain.stream.drawnTiles();
  if (!layout || !tiles.length) {
    hideCrossSections();
    return;
  }

  // Hovering a chart flips it to the opposite edge. Once moved, the pointer is no
  // longer over it, so the new side is held until the pointer reaches it again.
  if (tipAt) {
    const rect = canvas.getBoundingClientRect();
    const x = tipAt.x - rect.left;
    const y = tipAt.y - rect.top;
    let flipped = false;
    if (pointInRect(x, y, layout.left)) {
      crossSides.vertical = crossSides.vertical === 'left' ? 'right' : 'left';
      flipped = true;
    }
    if (pointInRect(x, y, layout.bottom)) {
      crossSides.horizontal = crossSides.horizontal === 'bottom' ? 'top' : 'bottom';
      flipped = true;
    }
    if (flipped) layout = crossLayout();
  }
  if (!layout) {
    hideCrossSections();
    return;
  }

  const bounds = visibleGroundRect(terrain);
  if (!bounds || !(bounds.maxX > bounds.minX) || !(bounds.maxZ > bounds.minZ)) {
    hideCrossSections();
    return;
  }
  const { minX, maxX, minZ, maxZ } = bounds;
  const verticalCount = Math.min(
    CROSS_MAX_SAMPLES,
    Math.max(100, Math.round(layout.left.h * 1.3)),
  );
  const horizontalCount = Math.min(
    CROSS_MAX_SAMPLES,
    Math.max(140, Math.round(layout.bottom.w)),
  );
  const cursorX = Math.min(maxX, Math.max(minX, point.x));
  const cursorZ = Math.min(maxZ, Math.max(minZ, point.z));
  const vertical = sampleProfile('z', cursorX, minZ, maxZ, verticalCount, tiles);
  const horizontal = sampleProfile('x', cursorZ, minX, maxX, horizontalCount, tiles);
  if (!crossDomain(vertical.values).has && !crossDomain(horizontal.values).has) {
    hideCrossSections();
    return;
  }
  const cursorHole = point.h === null;

  crossCtx.setTransform(1, 0, 0, 1, 0, 0);
  crossCtx.clearRect(0, 0, crossCanvas.width, crossCanvas.height);
  crossCtx.setTransform(crossDpr, 0, 0, crossDpr, 0, 0);
  const theme = crossTheme();
  drawCrossChart(layout.left, vertical, true, (cursorZ - minZ) / (maxZ - minZ), cursorHole, theme);
  drawCrossChart(layout.bottom, horizontal, false, (cursorX - minX) / (maxX - minX), cursorHole, theme);
  crossCanvas.hidden = false;
  crossShown = true;
}

function hideCrossSections() {
  if (!crossShown) return;
  crossShown = false;
  crossCanvas.hidden = true;
  crossCtx.setTransform(1, 0, 0, 1, 0, 0);
  crossCtx.clearRect(0, 0, crossCanvas.width, crossCanvas.height);
}

function placeTip(clientX, clientY) {
  const gap = 14;
  const pad = 8;
  const width = tipEl.offsetWidth;
  const height = tipEl.offsetHeight;
  const rect = canvas.getBoundingClientRect();
  let x = clientX + gap;
  let y = clientY + gap;
  if (x + width > rect.right - pad) x = clientX - gap - width;
  if (y + height > rect.bottom - pad) y = clientY - gap - height;
  x = Math.max(rect.left + pad, x);
  y = Math.max(rect.top + pad, y);
  tipEl.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}

function hideTerrainTip() {
  canvas.classList.remove('picking');
  hideCrossSections();
  if (!tipShown) return;
  tipShown = false;
  tipEl.hidden = true;
}

function refreshTerrainTip() {
  tipFrame = 0;
  if (!tipAt || pointerCount > 0) return;
  const point = pickTerrainPoint(tipAt.x, tipAt.y);
  if (point === null) {
    hideTerrainTip();
    return;
  }
  // Show the nearest stored sample of the tile being drawn, rounded to whole
  // metres. At wide zoom that cell is an overview, not level 0. The bilinear value
  // is only for the charts and picking; it is not a source measurement.
  const source = point.h === null
    ? null
    : state.terrain?.stream.heightAtSource(point.x, point.z);
  tipEl.textContent = point.h === null
    ? 'No data'
    : `≈ ${Math.round(source ?? point.h)} m`;
  tipEl.hidden = false;
  tipShown = true;
  canvas.classList.add('picking');
  placeTip(tipAt.x, tipAt.y);
  drawCrossSections(point);
}

function scheduleTerrainTip() {
  if (tipFrame) return;
  tipFrame = requestAnimationFrame(refreshTerrainTip);
}

canvas.addEventListener('pointermove', (event) => {
  if (event.pointerType === 'touch') return;
  tipAt = { x: event.clientX, y: event.clientY };
  if (pointerCount > 0) { // dragging: the readout would chase the terrain under a moving view
    hideTerrainTip();
    return;
  }
  scheduleTerrainTip();
});
canvas.addEventListener('pointerleave', () => {
  tipAt = null;
  hideTerrainTip();
});
controlEl.addEventListener('pointerdown', hideTerrainTip);
// A camera move under a resting pointer changes what is under it: re-sample.
controls.addEventListener('change', scheduleTerrainTip);

// North is +Y in the compass but theta = 0 in orbit space: the camera sits due south
// of the target, looking north. Take the shortest wrapped path so a button press
// always returns to that bearing instead of stepping a quarter turn from wherever
// the view happens to be.
function rotateToNorth() {
  if (!state.terrain) return;
  const base = orbitTween ? orbitTween.to.theta : currentOrbit().theta;
  const delta = Math.atan2(Math.sin(-base), Math.cos(-base));
  if (Math.abs(delta) < 1e-3) return;
  tweenOrbit({ theta: base + delta }, ORBIT_MS.rotate);
}

function zoomBy(factor) {
  if (!state.terrain) return;
  const base = orbitTween ? orbitTween.to.radius : currentOrbit().radius;
  const radius = THREE.MathUtils.clamp(
    base * factor,
    controls.minDistance * 1.02,
    controls.maxDistance * 0.98,
  );
  if (Math.abs(radius - base) < 1) return;
  tweenOrbit({ radius }, ORBIT_MS.zoom);
}

// The needle shows where north sits on screen, so it tracks free rotation too.
function updateCompass() {
  const deg = Math.round(THREE.MathUtils.radToDeg(controls.getAzimuthalAngle())) % 360;
  if (deg === compassDeg) return;
  compassDeg = deg;
  northButton.style.setProperty('--bearing', `${deg}deg`);
}

northButton.addEventListener('click', rotateToNorth);
zoomInButton.addEventListener('click', () => zoomBy(ZOOM_STEP));
zoomOutButton.addEventListener('click', () => zoomBy(1 / ZOOM_STEP));

/* ------------------------------------------------------------------ *
 * Render on demand — a still view costs nothing.
 *
 * The loop keeps running (tweens, inertia, controls, compass: all cheap), but
 * the expensive parts — the quadtree walk, the label pass and renderer.render —
 * run only when something actually changed. Repainting a static scene at the
 * display's refresh rate is what warmed the machine while idle: ~1.6 M triangles
 * at 120 fps for a frame that never differs from the last one. Changes flag
 * themselves: camera movement arrives through the controls' change event, scene
 * and uniform mutations call invalidate(), a landed tile read calls it through
 * the stream's onArrival, and stream.update() reports whether the drawn set
 * changed. The 1 Hz keep-alive bounds any mutation path that forgets
 * invalidate() to one second instead of for ever.
 * ------------------------------------------------------------------ */
const IDLE_RENDER_MS = 1000;
let needsRender = true;
let lastRenderAt = 0;
function invalidate() { needsRender = true; }

function frameLoop(now = performance.now()) {
  // Schedule the next frame first: if streaming throws (a failed tile allocation,
  // a bad read), the render loop must survive it instead of stopping on the spot.
  requestAnimationFrame(frameLoop);
  stepOrbit(now);
  stepInertia(now);
  controls.update(); // a real camera move dispatches 'change' -> invalidate()
  // sample after update() so the velocity reflects the drag that was just applied
  if (pointerCount > 0) sampleDrag(now);
  updateCompass();

  const stream = state.terrain && state.terrain.stream;
  if (stream) {
    // On touch, do not refine while a gesture is moving the camera: a tile that
    // lands mid-drag forces a texture upload and remesh exactly when frames matter
    // most. The overview still follows the view; fine reads resume after settling.
    const settling = TOUCH_UI && (pointerCount > 0 || now - lastCameraMove < TILE_SETTLE_MS);
    if (settling !== stream.deferReads) {
      stream.deferReads = settling;
      if (!settling) invalidate(); // run update() once more to release the reads
    }
    // Tile LOD picks each tile's level from its projected size; the target is in
    // device pixels, so the viewport height is the drawing-buffer height. The walk
    // only matters while the camera moves or a read is in flight — an idle view
    // skips it entirely (arrivals wake it through onArrival -> invalidate).
    const busy = stream.pending.size > 0 || stream.cache.inflight.size > 0;
    if (needsRender || busy) {
      try {
        // reports whether the drawn set changed (a tile arrived, appeared, retired)
        if (stream.update(camera, renderer.domElement.height, camera.fov, LOD_CELL_PX)) {
          invalidate();
          contourSyncDue = true; // the contour level follows the finest drawn tile
        }
      } catch (error) {
        console.warn('[terrain] frame update failed:', error);
      }
    }
  }
  updateLoadState(stream);

  // Contour syncing, reads and builds run regardless of needsRender, so queued
  // work always drains; each step only *repaints* once it has changed something.
  if (state.contoursOn && state.contour) {
    try {
      if (contourSyncDue && now - lastCameraMove >= CONTOUR_SETTLE_MS) {
        syncContours();
        contourSyncDue = false;
      }
      if (state.contour.queue.length) processContourQueue();
      if (state.contour.ready.length) processContourBuilds();
    } catch (error) {
      console.warn('[contours] frame update failed:', error);
    }
  }

  if (!needsRender && now - lastRenderAt < IDLE_RENDER_MS) return;
  needsRender = false;
  lastRenderAt = now;

  if (state.contour && state.contoursOn) updateContourLabels();
  renderer.render(scene, camera);
}

async function load() {
  resize();
  requestAnimationFrame(frameLoop);
  buildPaletteButtons();
  buildBaseMapStyleButtons();
  buildBlendModeButtons();

  let manifest;
  try {
    const response = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    manifest = await response.json();
  } catch (error) {
    showError(
      'Elevation model not found',
      'This page reads the dataset produced by pipeline/gem15_singapore.py. Generate it once, then reload. The folder must be served over HTTP with Range support, not opened from disk.',
      'python3 pipeline/gem15_singapore.py\nnpm run dev',
    );
    console.error(error);
    return;
  }

  statusText.textContent = 'Reading the terrain index…';
  let cog;
  try {
    cog = await openCog(new URL(manifest.file, new URL(MANIFEST_URL, location.href)).href);
  } catch (error) {
    showError(
      'Elevation model could not be opened',
      String(error && error.message),
      'npm run dev',
    );
    console.error(error);
    return;
  }

  try {
    buildScene(manifest, cog);
  } catch (error) {
    console.error('[scene]', error);
    showError('Terrain could not be built', String(error && error.message), null);
  }
}

function buildScene(manifest, cog) {
  const heightMin = Number(manifest.height_min);
  const heightMax = Math.max(heightMin + 1, Number(manifest.height_max));
  const top = cog.levels[0];
  const pixelSize = Number(manifest.pixel_size_m) || 15;

  state.maxHeight = heightMax;
  state.sourcePixelSize = pixelSize;
  state.geo = manifest.geographic_bounds;
  if (!state.geo) baseMapInput.disabled = true; // no anchor for the base-map tile maths
  // Set before the shared uniforms are built: makeSharedUniforms seeds uMaxH from it,
  // and a stale value would saturate the colour ramp.
  currentMaxHeight = heightMax;

  // Shared uniform objects: every tile material references these same {value}
  // holders, so a palette, exaggeration or opacity change updates all tiles at once.
  shared = makeSharedUniforms(heightMin, heightMax);
  updateTerrainUniforms(); // fill the palette LUT before the first tile draws

  const width = (top.width - 1) * pixelSize;
  const depth = (top.height - 1) * pixelSize;
  const origin = { x: -width / 2, z: -depth / 2 };
  const terrain = {
    cog,
    width,
    depth,
    land: landExtent(manifest, origin, pixelSize),
    dx: pixelSize,
    dz: pixelSize,
    cols: top.width,
    rows: top.height,
    origin,
  };
  state.terrain = terrain;
  terrain.stream = new TerrainStream(cog, {
    origin,
    shared,
    scene,
    cache: new TileCache(TILE_CACHE_LIMIT, { heightMin, span: heightMax - heightMin }),
    // Tiles are created long after this call, so the blend state travels with the
    // stream rather than being patched on afterwards.
    materialStyle: applyMaterialBlend,
    // Half-resolution terrain mesh on touch: the texture still carries the full
    // samples, but the vertex stage does six texture reads per vertex and is the
    // bottleneck on mobile GPUs.
    geometryStep: TOUCH_UI ? 2 : 1,
    // A landed read must wake the render loop: by the next frame the stream's own
    // pending flag is clear, so nothing else would run update() to place the tile.
    onArrival: () => {
      invalidate();
      updateLoadState(state.terrain && state.terrain.stream);
    },
  });

  // An invisible depth sheet, not a coloured sea: it still hides the sea floor
  // below `WATER_Y`, while the canvas stays transparent so the page's checkerboard
  // shows through as the open water. Render it before the terrain so the sea floor
  // is depth-rejected instead of painted over.
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 10, depth * 10),
    new THREE.MeshBasicMaterial({ colorWrite: false }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_Y;
  water.renderOrder = -10;
  state.water = water;
  scene.add(water);
  updateWaterTint();

  state.size = Math.max(width, depth);
  controls.maxDistance = state.size * 3.2;
  updateMinDistance();

  // 2D is the default: the terrain starts flat and the camera locks to top-down.
  view3dInput.checked = state.mode3D;
  syncDependentFields();
  applyPolarLock();
  resetView();

  contourInput.disabled = false;
  updateLegend();
  hideStatus();

  // handy for debugging in the console: scene, terrain, camera
  window.__dem = { scene, camera, controls, renderer, state, terrain, cog };

  console.info(
    `[DEM] ${manifest.file} ${top.width}×${top.height} at ${pixelSize} m, `
    + `${cog.levels.length} levels, 0–${heightMax.toFixed(1)} m`,
  );
}

load().catch((error) => {
  console.error('[load]', error);
  showError('Viewer failed to start', String(error && error.message), null);
});
