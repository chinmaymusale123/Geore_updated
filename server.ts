import "dotenv/config";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Request, Response } from "express";
import multer from "multer";

import { classifyQuery } from "./server/router.ts";
import { buildPrompt } from "./server/prompts.ts";
import { REGIONS } from "./server/regionConfig.ts";
import {
  computeChangeMask,
  computeFusionStats,
  computeNdviFromRgb,
  computeNdwiFromRgb,
  decodeImageRgb,
  imageToJpegBase64,
} from "./server/rsToolkit.ts";
import {
  classifyVegetationProportions,
  computeForestCoverTrend,
  detectFloodRegions,
  floodRegionToGeojson,
  generateForestMaskOverlay,
  generateIndexHeatmap,
} from "./server/spectralIndices.ts";
import { fetchSatelliteImage, getCoordinates } from "./server/geeFetcher.ts";
import { callVlm } from "./server/vlmClient.ts";
import { generateReportPdf } from "./server/reportGenerator.ts";
import type { SessionRecord } from "./server/reportGenerator.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const HOST = "0.0.0.0";

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const sessions = new Map<string, SessionRecord>();

function saveSession(sessionId: string, record: SessionRecord) {
  sessions.set(sessionId, record);
  if (sessions.size > 100) {
    const oldestKey = sessions.keys().next().value;
    if (oldestKey) {
      sessions.delete(oldestKey);
    }
  }
}

function parseGroundingJson(text: string): { bbox: number[]; description?: string } | null {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}") + 1;
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(text.slice(start, end)) as {
        bbox?: unknown;
        description?: string;
      };
      if (
        Array.isArray(parsed.bbox) &&
        parsed.bbox.length === 4 &&
        parsed.bbox.every((v) => typeof v === "number" && Number.isFinite(v))
      ) {
        let bbox = parsed.bbox as number[];
        if (Math.max(...bbox) > 1.0) {
          bbox = bbox.map((v) => Math.round((v / 1000.0) * 10000) / 10000);
        }
        return { ...parsed, bbox };
      }
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function computeConfidence(
  taskType: string,
  toolkitOutput: Record<string, unknown> | null,
  answer: string
): string {
  const answerLower = (answer || "").toLowerCase();
  if (taskType === "change") {
    const pct = Number(toolkitOutput?.pct_changed ?? 0);
    if (
      pct > 5 &&
      ["significant", "substantial", "major", "large", "considerable", "extensive"].some((w) =>
        answerLower.includes(w)
      )
    ) {
      return "high";
    }
    if (
      pct <= 5 &&
      ["minor", "minimal", "slight", "little", "no significant", "negligible"].some((w) =>
        answerLower.includes(w)
      )
    ) {
      return "high";
    }
    return "moderate";
  }

  if (taskType === "fusion") {
    const agreement = Number(toolkitOutput?.agreement_pct ?? 0);
    return agreement > 50 ? "high" : "moderate";
  }

  if (taskType === "grounding") {
    const parsed = parseGroundingJson(answer);
    if (parsed && JSON.stringify(parsed.bbox) !== JSON.stringify([0, 0, 0, 0])) {
      return "high";
    }
    return "moderate";
  }

  return answer.length > 100 ? "high" : "moderate";
}

// ── API Routes ────────────────────────────────────────────────────────────────

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get("/api/regions", (_req: Request, res: Response) => {
  const list = Object.entries(REGIONS).map(([id, r]) => ({
    id,
    name: r.name,
    lat: r.lat,
    lon: r.lon,
  }));
  res.json(list);
});

