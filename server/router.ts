/**
 * router.ts — Rule-based query classifier for GEORE.
 *
 * Deterministic, zero-latency routing. No LLM calls.
 * Priority order: change > fusion > grounding > vqa (default).
 */

export type TaskType = "change" | "fusion" | "grounding" | "vqa";

const TEMPORAL_KEYWORDS: string[] = [
  "change", "changed", "changes", "changing",
  "between", "before", "after", "before/after",
  "compare", "compared", "comparison",
  "differ", "different", "difference", "differences",
  "evolve", "evolved", "evolution",
  "transform", "transformed", "transformation",
  "over time", "temporal", "progress", "progression",
  "develop", "developed", "development",
  "growth", "grown", "expand", "expanded",
  "deforestation", "urbanization", "erosion",
  "flood", "flooded", "flooding",
  "pre-", "post-",
];

const GROUNDING_PHRASES: string[] = [
  "highlight",
  "locate",
  "where is",
  "where are",
  "show me the",
  "show me where",
  "find the",
  "find all",
  "point out",
  "identify the location",
  "mark the",
  "outline the",
  "bounding box",
  "bbox",
  "detect the",
  "spot the",
  "pinpoint",
];

export function classifyQuery(query: string, numImages: number, hasSar: boolean): TaskType {
  const q = query.toLowerCase().trim();

  // Priority 1: Change detection (2 images + temporal language)
  if (numImages === 2) {
    for (const keyword of TEMPORAL_KEYWORDS) {
      if (q.includes(keyword)) {
        return "change";
      }
    }
  }

  // Priority 2: Fusion (2 images + SAR flag)
  if (numImages === 2 && hasSar) {
    return "fusion";
  }

  // Priority 3: Grounding (spatial phrases)
  for (const phrase of GROUNDING_PHRASES) {
    if (q.includes(phrase)) {
      return "grounding";
    }
  }

  // Priority 4: Default VQA
  return "vqa";
}
