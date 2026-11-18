#!/usr/bin/env python3
"""
gem15_singapore.py — download GEM-15 DTM, crop to Singapore, write a Cloud-Optimised GeoTIFF.

Output (in ./data/gem15_singapore/, or --out DIR):
  singapore_dtm.tif   Cloud-Optimised GeoTIFF (COG). Float32 metres, UTM 48N, NaN = no data.
                      Tiled 256 px, DEFLATE + floating-point predictor (lossless), with
                      overview levels built by averaging. Level 0 is the source grid
                      unchanged; each overview halves the resolution. The viewer reads
                      it with HTTP range requests and picks a level per screen region.
  manifest.json       grid/level geometry, height range, geographic bounds, boundary
                      checksum, SHA-256 of the COG, and the mask report.

Heights: GEM-15 reports valid cells slightly below 0 m inside the land polygon
(reservoirs, water surfaces, quarries). They are kept. Anything below MIN_LAND_HEIGHT_M
is clamped to that floor and counted in the manifest.

Mac requirements:  pip3 install rasterio pyproj numpy requests
Usage:  python3 pipeline/gem15_singapore.py [--out DIR]
"""

import argparse
import hashlib
import json
import os

import numpy as np
import requests

GCS = (
    "https://storage.googleapis.com/download/storage/v1/b/climate-and-sustainability/o/"
    "gem-15%2Fp0_p100%2F{cell}%2Fdtm%2Fzall%2Fmosaic.tif?alt=media"
)
CELLS = ["w103s1", "w104s1"]  # the two 1-degree GEM-15 cells touching Singapore

# Boundary pinned to a commit and a SHA-256 digest, so a moved branch or a changed
# file fails loudly instead of silently changing the mask.
BOUNDARY_URL = (
    "https://raw.githubusercontent.com/georgique/world-geojson/"
    "c379575bd58081dbf849c9a11a1d278e483688a4/countries/singapore.json"
)
BOUNDARY_SHA256 = "44b16845dfd92e1e7c6389515f61f945a7b3aefb60620c9f7e3b678a5417a0cc"

UTM = "EPSG:32648"  # UTM zone 48N = GEM-15's CRS here
MIN_LAND_HEIGHT_M = -40.0  # floor for the encoded range; see module docstring

# Outlying islands the national boundary polygon can miss. Each seed adds a buffered
# disk to the mask; only pixels where GEM-15 has data end up in the output.
ISLAND_SEEDS = [  # (name, lon, lat, radius_m)
    ("Sentosa", 103.8200, 1.2500, 1200),
    ("Pulau Ubin", 103.9650, 1.4100, 1800),
    ("Pulau Tekong", 104.0100, 1.4000, 1800),
    ("St John's Island", 103.8503, 1.2267, 250),
    ("Lazarus Island", 103.8563, 1.2230, 300),
    ("Kusu Island", 103.8590, 1.2255, 250),
    ("Pulau Jong", 103.8360, 1.2180, 150),
    ("Pulau Tekukor", 103.8260, 1.2250, 150),
    ("Pulau Hantu", 103.8180, 1.2280, 150),
    ("Pulau Semakau", 103.7950, 1.1960, 600),
    ("Sisters Islands", 103.8380, 1.1855, 150),
    ("Sultan Shoal", 103.7700, 1.2337, 150),
    ("Pulau Sudong", 103.7930, 1.1840, 150),
    ("Pulau Pawai", 103.8100, 1.1850, 150),
    ("Pulau Senang", 103.8310, 1.1230, 150),
    ("Pulau Biola", 103.8127, 1.1017, 150),
    ("Pulau Satumu", 103.7800, 1.0936, 150),
]


def fetch_boundary():
    """Return Singapore's land polygons (main island plus outlying islands in the
    source file) as one MultiPolygon in EPSG:4326, verified against SHA-256."""
    r = requests.get(BOUNDARY_URL, timeout=60)
    r.raise_for_status()
    digest = hashlib.sha256(r.content).hexdigest()
    if digest != BOUNDARY_SHA256:
        raise SystemExit(
            f"Boundary checksum mismatch: got {digest}, expected {BOUNDARY_SHA256}"
        )
    polys = []
    for feat in r.json()["features"]:
        geom = feat["geometry"]
        if geom["type"] == "Polygon":
            polys.append(geom["coordinates"])
        elif geom["type"] == "MultiPolygon":
            polys.extend(geom["coordinates"])
        else:
            raise SystemExit(f"Unexpected boundary geometry: {geom['type']}")
    if not polys:
        raise SystemExit("Boundary file contains no polygons")
    return {"type": "MultiPolygon", "coordinates": polys}


def reproject_geom(geom, src, dst):
    from pyproj import Transformer

    tr = Transformer.from_crs(src, dst, always_xy=True)

    def coords_ring(ring):
        xs, ys = zip(*ring)
        nx, ny = tr.transform(xs, ys)
        return list(zip(nx, ny))

    if geom["type"] == "Polygon":
        return {
            "type": "Polygon",
            "coordinates": [coords_ring(r) for r in geom["coordinates"]],
        }
    if geom["type"] == "MultiPolygon":
        return {
            "type": "MultiPolygon",
            "coordinates": [[coords_ring(r) for r in p] for p in geom["coordinates"]],
        }
    raise ValueError(geom["type"])


