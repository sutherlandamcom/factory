import sharp from "sharp";
import {
  type VisualAssetProvider,
  type VisualAssetProviderPreflight,
  type VisualProviderRequest,
  type VisualProviderResult,
} from "@factory/contracts";
import { VISUAL_DEFAULT_MODEL } from "./policy.js";

/**
 * DETERMINISTIC FIXTURE VISUAL PROVIDER (FACTORY_VISUAL_MODE=fixture).
 *
 * Produces deterministic, sharp-generated placeholder images so E2E journeys
 * exercise the full Run 7 governance pipeline at zero provider cost.
 * providerMode is durably "fixture": fixture candidates can never masquerade
 * as live provider evidence, and the service gates production acceptance on
 * an explicit fixture declaration (exact mirror of the Run 6 fixture gate).
 */

export const FIXTURE_VISUAL_PROVIDER_MODE = "fixture" as const;

export class FixtureVisualAssetProvider implements VisualAssetProvider {
  readonly id = "google-genai";
  readonly providerMode: "live" | "fixture" = FIXTURE_VISUAL_PROVIDER_MODE;

  async preflight(): Promise<VisualAssetProviderPreflight> {
    return {
      configured: true,
      provider: "google-genai",
      reachable: true,
      verifiedModels: ["fixture (deterministic local provider; no network calls)"],
    };
  }

  /** Deterministic gradient image derived from the prompt digest. */
  async generateImage(request: VisualProviderRequest): Promise<VisualProviderResult> {
    const seed = Number.parseInt(request.promptDigest.slice(0, 8), 16);
    const [w, h] = request.targetAspectRatio === "16:9" ? [1280, 720] : [960, 960];
    const bytes = await sharp({
      create: {
        width: w,
        height: h,
        channels: 3,
        background: { r: (seed * 7) % 256, g: (seed * 13) % 256, b: (seed * 29) % 256 },
      },
    })
      .png()
      .toBuffer();
    return {
      candidates: [{ bytes: new Uint8Array(bytes), mediaType: "image/png", index: 0 }],
      providerRequestRef: `fixture-${request.requestDigest.slice(0, 16)}`,
      providerUsage: { fixture: true, model: VISUAL_DEFAULT_MODEL },
    };
  }

  /** Deterministic edit: source image with a bounded brightness lift. */
  async editImage(request: VisualProviderRequest): Promise<VisualProviderResult> {
    const source = request.sourceImages[0]!;
    const bytes = await sharp(Buffer.from(source.dataBase64, "base64"))
      .modulate({ brightness: 1.05 })
      .png()
      .toBuffer();
    return {
      candidates: [{ bytes: new Uint8Array(bytes), mediaType: "image/png", index: 0 }],
      providerRequestRef: `fixture-${request.requestDigest.slice(0, 16)}`,
      providerUsage: { fixture: true, model: VISUAL_DEFAULT_MODEL, edit: true },
    };
  }
}
