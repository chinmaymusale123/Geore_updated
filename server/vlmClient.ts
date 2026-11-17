/**
 * vlmClient.ts — Dual-provider VLM client for GEORE.
 *
 * Primary:  Google Gemini (gemini-4-hydrogen) via @google/genai SDK
 * Fallback: NVIDIA (nemotron-nano-12b-v2-vl) via OpenAI-compatible HTTP API
 */

import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";

const DEFAULT_GEMINI_MODEL = "gemini-4-hydrogen";
const DEFAULT_NVIDIA_MODEL = "nvidia/nemotron-nano-12b-v2-vl";
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

export interface VlmResult {
  answer: string;
  provider: string;
  modelUsed: string;
}

async function toJpegBase64(buf: Buffer): Promise<string> {
  const jpeg = await sharp(buf).removeAlpha().jpeg({ quality: 88 }).toBuffer();
  return jpeg.toString("base64");
}

function getGeminiModel(): string {
  const configured = process.env.GEMINI_MODEL?.trim();
  if (!configured) return DEFAULT_GEMINI_MODEL;
  // Ensure deprecated or unsupported model aliases are mapped to gemini-4-hydrogen
  if (
    configured.includes("1.5") ||
    configured.includes("2.0") ||
    configured.includes("3.6") ||
    configured.includes("3.8")
  ) {
    return DEFAULT_GEMINI_MODEL;
  }
  return configured;
}

async function callGemini(prompt: string, imageBuffers: Buffer[]): Promise<{ text: string; model: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  const modelName = getGeminiModel();
  const imageParts = await Promise.all(
    imageBuffers.map(async (buf) => ({
      inlineData: {
        mimeType: "image/jpeg",
        data: await toJpegBase64(buf),
      },
    }))
  );

  const parts = [{ text: prompt }, ...imageParts];

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: { parts },
      });
      const text = response.text;
      if (!text) {
        throw new Error("Gemini returned an empty response.");
      }
      return { text, model: modelName };
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/503|UNAVAILABLE|429|RESOURCE_EXHAUSTED|high demand/i.test(msg) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      } else {
        break;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function callNvidia(prompt: string, imageBuffers: Buffer[]): Promise<string> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error("NVIDIA_API_KEY is not configured.");
  }

  const model = process.env.NVIDIA_MODEL?.trim() || DEFAULT_NVIDIA_MODEL;
  const contentParts: Array<Record<string, unknown>> = [];

  for (const buf of imageBuffers) {
    const b64 = await toJpegBase64(buf);
    contentParts.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${b64}`,
      },
    });
  }

  contentParts.push({
    type: "text",
    text: prompt,
  });

  const res = await fetch(NVIDIA_BASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: contentParts }],
      max_tokens: 1024,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`NVIDIA API error (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("NVIDIA API returned an empty response.");
  }
  return content;
}

export async function callVlm(prompt: string, imageBuffers: Buffer[]): Promise<VlmResult> {
  const errors: string[] = [];

  if (process.env.GEMINI_API_KEY) {
    try {
      const { text, model } = await callGemini(prompt, imageBuffers);
      return {
        answer: text,
        provider: "Gemini",
        modelUsed: model,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Gemini error: ${msg}`);
    }
  } else {
    errors.push("Gemini: GEMINI_API_KEY is not set in Settings > Secrets.");
  }

  if (process.env.NVIDIA_API_KEY) {
    try {
      const text = await callNvidia(prompt, imageBuffers);
      return {
        answer: text,
        provider: "NVIDIA (fallback)",
        modelUsed: "nvidia-fallback",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`NVIDIA error: ${msg}`);
    }
  }

  throw new Error(errors.join(" | "));
}