def geom_bounds(geom):
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    xs, ys = [], []
    for poly in polys:
        for ring in poly:
            for x, y in ring:
                xs.append(x)
                ys.append(y)
    return min(xs), min(ys), max(xs), max(ys)


def fetch_and_merge(bounds):
    """Windowed read of the GEM-15 tiles via /vsicurl, mosaicked on one grid."""
    import rasterio
    from rasterio.merge import merge

    srcs = []
    try:
        for cell in CELLS:
            url = "/vsicurl/" + GCS.format(cell=cell)
            print(f"  opening {cell} ...")
            ds = rasterio.open(url)
            left, bottom, right, top = bounds
            b = ds.bounds
            if b.right < left or b.left > right or b.top < bottom or b.bottom > top:
                print("    no intersection, skipping")
                ds.close()
                continue
            srcs.append(ds)
        if not srcs:
            raise SystemExit("No GEM-15 tiles intersect Singapore.")
        print("  reading windowed data (HTTP range requests, Singapore area only)...")
        mosaic, transform = merge(srcs, bounds=bounds)
        crs = srcs[0].crs
    finally:
        for ds in srcs:
            ds.close()
    return mosaic[0].astype("float32"), transform, crs


def mask_to_singapore(arr, transform, crs, geom_utm, seeds):
    """Keep pixels inside the boundary polygon or inside an island seed disk.
    A seed only widens the mask, so no-data pixels stay no-data."""
    from pyproj import Transformer
    from rasterio.features import geometry_mask

    keep = geometry_mask(
        [geom_utm],
        out_shape=arr.shape,
        transform=transform,
        invert=True,
        all_touched=False,
    )
    fwd = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    rows = np.arange(arr.shape[0])
    cols = np.arange(arr.shape[1])
    px = transform.c + (cols + 0.5) * transform.a  # easting of each column centre
    py = transform.f + (rows + 0.5) * transform.e  # northing of each row centre
    report = []
    for name, lon, lat, rad in seeds:
        x, y = fwd.transform(lon, lat)
        dx = px[None, :] - x
        dy = py[:, None] - y
        disk = (dx * dx + dy * dy) <= rad * rad
        report.append((name, int((disk & np.isfinite(arr)).sum())))
        keep |= disk
    out = arr.copy()
    out[~keep] = np.nan
    return out, report


def bounds_lonlat(transform, width, height, crs):
    from pyproj import Transformer

    tr = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    lon0, lat1 = tr.transform(transform.c, transform.f)
    lon1, lat0 = tr.transform(
        transform.c + width * transform.a, transform.f + height * transform.e
    )
    return lon0, lat0, lon1, lat1  # west, south, east, north






def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


COG_BLOCK = 256


