// Web-Mercator helpers and the local metric frame (x = east, z = south, y = up).
import { BBOX } from './config.js';

export const lon2tx = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export const lat2ty = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
export const tx2lon = (x, z) => (x / 2 ** z) * 360 - 180;
export const ty2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
};

// Tile range covering BBOX at zoom z (inclusive).
export function tileRange(z) {
  return {
    z,
    x0: Math.floor(lon2tx(BBOX.west, z)), x1: Math.floor(lon2tx(BBOX.east, z)),
    y0: Math.floor(lat2ty(BBOX.north, z)), y1: Math.floor(lat2ty(BBOX.south, z)),
  };
}

// Frame built from the DEM tile range so the mesh edges coincide with tile edges.
export function makeFrame(range) {
  const { z, x0, x1, y0, y1 } = range;
  const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
  const latC = ty2lat(cy, z);
  const metersPerTile = (40075016.686 * Math.cos((latC * Math.PI) / 180)) / 2 ** z;
  const width = (x1 - x0 + 1) * metersPerTile;
  const depth = (y1 - y0 + 1) * metersPerTile;
  return {
    range, width, depth, metersPerTile,
    toLocal(lat, lon) {
      return { x: (lon2tx(lon, z) - cx) * metersPerTile, z: (lat2ty(lat, z) - cy) * metersPerTile };
    },
    toLatLon(x, zz) {
      return { lat: ty2lat(zz / metersPerTile + cy, z), lon: tx2lon(x / metersPerTile + cx, z) };
    },
  };
}
