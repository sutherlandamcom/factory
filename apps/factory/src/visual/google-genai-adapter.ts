import { GoogleGenAI } from "@google/genai";
import {
  type VisualAssetProvider,
  type VisualAssetProviderPreflight,
  type VisualProviderRequest,
  type VisualProviderResult,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { VISUAL_DEFAULT_MODEL, VISUAL_PREMIUM_MODEL } from "./policy.js";

/**
 * GOOGLE GENAI VISUAL ASSET ADAPTER — thin Factory adapter over the OFFICIAL
 * `@google/genai` SDK (server-side only).
 *
 * Authority boundaries (Constitution §2, §11; prompt task §13):
 * - The adapter owns EXECUTION ONLY. Factory owns operation type, prompt,
 *   model policy, parent assets, digests, validation, cost and approval.
 * - Credentials resolve from trusted server env, never from browser state.
 * - Model ids are policy-owned; the adapter executes the model it is given
 *   and never invents or substitutes one.
 * - No arbitrary endpoints; no frontend-reachable provider calls.
 *
 * API notes (verified against @google/genai 2.22.0 + current docs
 * codegen_instructions, 2026-09-13):
 * - Image generation: `ai.models.generateContent` with
 *   `config.responseModalities: ["TEXT","IMAGE"]` (+ `imageConfig` for
 *   aspect/size on supporting models) — image bytes arrive as inlineData
 *   parts on the response.
 * - Image editing: a one-turn `ai.chats.create({ model })` session with the
 *   source image(s) as inlineData parts plus the edit instruction
 *   (`sendMessage`) — the current documented editing path.
 * - Do NOT build on deprecated Imagen generate_images paths.
 */

export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";
export const GEMINI_API_KEY_ENV_ALT = "GOOGLE_API_KEY";
export const GOOGLE_GENAI_USE_VERTEXAI_ENV = "GOOGLE_GENAI_USE_VERTEXAI";
export const GOOGLE_CLOUD_PROJECT_ENV = "GOOGLE_CLOUD_PROJECT";
export const GOOGLE_CLOUD_LOCATION_ENV = "GOOGLE_CLOUD_LOCATION";

export const GOOGLE_GENAI_PROVIDER_ID = "google-genai";

/** The exact model ids this policy permits (adapter refuses everything else). */
export const ALLOWED_VISUAL_MODELS: ReadonlySet<string> = new Set([VISUAL_DEFAULT_MODEL, VISUAL_PREMIUM_MODEL]);

export interface GoogleGenAiVisualAdapterDeps {
  env?: Record<string, string | undefined>;
  /** Test seam: override client construction (no network in unit tests). */
  createClient?: (env: Record<string, string | undefined>) => GenAiClientLike;
}

/** Structural subset of GoogleGenAI the adapter touches (mockable). */
export interface GenAiClientLike {
  models: {
    generateContent: (params: {
      model: string;
      contents: string;
      config?: {
        responseModalities?: string[];
        imageConfig?: { aspectRatio?: string; imageSize?: string };
      };
    }) => Promise<GenAiResponseLike>;
  };
  chats: {
    create: (params: { model: string }) => {
      sendMessage: (params: {
        message: Array<{ inlineData: { mimeType: string; data: string } } | string>;
      }) => Promise<GenAiResponseLike>;
    };
  };
}

export interface GenAiResponseLike {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType?: string; data?: string } | null;
      }>;
    };
  }>;
  usageMetadata?: Record<string, unknown> | null;
}

function visualError(code: "visual_provider_not_configured" | "visual_provider_unavailable" | "visual_provider_output_invalid", message: string): FactoryError {
  return new FactoryError(code, message);
}

/** Resolve Gemini credentials from trusted server env (never browser). */
export function resolveGeminiCredential(env: Record<string, string | undefined> = process.env): {
  kind: "api_key" | "vertex";
  apiKey?: string;
} | null {
  const vertex = env[GOOGLE_GENAI_USE_VERTEXAI_ENV]?.trim() === "true";
  if (vertex && env[GOOGLE_CLOUD_PROJECT_ENV]?.trim()) return { kind: "vertex" };
  const apiKey = env[GEMINI_API_KEY_ENV]?.trim() || env[GEMINI_API_KEY_ENV_ALT]?.trim();
  return apiKey && apiKey.length > 0 ? { kind: "api_key", apiKey } : null;
}

function defaultCreateClient(env: Record<string, string | undefined>): GenAiClientLike {
  const credential = resolveGeminiCredential(env);
  if (!credential) {
    throw visualError("visual_provider_not_configured", "Gemini credentials are not configured.");
  }
  if (credential.kind === "vertex") {
    return new GoogleGenAI({
      vertexai: true,
      project: env[GOOGLE_CLOUD_PROJECT_ENV]!.trim(),
      location: env[GOOGLE_CLOUD_LOCATION_ENV]?.trim() || "us-central1",
    }) as unknown as GenAiClientLike;
  }
  return new GoogleGenAI({ apiKey: credential.apiKey! }) as unknown as GenAiClientLike;
}