app.post(
  "/api/analyze",
  upload.fields([
    { name: "image1", maxCount: 1 },
    { name: "image2", maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        query?: string;
        has_sar?: string | boolean;
        location?: string;
      };
      const query = (body.query || "").trim();
      if (!query) {
        return res.status(400).json({ error: "Query is required." });
      }

      const hasSar = body.has_sar === true || body.has_sar === "true";
      const location = (body.location || "").trim();

      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const file1 = files?.image1?.[0];
      const file2 = files?.image2?.[0];

      let sourceType = "user_upload";
      let fetchedCoords: { lat: number; lon: number } | null = null;
      let fetchDate: string | null = null;
      let bounds: [number, number][] | null = null;

      const images: Buffer[] = [];

      if (location) {
        sourceType = "gee_live_fetch";
        const coords = await getCoordinates(location);
        if (!coords) {
          return res.status(400).json({
            error: `Could not find coordinates for '${location}'. Please try a nearby city or standard spelling (e.g. 'Tirupati' or 'Kathmandu').`,
          });
        }
        fetchedCoords = coords;
        fetchDate = new Date().toISOString().slice(0, 10);

        const qLower = query.toLowerCase();
        if (qLower.includes("change") || qLower.includes("trend") || qLower.includes("deforestation")) {
          const before = await fetchSatelliteImage(coords.lat, coords.lon, "before");
          const after = await fetchSatelliteImage(coords.lat, coords.lon, "optical");
          bounds = after.bounds;
          images.push(before.buffer, after.buffer);
        } else if (hasSar) {
          const opt = await fetchSatelliteImage(coords.lat, coords.lon, "optical");
          const sar = await fetchSatelliteImage(coords.lat, coords.lon, "sar");
          bounds = opt.bounds;
          images.push(opt.buffer, sar.buffer);
        } else {
          const opt = await fetchSatelliteImage(coords.lat, coords.lon, "optical");
          bounds = opt.bounds;
          images.push(opt.buffer);
        }
      } else {
        if (!file1 || !file1.buffer || file1.buffer.length === 0) {
          return res.status(400).json({ error: "Must provide either image1 or location." });
        }
        images.push(file1.buffer);
        if (file2 && file2.buffer && file2.buffer.length > 0) {
          images.push(file2.buffer);
        }
      }

      const img1 = images[0];
      const img2 = images.length > 1 ? images[1] : null;

      // Step 1: Route the query
      const taskType = classifyQuery(query, images.length, hasSar);

      // Step 2: Run deterministic remote-sensing toolkit when applicable
      let toolkitOutput: Record<string, unknown> | null = null;
      let toolCalled: string | null = null;

      if (taskType === "change" && img2) {
        const changeRes = await computeChangeMask(img1, img2);
        toolkitOutput = {
          pct_changed: changeRes.pct_changed,
          change_regions: changeRes.change_regions,
        };
        toolCalled = "compute_change_mask";
      } else if (taskType === "fusion" && img2) {
        const fusionRes = await computeFusionStats(img1, img2);
        toolkitOutput = { ...fusionRes };
        toolCalled = "compute_fusion_stats";
      }

      // Feature 2: Spectral analytics & overlays for live-fetched regions
      let heatmapBase64: string | null = null;
      let vegBreakdown: Array<{ name: string; value: number }> | null = null;
      let forestTrend: Array<{ name: string; value: number }> | null = null;
      let forestMask: string | null = null;
      let floodPct: number | null = null;
      let floodGeojson: Record<string, unknown> | null = null;

      if (sourceType === "gee_live_fetch") {
        const qLower = query.toLowerCase();
        const isAg = ["crop", "vegetation", "agriculture", "farmland", "farm"].some((w) =>
          qLower.includes(w)
        );
        const isForest = ["deforestation", "forest"].some((w) => qLower.includes(w));
        const isFlood = ["flood", "waterlogged", "inundation"].some((w) => qLower.includes(w));

        const decoded1 = await decodeImageRgb(img1);

        if (isAg) {
          const ndvi = computeNdviFromRgb(decoded1.data, decoded1.width, decoded1.height, decoded1.channels);
          heatmapBase64 = await generateIndexHeatmap(ndvi, decoded1.width, decoded1.height, "RdYlGn", -1, 1);
          vegBreakdown = classifyVegetationProportions(ndvi);
        } else if (isForest && img2) {
          const decoded2 = await decodeImageRgb(img2, decoded1.width, decoded1.height);
          const ndvi1 = computeNdviFromRgb(decoded1.data, decoded1.width, decoded1.height, decoded1.channels);
          const ndvi2 = computeNdviFromRgb(decoded2.data, decoded2.width, decoded2.height, decoded2.channels);
          forestTrend = computeForestCoverTrend(ndvi1, ndvi2);
          forestMask = await generateForestMaskOverlay(ndvi2, decoded2.width, decoded2.height);
        } else if (isFlood) {
          const ndwi = computeNdwiFromRgb(decoded1.data, decoded1.width, decoded1.height, decoded1.channels);
          heatmapBase64 = await generateIndexHeatmap(ndwi, decoded1.width, decoded1.height, "Blues", -1, 1);
          const floodRes = detectFloodRegions(ndwi);
          floodPct = floodRes.pct;
          if (bounds) {
            floodGeojson = floodRegionToGeojson(floodRes.mask, decoded1.width, decoded1.height, bounds);
          }
        } else {
          const ndvi = computeNdviFromRgb(decoded1.data, decoded1.width, decoded1.height, decoded1.channels);
          heatmapBase64 = await generateIndexHeatmap(ndvi, decoded1.width, decoded1.height, "RdYlGn", -1, 1);
        }
      }

      // Step 3: Build prompt and call VLM
      const prompt = buildPrompt(taskType, query, toolkitOutput);
      const startTime = Date.now();
      const vlmResult = await callVlm(prompt, images);
      const elapsed = Math.round(((Date.now() - startTime) / 1000) * 100) / 100;

      // Step 4: Compute confidence
      const confidence = computeConfidence(taskType, toolkitOutput, vlmResult.answer);

      // Step 5: Extract bbox for grounding
      let bbox: number[] | null = null;
      if (taskType === "grounding") {
        const parsed = parseGroundingJson(vlmResult.answer);
        if (parsed && JSON.stringify(parsed.bbox) !== JSON.stringify([0, 0, 0, 0])) {
          bbox = parsed.bbox;
        }
      }

      const responsePayload: Record<string, unknown> = {
        answer: vlmResult.answer,
        task: taskType,
        bbox,
        confidence,
        execution_trace: {
          task: taskType,
          tool_called: toolCalled,
          tool_output: toolkitOutput,
          model_used: vlmResult.modelUsed,
          provider: vlmResult.provider,
          response_time_seconds: elapsed,
        },
        source: sourceType,
        query,
        image1_base64: await imageToJpegBase64(img1),
      };

      if (img2) {
        responsePayload.image2_base64 = await imageToJpegBase64(img2);
      }
      if (fetchedCoords) responsePayload.fetched_coordinates = fetchedCoords;
      if (fetchDate) responsePayload.fetch_date = fetchDate;
      if (heatmapBase64) responsePayload.heatmap_overlay_base64 = heatmapBase64;
      if (vegBreakdown) responsePayload.vegetation_breakdown = vegBreakdown;
      if (forestTrend) responsePayload.forest_cover_trend = forestTrend;
      if (forestMask) responsePayload.forest_highlight_overlay_base64 = forestMask;
      if (floodPct !== null) responsePayload.flooded_area_pct = floodPct;
      if (floodGeojson) responsePayload.flood_geojson = floodGeojson;

      const sessionId = crypto.randomUUID();
      responsePayload.session_id = sessionId;

      saveSession(sessionId, {
        response: responsePayload,
        image1Buffer: img1,
      });

      return res.json(responsePayload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Analysis failed";
      const status = msg.includes("not set") || msg.includes("not configured") ? 503 : 500;
      return res.status(status).json({ error: msg });
    }
  }
);

app.get("/api/generate_report/:sessionId", async (req: Request, res: Response) => {
  const sessionId = String(req.params.sessionId || "");
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found or expired" });
  }

  try {
    const pdfBuffer = await generateReportPdf(session);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="SatQuery_Report.pdf"');
    return res.send(pdfBuffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to generate report";
    return res.status(500).json({ error: msg });
  }
});

// ── Vite / Static Serving ─────────────────────────────────────────────────────

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.use((_req: Request, res: Response) => {
      res.sendFile(path.resolve(distDir, "index.html"));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`GEORE server running at http://${HOST}:${PORT}`);
  });
}

startServer();
