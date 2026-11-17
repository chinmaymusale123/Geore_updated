/**
 * spectralIndices.ts — Spectral index analytics and PNG overlay generation.
 *
 * Ports backend/spectral_indices.py using sharp for RGBA PNG encoding.
 */

import sharp from "sharp";

export interface BreakdownItem {
  name: string;
  value: number;
}

function interpolateColor(t: number, stops: [number, number, number][]): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (stops.length - 1);
  const idx = Math.min(stops.length - 2, Math.floor(scaled));
  const frac = scaled - idx;
  const c0 = stops[idx];
  const c1 = stops[idx + 1];
  return [
    Math.round(c0[0] + (c1[0] - c0[0]) * frac),
    Math.round(c0[1] + (c1[1] - c0[1]) * frac),
    Math.round(c0[2] + (c1[2] - c0[2]) * frac),
  ];
}

const RDYLGN_STOPS: [number, number, number][] = [
  [165, 0, 38],
  [215, 48, 39],
  [244, 109, 67],
  [253, 174, 97],
  [254, 224, 139],
  [255, 255, 191],
  [217, 239, 139],
  [166, 217, 106],
  [102, 189, 99],
  [26, 152, 80],
  [0, 104, 55],
];

const BLUES_STOPS: [number, number, number][] = [
  [247, 251, 255],
  [222, 235, 247],
  [198, 219, 239],
  [158, 202, 225],
  [107, 174, 214],
  [66, 146, 198],
  [33, 113, 181],
  [8, 81, 156],
  [8, 48, 107],
];

export async function generateIndexHeatmap(
  indexArray: Float32Array,
  width: number,
  height: number,
  cmapName: "RdYlGn" | "Blues" = "RdYlGn",
  vmin = -1,
  vmax = 1
): Promise<string> {
  const stops = cmapName === "Blues" ? BLUES_STOPS : RDYLGN_STOPS;
  const rgba = Buffer.alloc(width * height * 4);
  const range = vmax - vmin || 1;

  for (let i = 0; i < width * height; i++) {
    const t = (indexArray[i] - vmin) / range;
    const [r, g, b] = interpolateColor(t, stops);
    const offset = i * 4;
    rgba[offset] = r;
    rgba[offset + 1] = g;
    rgba[offset + 2] = b;
    rgba[offset + 3] = 220;
  }

  const png = await sharp(rgba, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();

  return png.toString("base64");
}

export function classifyVegetationProportions(ndviArray: Float32Array): BreakdownItem[] {
  const total = ndviArray.length || 1;
  let bare = 0;
  let sparse = 0;
  let moderate = 0;
  let dense = 0;

  for (let i = 0; i < ndviArray.length; i++) {
    const v = ndviArray[i];
    if (v < 0.1) bare++;
    else if (v < 0.3) sparse++;
    else if (v < 0.6) moderate++;
    else dense++;
  }

  return [
    { name: "Bare soil", value: (bare / total) * 100 },
    { name: "Sparse vegetation", value: (sparse / total) * 100 },
    { name: "Moderate vegetation", value: (moderate / total) * 100 },
    { name: "Dense vegetation", value: (dense / total) * 100 },
  ];
}

export function computeForestCoverTrend(
  ndviT1: Float32Array,
  ndviT2: Float32Array,
  threshold = 0.25
): BreakdownItem[] {
  const total1 = ndviT1.length || 1;
  const total2 = ndviT2.length || 1;
  let f1 = 0;
  let f2 = 0;
  for (let i = 0; i < ndviT1.length; i++) {
    if (ndviT1[i] >= threshold) f1++;
  }
  for (let i = 0; i < ndviT2.length; i++) {
    if (ndviT2[i] >= threshold) f2++;
  }

  return [
    { name: "Previous", value: (f1 / total1) * 100 },
    { name: "Current", value: (f2 / total2) * 100 },
  ];
}

export async function generateForestMaskOverlay(
  ndviArray: Float32Array,
  width: number,
  height: number,
  threshold = 0.25
): Promise<string> {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    if (ndviArray[i] >= threshold) {
      rgba[offset] = 0;
      rgba[offset + 1] = 255;
      rgba[offset + 2] = 0;
      rgba[offset + 3] = 128;
    } else {
      rgba[offset] = 0;
      rgba[offset + 1] = 0;
      rgba[offset + 2] = 0;
      rgba[offset + 3] = 0;
    }
  }

  const png = await sharp(rgba, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();

  return png.toString("base64");
}

export function detectFloodRegions(
  ndwiArray: Float32Array,
  threshold = 0.15
): { pct: number; mask: Uint8Array } {
  const total = ndwiArray.length || 1;
  const mask = new Uint8Array(total);
  let count = 0;

  for (let i = 0; i < total; i++) {
    if (ndwiArray[i] >= threshold) {
      mask[i] = 1;
      count++;
    }
  }

  return {
    pct: (count / total) * 100,
    mask,
  };
}

export function floodRegionToGeojson(
  floodMask: Uint8Array,
  width: number,
  height: number,
  bounds: [number, number][] | null
): Record<string, unknown> | null {
  if (!bounds || bounds.length === 0) return null;

  const lons = bounds.map((p) => p[0]);
  const lats = bounds.map((p) => p[1]);
  const lonMin = Math.min(...lons);
  const lonMax = Math.max(...lons);
  const latMin = Math.min(...lats);
  const latMax = Math.max(...lats);

  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const features: Record<string, unknown>[] = [];

  const dx = [1, -1, 0, 0];
  const dy = [0, 0, 1, -1];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (floodMask[start] === 1 && visited[start] === 0) {
        let head = 0;
        let tail = 0;
        queue[tail++] = start;
        visited[start] = 1;

        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;
        let area = 0;

        while (head < tail) {
          const curr = queue[head++];
          const cx = curr % width;
          const cy = (curr - cx) / width;
          area++;

          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          for (let d = 0; d < 4; d++) {
            const nx = cx + dx[d];
            const ny = cy + dy[d];
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              const nIdx = ny * width + nx;
              if (floodMask[nIdx] === 1 && visited[nIdx] === 0) {
                visited[nIdx] = 1;
                queue[tail++] = nIdx;
              }
            }
          }
        }

        if (area >= 16 && features.length < 50) {
          const fLonMin = lonMin + (minX / width) * (lonMax - lonMin);
          const fLonMax = lonMin + ((maxX + 1) / width) * (lonMax - lonMin);
          const fLatMax = latMax - (minY / height) * (latMax - latMin);
          const fLatMin = latMax - ((maxY + 1) / height) * (latMax - latMin);

          features.push({
            type: "Feature",
            properties: { area_pixels: area },
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [fLonMin, fLatMin],
                  [fLonMax, fLatMin],
                  [fLonMax, fLatMax],
                  [fLonMin, fLatMax],
                  [fLonMin, fLatMin],
                ],
              ],
            },
          });
        }
      }
    }
  }

  if (features.length === 0) return null;

  return {
    type: "FeatureCollection",
    features,
  };
}
