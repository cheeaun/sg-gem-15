/**
 * Pure tile preparation: flat-land relief and the packed RG texture buffer. It lives
 * outside terrain-cog.js so the same code runs in a worker, off the main thread,
 * where the separable sliding min/max and the per-sample packing would otherwise
 * stall a frame on every tile arrival.
 */

/** Sliding min (isMax=false) or max over a window of 2·reach+1 along one axis. */
function slidingExtrema(values, cols, rows, reach, axisCols, isMax) {
  const out = new Float32Array(values.length);
  const lineLen = axisCols ? cols : rows;
  const lines = axisCols ? rows : cols;
  const deque = new Int32Array(lineLen + 1);
  const sentinel = isMax ? -Infinity : Infinity;
  const better = (a, b) => (isMax ? a >= b : a <= b);
  for (let line = 0; line < lines; line++) {
    const idx = (p) => (axisCols ? line * cols + p : p * cols + line);
    const val = (p) => {
      const v = values[idx(p)];
      return Number.isFinite(v) ? v : sentinel;
    };
    let head = 0;
    let tail = 0;
    let next = 0;
    for (let c = 0; c < lineLen; c++) {
      const hiEdge = Math.min(lineLen - 1, c + reach);
      while (next <= hiEdge) {
        const v = val(next);
        while (tail > head && better(v, val(deque[tail - 1]))) tail--;
        deque[tail++] = next;
        next++;
      }
      while (deque[head] < c - reach) head++;
      out[idx(c)] = val(deque[head]);
    }
  }
  return out;
}

/**
 * Flat-land relief for one apron-padded tile: the local height range over ±reach
 * samples, mapped through smoothstep(2.5 m, 11 m). Separable sliding min/max (O(N),
 * monotone deque), the same as the single-mesh viewer. No-data is excluded from both
 * passes; a window with no valid sample gives 0.
 */
export function tileRelief(heights, side, reach = 3, flat = 2.5, hill = 11) {
  const lo = slidingExtrema(heights, side, side, reach, true, false);
  const hi = slidingExtrema(heights, side, side, reach, true, true);
  const lo2 = slidingExtrema(lo, side, side, reach, false, false);
  const hi2 = slidingExtrema(hi, side, side, reach, false, true);
  const out = new Float32Array(side * side);
  for (let k = 0; k < out.length; k++) {
    if (!Number.isFinite(heights[k])) continue;
    const range = hi2[k] - lo2[k];
    if (!(range > 0)) continue;
    const t = Math.min(1, Math.max(0, (range - flat) / (hill - flat)));
    out[k] = t * t * (3 - 2 * t);
  }
  return out;
}

/**
 * Pack one tile for the GPU: R = height normalised to 0..1 with -1 for no-data,
 * G = relief. Raw metres would break the shader's land test (real land here sits
 * below sea level); the -1 sentinel matches the old single-mesh viewer.
 */
export function packTileData(heights, side, heightMin, span, reach = 3) {
  const relief = tileRelief(heights, side, reach);
  const data = new Float32Array(side * side * 2);
  let anyValid = false;
  let anyInvalid = false;
  for (let k = 0; k < side * side; k++) {
    const h = heights[k];
    const valid = Number.isFinite(h);
    if (valid) anyValid = true;
    else anyInvalid = true;
    data[k * 2] = valid ? (h - heightMin) / span : -1;
    data[k * 2 + 1] = relief[k];
  }
  // A tile that contains both land and no-data carries a coastline: keep its full
  // mesh resolution so the outline stays as detailed as desktop. Wholly sea or
  // wholly interior tiles can use the coarser mesh without changing the silhouette.
  return { data, coast: anyValid && anyInvalid };
}