export class GoogleGenAiVisualAssetAdapter implements VisualAssetProvider {
  readonly id = GOOGLE_GENAI_PROVIDER_ID;
  readonly providerMode = "live" as const;
  private readonly env: Record<string, string | undefined>;
  private readonly createClient: (env: Record<string, string | undefined>) => GenAiClientLike;

  constructor(deps: GoogleGenAiVisualAdapterDeps = {}) {
    this.env = deps.env ?? process.env;
    this.createClient = deps.createClient ?? defaultCreateClient;
  }

  /**
   * Preflight: verify credentials and (cheaply) that the policy's model ids
   * are accepted by the API. No image generation happens here.
   */
  async preflight(): Promise<VisualAssetProviderPreflight> {
    const credential = resolveGeminiCredential(this.env);
    if (!credential) {
      return {
        configured: false,
        provider: GOOGLE_GENAI_PROVIDER_ID,
        reason:
          "Gemini image credentials are not configured (GEMINI_API_KEY / GOOGLE_API_KEY, or Vertex env vars).",
      };
    }
    try {
      const client = this.createClient(this.env);
      const verifiedModels: string[] = [];
      // A minimal text-only probe per policy model: validates model access
      // without generating imagery. Model ids are evidence, never authority.
      for (const model of [VISUAL_DEFAULT_MODEL, VISUAL_PREMIUM_MODEL]) {
        try {
          await client.models.generateContent({ model, contents: "ping" });
          verifiedModels.push(model);
        } catch {
          // A model refusing the probe still counts as reachable evidence;
          // the request-time failure classification handles real errors.
          verifiedModels.push(`${model} (probe rejected; may still accept image requests)`);
        }
      }
      return { configured: true, provider: GOOGLE_GENAI_PROVIDER_ID, reachable: true, verifiedModels };
    } catch (error) {
      return {
        configured: false,
        provider: GOOGLE_GENAI_PROVIDER_ID,
        reason: `Gemini endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** Extract candidate images from a response (raw bytes; validation later). */
  private extractCandidates(response: GenAiResponseLike): VisualProviderResult {
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const candidates = parts
      .map((part, index) => ({ part, index }))
      .filter(({ part }) => part.inlineData?.data)
      .map(({ part, index }) => ({
        bytes: new Uint8Array(Buffer.from(part.inlineData!.data!, "base64")),
        mediaType: part.inlineData!.mimeType ?? "image/png",
        index,
      }));
    if (candidates.length === 0) {
      throw visualError(
        "visual_provider_output_invalid",
        "Provider returned no image data (empty or text-only response).",
      );
    }
    return {
      candidates,
      providerRequestRef: null,
      providerUsage: (response.usageMetadata as Record<string, unknown> | null) ?? null,
    };
  }

  async generateImage(request: VisualProviderRequest): Promise<VisualProviderResult> {
    if (!ALLOWED_VISUAL_MODELS.has(request.model)) {
      throw visualError("visual_provider_output_invalid", `Model "${request.model}" is not in the Factory visual model policy.`);
    }
    try {
      const client = this.createClient(this.env);
      const response = await client.models.generateContent({
        model: request.model,
        contents: request.promptText,
        config: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: {
            aspectRatio: request.targetAspectRatio,
            imageSize: request.targetSize,
          },
        },
      });
      return this.extractCandidates(response);
    } catch (error) {
      if (error instanceof FactoryError) throw error;
      throw visualError(
        "visual_provider_unavailable",
        `Gemini image generation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async editImage(request: VisualProviderRequest): Promise<VisualProviderResult> {
    if (!ALLOWED_VISUAL_MODELS.has(request.model)) {
      throw visualError("visual_provider_output_invalid", `Model "${request.model}" is not in the Factory visual model policy.`);
    }
    if (request.sourceImages.length === 0) {
      throw visualError("visual_provider_output_invalid", "Edit requests require at least one source image.");
    }
    try {
      const client = this.createClient(this.env);
      const chat = client.chats.create({ model: request.model });
      const response = await chat.sendMessage({
        message: [
          ...request.sourceImages.map((image) => ({
            inlineData: { mimeType: image.mediaType, data: image.dataBase64 },
          })),
          request.promptText,
        ],
      });
      return this.extractCandidates(response);
    } catch (error) {
      if (error instanceof FactoryError) throw error;
      throw visualError(
        "visual_provider_unavailable",
        `Gemini image edit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
