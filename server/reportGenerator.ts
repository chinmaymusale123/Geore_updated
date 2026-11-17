/**
 * reportGenerator.ts — PDF report generator for GEORE using pdfkit.
 */

import PDFDocument from "pdfkit";
import sharp from "sharp";

export interface SessionRecord {
  response: Record<string, unknown>;
  image1Buffer?: Buffer;
}

export async function generateReportPdf(session: SessionRecord): Promise<Buffer> {
  const result = session.response;

  // Pre-convert any base64 overlays to PNG buffers safely before starting PDF stream
  let primaryPng: Buffer | null = null;
  if (session.image1Buffer) {
    try {
      primaryPng = await sharp(session.image1Buffer).png().toBuffer();
    } catch {
      primaryPng = null;
    }
  }

  let heatmapPng: Buffer | null = null;
  if (typeof result.heatmap_overlay_base64 === "string") {
    try {
      heatmapPng = Buffer.from(result.heatmap_overlay_base64, "base64");
    } catch {
      heatmapPng = null;
    }
  }

  let forestPng: Buffer | null = null;
  if (typeof result.forest_highlight_overlay_base64 === "string") {
    try {
      forestPng = Buffer.from(result.forest_highlight_overlay_base64, "base64");
    } catch {
      forestPng = null;
    }
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "LETTER" });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    let source = result.source === "gee_live_fetch" ? "GEE Live Fetch" : "User Upload";
    if (typeof result.fetch_date === "string") {
      source += ` (Image Date: ${result.fetch_date})`;
    }
    const coords = result.fetched_coordinates as { lat?: number; lon?: number } | undefined;
    if (coords && typeof coords.lat === "number" && typeof coords.lon === "number") {
      source += ` | Lat: ${coords.lat.toFixed(4)}, Lon: ${coords.lon.toFixed(4)}`;
    }

    // Header
    doc.fontSize(18).fillColor("#1A237E").text("GEORE — Remote Sensing Analysis Report");
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#333333").text(`Generated: ${timestamp}`);
    doc.text(`Source: ${source}`);
    doc.moveDown(1);

    // Query
    doc.fontSize(13).fillColor("#283593").text("Query");
    doc.moveDown(0.3);
    doc.fontSize(11).fillColor("#111111").text(String(result.query ?? "N/A"));
    doc.moveDown(1);

    // Visual Evidence
    doc.fontSize(13).fillColor("#283593").text("Visual Evidence");
    doc.moveDown(0.4);
    if (primaryPng) {
      doc.image(primaryPng, { fit: [420, 260] });
      doc.moveDown(0.8);
    }
    if (heatmapPng) {
      doc.fontSize(10).fillColor("#333333").text("Heatmap Overlay:");
      doc.image(heatmapPng, { fit: [320, 200] });
      doc.moveDown(0.8);
    }
    if (forestPng) {
      doc.fontSize(10).fillColor("#333333").text("Forest Cover Mask:");
      doc.image(forestPng, { fit: [320, 200] });
      doc.moveDown(0.8);
    }

    doc.addPage();

    // Analysis Result
    doc.fontSize(13).fillColor("#283593").text("Analysis Result");
    doc.moveDown(0.4);
    doc.fontSize(11).fillColor("#111111").text(String(result.answer ?? ""), { lineGap: 3 });
    doc.moveDown(0.6);

    if (typeof result.confidence === "string") {
      doc.fontSize(11).fillColor("#222222").text(`Confidence: ${result.confidence}`);
      doc.moveDown(0.8);
    }

    // Supporting Analytics
    const vegBreakdown = result.vegetation_breakdown as Array<{ name: string; value: number }> | undefined;
    const forestTrend = result.forest_cover_trend as Array<{ name: string; value: number }> | undefined;
    const floodedPct = result.flooded_area_pct as number | undefined;

    if (vegBreakdown || forestTrend || floodedPct !== undefined) {
      doc.fontSize(13).fillColor("#283593").text("Supporting Analytics");
      doc.moveDown(0.4);
      doc.fontSize(10).fillColor("#222222");

      if (vegBreakdown) {
        doc.text("Vegetation Breakdown:");
        for (const item of vegBreakdown) {
          doc.text(`  - ${item.name}: ${item.value.toFixed(1)}%`);
        }
        doc.moveDown(0.4);
      }

      if (forestTrend) {
        doc.text("Forest Cover Trend:");
        for (const item of forestTrend) {
          doc.text(`  - ${item.name}: ${item.value.toFixed(1)}%`);
        }
        doc.moveDown(0.4);
      }

      if (typeof floodedPct === "number") {
        doc.text(`Flooded Area Detected: ${floodedPct.toFixed(2)}% of the region.`);
        doc.moveDown(0.4);
      }
    }

    // Execution Trace
    doc.moveDown(0.5);
    doc.fontSize(13).fillColor("#283593").text("Execution Trace");
    doc.moveDown(0.4);
    const trace = (result.execution_trace ?? {}) as Record<string, unknown>;
    doc.fontSize(9).fillColor("#444444");
    doc.text(`Task: ${String(trace.task ?? "N/A")}`);
    doc.text(`Model Used: ${String(trace.model_used ?? "N/A")}`);
    doc.text(`Provider: ${String(trace.provider ?? "N/A")}`);
    doc.text(`Response Time: ${String(trace.response_time_seconds ?? "N/A")} seconds`);
    if (trace.tool_called) {
      doc.text(`Tool Called: ${String(trace.tool_called)}`);
    }

    doc.moveDown(2);
    doc
      .fontSize(8)
      .fillColor("#777777")
      .text("Generated automatically by GEORE. For official verification, cross-check with authoritative sources.", {
        align: "center",
      });

    doc.end();
  });
}
