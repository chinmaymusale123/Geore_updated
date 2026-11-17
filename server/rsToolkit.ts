/**
 * rsToolkit.ts — Deterministic remote-sensing functions for GEORE.
 *
 * Pure TypeScript + sharp — no API calls, no LLM dependency.
 */

import sharp from "sharp";

export interface ChangeMaskResult {
  pct_changed: number;
  change_regions: [number, number, number, number][];
}

export interface FusionStatsResult {
  built_up_pct: number;
  vegetation_pct: number;
  water_pct: number;
  agreement_pct: number;
}

export interface DecodedImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
}

export async function decodeImageRgb(buffer: Buffer, width?: number, height?: number): Promise<DecodedImage> {
  let pipeline = sharp(buffer).removeAlpha().toColorspace("srgb");
  if (width && height) {
    pipeline = pipeline.resize(width, height, { fit: "fill" });
  }
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

export async function imageToJpegBase64(buffer: Buffer): Promise<string> {
  const out = await sharp(buffer).removeAlpha().jpeg({ quality: 85 }).toBuffer();
  return out.toString("base64");
}

function safeRatio(a: number, b: number): number {
  const denom = a + b;
  if (denom === 0) return 0;
  const val = (a - b) / denom;
  return Math.max(-1.0, Math.min(1.0, val));
}

export function computeNdviFromRgb(data: Uint8Array, width: number, height: number, channels: number): Float32Array {
  const total = width * height;
  const ndvi = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const idx = i * channels;
    const r = data[idx] / 255.0;
    const g = (channels > 1 ? data[idx + 1] : data[idx]) / 255.0;
    // RGB fallback: Green as NIR surrogate vs Red
    ndvi[i] = safeRatio(g, r);
  }
  return ndvi;
}

export function computeNdwiFromRgb(data: Uint8Array, width: number, height: number, channels: number): Float32Array {
  const total = width * height;
  const ndwi = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const idx = i * channels;
    const g = (channels > 1 ? data[idx + 1] : data[idx]) / 255.0;
    const b = (channels > 2 ? data[idx + 2] : data[idx]) / 255.0;
    // RGB fallback: Blue vs Green as water proxy
    ndwi[i] = safeRatio(b, g);
  }
  return ndwi;
}

export async function computeChangeMask(
  buf1: Buffer,
  buf2: Buffer,
  threshold = 0.15,
  minRegionArea = 100
): Promise<ChangeMaskResult> {
  const meta1 = await sharp(buf1).metadata();
  const meta2 = await sharp(buf2).metadata();

  const w1 = meta1.width ?? 256;
  const h1 = meta1.height ?? 256;
  const w2 = meta2.width ?? 256;
  const h2 = meta2.height ?? 256;

  const w = Math.min(w1, w2);
  const h = Math.min(h1, h2);

  const img1 = await decodeImageRgb(buf1, w, h);
  const img2 = await decodeImageRgb(buf2, w, h);

  const totalPixels = w * h;
  const mask = new Uint8Array(totalPixels);
  let changedPixels = 0;

  for (let i = 0; i < totalPixels; i++) {
    const i1 = i * img1.channels;
    const i2 = i * img2.channels;

    let sum1 = 0;
    for (let c = 0; c < img1.channels; c++) sum1 += img1.data[i1 + c];
    const g1 = sum1 / (img1.channels * 255.0);

    let sum2 = 0;
    for (let c = 0; c < img2.channels; c++) sum2 += img2.data[i2 + c];
    const g2 = sum2 / (img2.channels * 255.0);

    if (Math.abs(g1 - g2) > threshold) {
      mask[i] = 1;
      changedPixels++;
    }
  }

  const pctChanged = Math.round((changedPixels / Math.max(1, totalPixels)) * 10000) / 100;

  // 8-connected components labeling via BFS
  const visited = new Uint8Array(totalPixels);
  const changeRegions: [number, number, number, number][] = [];
  const queue = new Int32Array(totalPixels);

  const dx = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy = [-1, -1, -1, 0, 0, 1, 1, 1];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const startIdx = y * w + x;
      if (mask[startIdx] === 1 && visited[startIdx] === 0) {
        let head = 0;
        let tail = 0;
        queue[tail++] = startIdx;
        visited[startIdx] = 1;

        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;
        let area = 0;

        while (head < tail) {
          const curr = queue[head++];
          const cx = curr % w;
          const cy = (curr - cx) / w;
          area++;

          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          for (let d = 0; d < 8; d++) {
            const nx = cx + dx[d];
            const ny = cy + dy[d];
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
              const nIdx = ny * w + nx;
              if (mask[nIdx] === 1 && visited[nIdx] === 0) {
                visited[nIdx] = 1;
                queue[tail++] = nIdx;
              }
            }
          }
        }

        if (area >= minRegionArea) {
          changeRegions.push([minX, minY, maxX - minX, maxY - minY]);
        }
      }
    }
  }

  return {
    pct_changed: pctChanged,
    change_regions: changeRegions,
  };
}

export async function computeFusionStats(
  optBuf: Buffer,
  sarBuf: Buffer,
  sarHighThreshold = 0.6,
  ndviVegThreshold = 0.2,
  ndwiWaterThreshold = 0.1
): Promise<FusionStatsResult> {
  const meta1 = await sharp(optBuf).metadata();
  const meta2 = await sharp(sarBuf).metadata();

  const w = Math.min(meta1.width ?? 256, meta2.width ?? 256);
  const h = Math.min(meta1.height ?? 256, meta2.height ?? 256);

  const opt = await decodeImageRgb(optBuf, w, h);
  const sar = await decodeImageRgb(sarBuf, w, h);

  const ndvi = computeNdviFromRgb(opt.data, w, h, opt.channels);
  const ndwi = computeNdwiFromRgb(opt.data, w, h, opt.channels);

  const total = w * h;
  let sarHighCount = 0;
  let vegCount = 0;
  let waterCount = 0;
  let agreeCount = 0;

  for (let i = 0; i < total; i++) {
    const sIdx = i * sar.channels;
    let sSum = 0;
    for (let c = 0; c < sar.channels; c++) sSum += sar.data[sIdx + c];
    const sVal = sSum / (sar.channels * 255.0);

    const sarHigh = sVal > sarHighThreshold;
    const isVeg = ndvi[i] > ndviVegThreshold;
    const isWater = ndwi[i] > ndwiWaterThreshold;

    if (sarHigh) sarHighCount++;
    if (isVeg) vegCount++;
    if (isWater) waterCount++;

    const opticalBuiltUp = !isVeg && !isWater;
    const agreeBuilt = sarHigh && opticalBuiltUp;
    const agreeWater = !sarHigh && isWater;
    if (agreeBuilt || agreeWater) {
      agreeCount++;
    }
  }

  return {
    built_up_pct: Math.round((sarHighCount / total) * 10000) / 100,
    vegetation_pct: Math.round((vegCount / total) * 10000) / 100,
    water_pct: Math.round((waterCount / total) * 10000) / 100,
    agreement_pct: Math.round((agreeCount / total) * 10000) / 100,
  };
}
