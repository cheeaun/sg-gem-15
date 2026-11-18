/**
 * Tile preparation worker: receives a copy of a decoded tile, computes the relief
 * mask and packs the RG texture buffer, then transfers it back. Decoding already
 * happens in geotiff's pool; this keeps the remaining O(N) passes off the frame.
 */
import { packTileData } from './terrain-relief.js';

self.onmessage = (event) => {
  const { id, heights, side, heightMin, span, reach } = event.data;
  try {
    const { data, coast } = packTileData(heights, side, heightMin, span, reach);
    self.postMessage({ id, data, coast }, [data.buffer]);
  } catch (error) {
    self.postMessage({ id, error: String(error && error.message ? error.message : error) });
  }
};