def write_cog(path, arr, transform, crs, source_note):
    """Write a Cloud-Optimised GeoTIFF with internal overviews, via GDAL's COG driver.

    Level 0 is the source grid, unchanged. Overviews are averages over valid cells
    (NaN ignored), so coarse levels are smoothed means of the same data. Float
    predictor + DEFLATE is lossless. The grid is ~40 MB, so classic TIFF is used.
    """
    import rasterio
    from rasterio.shutil import copy as rio_copy

    profile = {
        "driver": "GTiff",
        "width": arr.shape[1],
        "height": arr.shape[0],
        "count": 1,
        "dtype": "float32",
        "crs": crs,
        "transform": transform,
        "nodata": float("nan"),
    }
    # Stage an ordinary GeoTIFF, then let the COG driver lay it out
    # (IFDs first, overviews and tiles ordered for range reads).
    staging = path + ".staging.tif"
    with rasterio.open(staging, "w", **profile) as dst:
        dst.write(arr, 1)
        dst.update_tags(source=source_note, vertical_datum="EGM96 orthometric meters")
    rio_copy(
        staging, path, driver="COG",
        compress="deflate", predictor=3, blocksize=COG_BLOCK,
        overview_resampling="average", BIGTIFF="NO",
        NUM_THREADS="ALL_CPUS",
    )
    os.remove(staging)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--out",
        default=os.path.normpath(os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            os.pardir, "data", "gem15_singapore",
        )),
    )
    args = ap.parse_args()
    out = args.out
    os.makedirs(out, exist_ok=True)

    from pyproj import Transformer

    print("[1/5] fetching Singapore boundary polygon (checksum-verified)...")
    geom_utm = reproject_geom(fetch_boundary(), "EPSG:4326", UTM)
    x0, y0, x1, y1 = geom_bounds(geom_utm)

    # Grow the window so every island seed (plus padding) is inside the mosaic.
    fwd = Transformer.from_crs("EPSG:4326", UTM, always_xy=True)
    pad = 250
    for _name, lon, lat, rad in ISLAND_SEEDS:
        x, y = fwd.transform(lon, lat)
        r = rad + pad
        x0, y0 = min(x0, x - r), min(y0, y - r)
        x1, y1 = max(x1, x + r), max(y1, y + r)
    bounds = (x0 - 60, y0 - 60, x1 + 60, y1 + 60)  # 60 m read padding
    print(f"  UTM48N bounds (incl. islands): {bounds}")

    print("[2/5] reading GEM-15 DTM tiles...")
    arr, transform, crs = fetch_and_merge(bounds)
    print(f"  mosaic: {arr.shape[1]} x {arr.shape[0]} px @ 15 m")
    print(f"  valid before mask: {np.isfinite(arr).sum():,}")

    print("[3/5] masking to Singapore land + outlying islands...")
    arr, report = mask_to_singapore(arr, transform, crs, geom_utm, ISLAND_SEEDS)
    valid = np.isfinite(arr)
    if not valid.any():
        raise SystemExit("Mask removed everything; check boundary/CRS.")

    # Clamp sub-floor cells rather than letting one outlier set the encoded range.
    low = valid & (arr < MIN_LAND_HEIGHT_M)
    clamped_low = int(low.sum())
    if clamped_low:
        arr = np.where(low, np.float32(MIN_LAND_HEIGHT_M), arr)
    below_zero = int((valid & (arr < 0)).sum())

    land = arr[valid]
    hmin, hmax = float(land.min()), float(land.max())
    print(
        f"  land pixels: {land.size:,} | heights {hmin:.1f} .. {hmax:.1f} m"
        f" | below 0 m: {below_zero:,} | clamped to {MIN_LAND_HEIGHT_M:.0f} m: {clamped_low:,}"
    )
    print("  island data report (valid pixels inside seed disk):")
    for name, n in report:
        print(f"    {name:20s} {'NO DATA in GEM-15' if n == 0 else f'{n} px'}")

    print("[4/5] writing Cloud-Optimised GeoTIFF...")
    cog_name = "singapore_dtm.tif"
    cog_path = os.path.join(out, cog_name)
    write_cog(
        cog_path, arr, transform, crs,
        source_note="GEM-15 dtm band, cells: " + ",".join(CELLS),
    )
    import rasterio

    # Level sizes come from the written file, so the viewer and the manifest agree.
    levels = []
    with rasterio.open(cog_path) as ds:
        block = ds.block_shapes[0][0]
        levels.append({"level": 0, "width": ds.width, "height": ds.height, "cell_m": 15.0})
        for i, f in enumerate(ds.overviews(1), start=1):
            with rasterio.open(cog_path, overview_level=i - 1) as ov:
                levels.append({"level": i, "width": ov.width, "height": ov.height,
                               "cell_m": 15.0 * f, "factor": f})

    # Valid land extent in grid cells (not the raster rectangle, which includes sea
    # corners). The viewer fits the camera to this, as the single-mesh viewer did.
    rows_v = np.where(valid.any(axis=1))[0]
    cols_v = np.where(valid.any(axis=0))[0]
    land_cells = {
        "col_min": int(cols_v[0]), "col_max": int(cols_v[-1]),
        "row_min": int(rows_v[0]), "row_max": int(rows_v[-1]),
    }

    west, south, east, north = bounds_lonlat(transform, arr.shape[1], arr.shape[0], crs)
    manifest = {
        "source": "GEM-15 (Google Near-Global Elevation Models at 15m), dtm band",
        "source_tiles": CELLS,
        "boundary_source": {"url": BOUNDARY_URL, "sha256": BOUNDARY_SHA256},
        "file": cog_name,
        "format": "Cloud-Optimised GeoTIFF, Float32, DEFLATE + predictor 3, nodata NaN",
        "sha256": sha256_file(cog_path),
        "bytes": os.path.getsize(cog_path),
        "crs": "EPSG:32648 (UTM zone 48N)",
        "vertical_datum": "EGM96 orthometric heights, meters",
        "tile_size": block,
        "levels": levels,
        "width": arr.shape[1],
        "height": arr.shape[0],
        "pixel_size_m": 15.0,
        "utm_origin": [transform.c, transform.f],
        "utm_bounds": {"east": bounds[2], "west": bounds[0], "north": bounds[3], "south": bounds[1]},
        "geographic_bounds": {"west": west, "south": south, "east": east, "north": north},
        "height_min": hmin,
        "height_max": hmax,
        "min_land_height_m": MIN_LAND_HEIGHT_M,
        "clamped_low_cells": clamped_low,
        "below_zero_cells": below_zero,
        "nodata": "NaN",
        "land_cells": land_cells,
        "islands": {name: ("no GEM-15 data" if n == 0 else n) for name, n in report},
    }
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    print("[5/5] done.")
    for fn in [cog_name, "manifest.json"]:
        print(f"  {fn:28s} {os.path.getsize(os.path.join(out, fn)) / 1e6:8.2f} MB")
    print(f"\nOutput directory: {out}")


if __name__ == "__main__":
    main()
