/**
 * prompts.ts — Prompt templates for GEORE task types.
 *
 * Each template frames Gemini as a remote-sensing analyst.
 */

const SYSTEM_FRAMING =
  "You are GEORE, an expert remote-sensing image analyst. " +
  "You analyze satellite and aerial imagery with precision. " +
  "Base your answers only on what is visible in the provided image(s). " +
  "Be specific about spatial locations (top-left, center, etc.) and " +
  "provide quantitative observations when possible.";

function buildVqaPrompt(query: string): string {
  return `${SYSTEM_FRAMING}

The user has uploaded a satellite/aerial image and asks the following question:

**User query:** ${query}

Provide a clear, detailed answer based solely on what you observe in the image.
Structure your response with:
1. **Direct answer** to the question
2. **Key observations** supporting your answer
3. **Confidence note** — mention if anything is ambiguous or hard to determine from this view`.trim();
}

function buildGroundingPrompt(query: string): string {
  return `${SYSTEM_FRAMING}

The user wants you to locate a specific feature in this satellite/aerial image.

**User query:** ${query}

You MUST respond in the following JSON format and nothing else:

\`\`\`json
{
  "bbox": [x_min, y_min, x_max, y_max],
  "description": "One-sentence description of what was found at this location."
}
\`\`\`

Coordinate rules:
- All values are **normalized between 0.0 and 1.0** relative to image dimensions.
- \`x_min\`, \`x_max\` are horizontal (left=0, right=1).
- \`y_min\`, \`y_max\` are vertical (top=0, bottom=1).
- If the feature is not found, return: \`{"bbox": [0, 0, 0, 0], "description": "Feature not found in the image."}\``.trim();
}

function buildChangePrompt(query: string, stats: Record<string, unknown>): string {
  const pctChanged = stats.pct_changed ?? "N/A";
  const regions = Array.isArray(stats.change_regions) ? stats.change_regions : [];
  const numRegions = regions.length;
  const changeRegionsStr = JSON.stringify(regions);

  return `${SYSTEM_FRAMING}

The user has uploaded two satellite/aerial images of the same area taken at different times.
Image 1 is the **earlier/before** image. Image 2 is the **later/after** image.

A pixel-level change analysis has already been computed with the following results:
- **Percentage of area changed:** ${pctChanged}%
- **Number of change regions detected:** ${numRegions}
- **Change region bounding boxes (x, y, w, h in pixels):** ${changeRegionsStr}

**User query:** ${query}

Using both the computed statistics above AND your visual interpretation of the two images, provide:
1. **Summary** — What is the overall nature and magnitude of the change?
2. **Key changes** — Describe the 2–3 most significant changes you observe, referencing their spatial location (e.g., "in the northeastern quadrant" or "along the river").
3. **Likely cause** — What might have caused these changes? (e.g., urbanization, seasonal variation, flood damage, deforestation)
4. **Agreement check** — Do your visual observations align with the computed ${pctChanged}% change statistic? Note any discrepancies.`.trim();
}

function buildFusionPrompt(query: string, stats: Record<string, unknown>): string {
  const builtUpPct = stats.built_up_pct ?? "N/A";
  const vegetationPct = stats.vegetation_pct ?? "N/A";
  const waterPct = stats.water_pct ?? "N/A";
  const agreementPct = stats.agreement_pct ?? "N/A";

  return `${SYSTEM_FRAMING}

The user has uploaded two co-registered images of the same area:
- **Image 1:** Optical (visible/multispectral) imagery
- **Image 2:** SAR (Synthetic Aperture Radar) imagery

A cross-modal analysis has already been computed:
- **Built-up area (from SAR high-backscatter):** ${builtUpPct}%
- **Vegetation coverage (from optical NDVI):** ${vegetationPct}%
- **Water coverage (from optical NDWI):** ${waterPct}%
- **Cross-modal agreement:** ${agreementPct}%

**User query:** ${query}

Using both the computed statistics AND your visual interpretation of both images, provide:
1. **Land cover summary** — Characterize the overall land cover composition.
2. **SAR interpretation** — What does the radar imagery reveal about surface roughness, built structures, or moisture?
3. **Optical interpretation** — What does the visible imagery show about vegetation, water, and land use?
4. **Fusion insight** — What additional understanding emerges from combining both data sources that neither alone would provide?
5. **Agreement assessment** — The computed cross-modal agreement is ${agreementPct}%. Explain what this means and whether it's consistent with what you see.`.trim();
}

export function buildPrompt(
  taskType: string,
  query: string,
  toolkitOutput?: Record<string, unknown> | null
): string {
  const stats = toolkitOutput ?? {};
  switch (taskType) {
    case "vqa":
      return buildVqaPrompt(query);
    case "grounding":
      return buildGroundingPrompt(query);
    case "change":
      return buildChangePrompt(query, stats);
    case "fusion":
      return buildFusionPrompt(query, stats);
    default:
      return buildVqaPrompt(query);
  }
}
