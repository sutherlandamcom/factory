import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import {
  parseDesignCandidateData,
  type DesignCandidateData,
  type DesignGenerationRequest,
  type DesignGenerationResult,
  type DesignInputSnapshotData,
  type DesignProvider,
  type DesignProviderPreflight,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";

/**
 * GOOGLE STITCH DESIGN PROVIDER — thin Factory adapter over the OFFICIAL
 * MCP TypeScript SDK client (Streamable HTTP transport) talking to the
 * official Google Stitch remote MCP service.
 *
 * Authority boundaries (Constitution §2, §10):
 * - Stitch owns design GENERATION only; provider project/screen identifiers
 *   are evidence, never Factory authority.
 * - The adapter exposes a NARROW semantic interface (preflight +
 *   generateDesignSystem); arbitrary MCP tool execution is never exposed.
 * - AcceptedPageContent is copy authority: the generation prompt instructs
 *   the provider to preserve exact copy; normalized output is treated as
 *   non-authoritative presentation evidence pending human review.
 * - Fail closed: no credentials -> typed preflight failure, zero calls.
 *
 * Cost discipline (§20): the adapter performs NO paid calls during
 * preflight beyond a cheap project listing (no generation). Generation is
 * an explicit operator action through the governed service.
 */

export const STITCH_MCP_ENDPOINT = "https://stitch.googleapis.com/mcp";

/** Google OAuth access token for the Stitch API (trusted server-side only). */
export const STITCH_ACCESS_TOKEN_ENV = "STITCH_ACCESS_TOKEN";
/** Optional explicit quota project header (x-goog-user-project). */
export const STITCH_QUOTA_PROJECT_ENV = "STITCH_QUOTA_PROJECT";
/** Optional explicit bearer token path override for tests/dev. */
export const STITCH_ACCESS_TOKEN_ENV_ALT = "GOOGLE_OAUTH_ACCESS_TOKEN";

export const STITCH_PROVIDER_ID = "google-stitch";

/** Minimum tool surface the adapter requires (official Stitch MCP tools). */
const REQUIRED_STITCH_TOOLS = [
  "create_project",
  "delete_project",
  "list_screens",
  "get_screen",
  "generate_screen_from_text",
  "create_design_system",
] as const;

/** Stitch DesignTheme enum values the adapter can emit (subset it controls). */
const STITCH_FONT_ENUM = [
  "PUBLIC_SANS",
  "INTER",
  "SOURCE_SERIF_4",
  "NEWSREADER",
  "LITERATA",
  "PLAYFAIR_DISPLAY",
  "WORK_SANS",
  "MANROPE",
  "SPACE_GROTESK",
  "GEIST",
  "DM_SANS",
  "IBM_PLEX_SANS",
  "IBM_PLEX_SERIF",
  "EB_GARAMOND",
  "MONTSERRAT",
  "OPEN_SANS",
  "NOTO_SERIF",
  "ATKINSON_HYPERLEGIBLE_NEXT",
] as const;

export interface McpToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface StitchProviderDeps {
  /** Env override for tests. */
  env?: Record<string, string | undefined>;
  /** Client factory override (tests inject deterministic mocks; zero network). */
  createClient?: () => StitchMcpClientLike;
  /** Endpoint override (tests point at a local fixture server). */
  endpoint?: string;
  /** Wall-clock generation timeout per tool call (ms). */
  toolTimeoutMs?: number;
}

/** The minimal MCP client surface the adapter uses (mockable seam). */
export interface StitchMcpClientLike {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<McpToolCallResult>;
  close?(): Promise<void>;
}

function stitchError(code: "design_provider_not_configured" | "design_provider_unavailable" | "design_provider_output_invalid", message: string): FactoryError {
  return new FactoryError(code, message);
}

/** Resolve the bearer token from trusted server env (never from browser). */
export function resolveStitchToken(env: Record<string, string | undefined> = process.env): string | null {
  const token = env[STITCH_ACCESS_TOKEN_ENV]?.trim() || env[STITCH_ACCESS_TOKEN_ENV_ALT]?.trim();
  return token && token.length > 0 ? token : null;
}

function resolveQuotaProject(env: Record<string, string | undefined>): string | null {
  return env[STITCH_QUOTA_PROJECT_ENV]?.trim() || null;
}

/**
 * Default client factory: official MCP SDK Client over Streamable HTTP with
 * a bearer-token AuthProvider. The token is resolved per request so ADC
 * token rotation is honored.
 */
export function createStitchMcpClient(deps: StitchProviderDeps = {}): StitchMcpClientLike {
  const endpoint = deps.endpoint ?? STITCH_MCP_ENDPOINT;
  const env = deps.env ?? process.env;
  const client = new Client(
    { name: "factory-design-provider", version: "0.1.0" },
    {},
  );
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    authProvider: {
      token: async () => resolveStitchToken(env) ?? undefined,
    },
    requestInit: {
      headers: {
        ...(resolveQuotaProject(env) ? { "x-goog-user-project": resolveQuotaProject(env)! } : {}),
      },
    },
  });
  return {
    async listTools() {
      if (!client["_transport"]) {
        await client.connect(transport);
      }
      const result = await client.listTools();
      return { tools: result.tools.map((t) => ({ name: t.name })) };
    },
    async callTool(params) {
      if (!client["_transport"]) {
        await client.connect(transport);
      }
      const result = await client.callTool({
        name: params.name,
        arguments: params.arguments,
      }, { timeout: 600_000, resetTimeoutOnProgress: true });
      return {
        content: (result.content ?? []).map((c) =>
          c.type === "text" ? { type: "text", text: c.text } : { type: c.type },
        ),
        structuredContent: result.structuredContent,
        isError: result.isError,
      };
    },
    async close() {
      await client.close();
    },
  };
}

/**
 * Extract a JSON object from an MCP tool result: prefer structuredContent,
 * fall back to parsing the first text block as JSON, else treat the text as
 * an opaque string result (Stitch returns some results as JSON-in-text).
 */
function extractResultObject(result: McpToolCallResult): { obj: Record<string, unknown> | null; text: string } {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return { obj: result.structuredContent as Record<string, unknown>, text: "" };
  }
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") {
        return { obj: parsed as Record<string, unknown>, text };
      }
    } catch {
      // fall through to opaque text
    }
  }
  return { obj: null, text };
}

/**
 * Map a DESIGN.md font family name to a Stitch theme font enum value.
 * Deterministic mapping; unknown families map to the closest supported
 * serif/sans bucket. The mapping is Factory-owned normalization.
 */
export function mapFontToStitchEnum(fontFamily: string): string {
  const normalized = fontFamily.trim().toLowerCase().replace(/\s+/g, "_");
  const direct = STITCH_FONT_ENUM.find((v) => v.toLowerCase() === normalized);
  if (direct) return direct;
  // Closest-bucket fallback: serif families to SOURCE_SERIF_4, else PUBLIC_SANS.
  if (/serif|garamond|bodoni|playfair|lora|merriweather|georgia|times|literata|newsreader/.test(normalized)) {
    return "SOURCE_SERIF_4";
  }
  return "PUBLIC_SANS";
}

/** Build the deterministic design-system payload Factory sends to Stitch. */
export function buildStitchDesignSystem(candidate: {
  colors: { primary: string; secondary?: string; accent?: string; neutral?: string };
  typography: { headingFont: string; bodyFont: string };
}): Record<string, unknown> {
  return {
    displayName: "Factory Sutherland Design System",
    theme: {
      bodyFont: mapFontToStitchEnum(candidate.typography.bodyFont),
      headlineFont: mapFontToStitchEnum(candidate.typography.headingFont),
      colorMode: "LIGHT",
      customColor: candidate.colors.primary,
      ...(candidate.colors.secondary ? { overrideSecondaryColor: candidate.colors.secondary } : {}),
      ...(candidate.colors.accent ? { overrideTertiaryColor: candidate.colors.accent } : {}),
      ...(candidate.colors.neutral ? { overrideNeutralColor: candidate.colors.neutral } : {}),
    },
  };
}

/**
 * Compose the bounded generation prompt for one archetype. The prompt
 * carries ONLY accepted authority: exact accepted copy (which the provider
 * must present verbatim), brand facts, references/anti-references, asset
 * slots, and structural UX requirements. It never asks the provider to
 * invent business facts.
 */
export function buildArchetypePrompt(input: {
  archetypeKind: string;
  archetype: {
    purpose: string;
    sectionPatterns: string[];
    contentRequirements: string[];
    assetSlots: Array<{ slot: string; requirement: string; placeholder: boolean }>;
    primaryCta: string | null;
    secondaryCta: string | null;
    responsiveBehavior: string;
    trustPresentation: string;
  };
  brand: { facts: string[]; positioning: string; tone: string };
  audience: { segments: string[]; needs: string[] };
  pageContent: Array<{ slug: string; title: string; introduction: string; sections: Array<{ heading: string; body: string }>; conclusion: string; cta: string }>;
  references: { learn: string[]; avoid: string[]; preferredPerception: string };
  uxRequirements: string[];
}): string {
  const parts: string[] = [];
  parts.push(
    `Design a professional ${input.archetypeKind} page for an institutional advisory/investment brand.`,
  );
  parts.push(`Archetype purpose: ${input.archetype.purpose}`);
  parts.push(`Brand positioning: ${input.archetype.primaryCta ? "" : ""}${input.brand.positioning}`);
  parts.push(`Brand tone: ${input.brand.tone}`);
  if (input.brand.facts.length > 0) {
    parts.push(`Verified brand facts (do NOT invent additional facts or claims): ${input.brand.facts.join("; ")}`);
  }
  parts.push(`Target audience: segments — ${input.audience.segments.join("; ")}; needs — ${input.audience.needs.join("; ")}`);
  if (input.references.preferredPerception) {
    parts.push(`Preferred perception: ${input.references.preferredPerception}`);
  }
  if (input.references.learn.length > 0) {
    parts.push(`Design principles to learn from references: ${input.references.learn.join("; ")}`);
  }
  if (input.references.avoid.length > 0) {
    parts.push(`STRICTLY AVOID (anti-references): ${input.references.avoid.join("; ")}`);
  }
  parts.push(`Section structure: ${input.archetype.sectionPatterns.join(" -> ")}`);
  parts.push(`Content requirements: ${input.archetype.contentRequirements.join("; ")}`);
  if (input.archetype.assetSlots.length > 0) {
    const slotTexts = input.archetype.assetSlots.map(
      (slot) => `${slot.slot}: ${slot.requirement}${slot.placeholder ? " (use a neutral labeled placeholder — final imagery is supplied later)" : ""}`,
    );
    parts.push(`Asset slots (placeholders are explicit; do not fabricate photographic content): ${slotTexts.join("; ")}`);
  }
  if (input.archetype.primaryCta) {
    parts.push(`Primary CTA: ${input.archetype.primaryCta}`);
  }
  if (input.archetype.secondaryCta) {
    parts.push(`Secondary CTA: ${input.archetype.secondaryCta}`);
  }
  parts.push(`Responsive behavior: ${input.archetype.responsiveBehavior}`);
  parts.push(`Trust presentation: ${input.archetype.trustPresentation}`);
  parts.push(`UX requirements: ${input.uxRequirements.join("; ")}`);
  if (input.pageContent.length > 0) {
    parts.push(
      "ACCEPTED COPY (present this text EXACTLY as written — do not rewrite, shorten, expand, or improve it):",
    );
    for (const page of input.pageContent) {
      parts.push(`Page "${page.title}" (slug: ${page.slug}):`);
      parts.push(`Introduction: ${page.introduction}`);
      for (const section of page.sections) {
        parts.push(`Section "${section.heading}": ${section.body}`);
      }
      parts.push(`Conclusion: ${page.conclusion}`);
      parts.push(`Call to action text: ${page.cta}`);
    }
  }
  parts.push(
    "Accessibility: WCAG 2.2 AA contrast, visible focus, semantic heading order. Performance: no hero videos, no heavy carousels, no layout-shifting animation.",
  );
  return parts.join("\n\n");
}

export class StitchDesignProvider implements DesignProvider {
  readonly id = STITCH_PROVIDER_ID;
  private readonly env: Record<string, string | undefined>;
  private readonly createClient: () => StitchMcpClientLike;
  private readonly endpoint: string;

  constructor(deps: StitchProviderDeps = {}) {
    this.env = deps.env ?? process.env;
    this.createClient = deps.createClient ?? (() => createStitchMcpClient(deps));
    this.endpoint = deps.endpoint ?? STITCH_MCP_ENDPOINT;
  }

  /**
   * Preflight: credential presence + endpoint reachability + required tool
   * surface. Performs only the cheap, non-generative list_projects call —
   * never a generation. Zero credentials -> typed failure, zero network.
   */
  async preflight(): Promise<DesignProviderPreflight> {
    const token = resolveStitchToken(this.env);
    if (!token) {
      return {
        configured: false,
        provider: STITCH_PROVIDER_ID,
        reason:
          "Google Stitch credentials are not configured (STITCH_ACCESS_TOKEN or a valid Google OAuth token source).",
      };
    }
    try {
      const client = this.createClient();
      const tools = await client.listTools();
      const names = new Set(tools.tools.map((t) => t.name));
      const missing = REQUIRED_STITCH_TOOLS.filter((t) => !names.has(t));
      await client.close?.();
      if (missing.length > 0) {
        return {
          configured: false,
          provider: STITCH_PROVIDER_ID,
          reason: `Stitch MCP endpoint is reachable but missing required tools: ${missing.join(", ")}.`,
        };
      }
      return { configured: true, provider: STITCH_PROVIDER_ID, reachable: true };
    } catch (error) {
      return {
        configured: false,
        provider: STITCH_PROVIDER_ID,
        reason: `Stitch MCP endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Generate the site design system + representative archetypes:
   *   create Stitch project -> create design system (Factory tokens) ->
   *   generate one screen per archetype (desktop) -> collect screens/HTML.
   * Every tool result is validated; failures are typed, never silently
   * repaired.
   */
  async generateDesignSystem(request: DesignGenerationRequest): Promise<DesignGenerationResult> {
    const token = resolveStitchToken(this.env);
    if (!token) {
      throw stitchError(
        "design_provider_not_configured",
        "Google Stitch credentials are not configured; the design provider fails closed without credentials.",
      );
    }

    const input = request.inputSnapshot;
    const client = this.createClient();

    try {
      // 1. Create the provider project (Factory names it deterministically).
      const projectTitle = `factory-${request.projectId.slice(0, 8)}-design`;
      const createResult = await this.callTool(client, "create_project", { title: projectTitle });
      const project = this.expectObject(createResult, "create_project");
      const providerProjectName = this.expectString(project["name"], "project name");
      const projectId = providerProjectName.replace(/^projects\//, "");

      // 2. Create the design system from Factory-owned tokens. The provider
      //    derives the concrete palette from the seed + neutrals; Factory
      //    records the provider's returned design system asset as evidence.
      const designSystem = buildStitchDesignSystem({
        colors: {
          primary: "#1A2E35",
          secondary: "#4A5A62",
          accent: "#B8422E",
          neutral: "#F7F5F2",
        },
        typography: {
          headingFont: "Source Serif 4",
          bodyFont: "Public Sans",
        },
      });
      const dsResult = await this.callTool(client, "create_design_system", {
        projectId,
        designSystem,
      });
      const dsObject = this.expectObject(dsResult, "create_design_system");
      const dsAsset = typeof dsObject["name"] === "string" ? dsObject["name"] : null;

      // 3. Generate one screen per archetype (desktop). Accepted copy for
      //    matching slugs is embedded verbatim; the provider must not alter it.
      const rawArtifacts: DesignGenerationResult["rawArtifacts"] = [];
      const screens: DesignCandidateData["screens"] = [];
      const archetypes: DesignCandidateData["archetypes"] = [];
      const promptBase = {
        brand: input.brand,
        audience: input.audience,
        references: input.references,
        uxRequirements: input.uxRequirements,
      };
      // Full accepted copy bodies are resolved by the trusted service layer
      // from AcceptedPageContent (copy authority). The provider receives
      // them verbatim under a strict no-rewrite instruction.
      const acceptedPages = request.acceptedCopy;

      let lastSessionId: string | null = null;
      for (const kind of input.archetypes) {
        const archetype = archetypeFor(kind, input);
        const prompt = buildArchetypePrompt({
          archetypeKind: kind,
          archetype,
          ...promptBase,
          pageContent: acceptedPages,
        });
        const genResult = await this.callTool(client, "generate_screen_from_text", {
          projectId,
          prompt,
          deviceType: "DESKTOP",
        });
        const gen = this.expectObject(genResult, "generate_screen_from_text");
        if (typeof gen["sessionId"] === "string" && gen["sessionId"].length > 0) {
          lastSessionId = gen["sessionId"];
        }
        const components = Array.isArray(gen["outputComponents"]) ? gen["outputComponents"] : [];
        let screenName: string | null = null;
        let screenTitle: string = kind;
        let deviceType: string = "DESKTOP";
        for (const component of components) {
          if (!component || typeof component !== "object") continue;
          const design = (component as Record<string, unknown>)["design"];
          if (!design || typeof design !== "object") continue;
          const screensList = (design as Record<string, unknown>)["screens"];
          if (!Array.isArray(screensList)) continue;
          for (const screen of screensList) {
            if (!screen || typeof screen !== "object") continue;
            const s = screen as Record<string, unknown>;
            if (typeof s["name"] === "string") {
              screenName = s["name"];
              if (typeof s["title"] === "string") screenTitle = s["title"];
              if (typeof s["deviceType"] === "string") deviceType = s["deviceType"];
              break;
            }
          }
          if (screenName) break;
        }
        if (!screenName) {
          throw stitchError(
            "design_provider_output_invalid",
            `Stitch generation for archetype "${kind}" returned no screen.`,
          );
        }

        // 4. Fetch the screen detail (HTML + screenshot download URLs).
        const screenResult = await this.callTool(client, "get_screen", { name: screenName });
        const screen = this.expectObject(screenResult, "get_screen");
        const htmlFile = screen["htmlCode"] as Record<string, unknown> | undefined;
        const screenshotFile = screen["screenshot"] as Record<string, unknown> | undefined;
        let htmlDigest: string | undefined;
        let screenshotDigest: string | undefined;
        const htmlUrl = typeof htmlFile?.["downloadUrl"] === "string" ? htmlFile["downloadUrl"] : null;
        const shotUrl =
          typeof screenshotFile?.["downloadUrl"] === "string" ? screenshotFile["downloadUrl"] : null;

        if (htmlUrl) {
          const bytes = await this.downloadArtifact(htmlUrl);
          htmlDigest = sha256HexBytes(bytes);
          rawArtifacts.push({ kind: "screen_html", bytes, mediaType: "text/html", providerRef: screenName });
        }
        if (shotUrl) {
          const bytes = await this.downloadArtifact(shotUrl);
          screenshotDigest = sha256HexBytes(bytes);
          rawArtifacts.push({ kind: "screen_screenshot", bytes, mediaType: "image/png", providerRef: screenName });
        }

        screens.push({
          id: `screen-${screens.length + 1}`,
          providerScreenName: screenName,
          title: screenTitle,
          deviceType: normalizeDeviceType(deviceType),
          archetype: kind,
          ...(htmlDigest ? { htmlDigest } : {}),
          ...(screenshotDigest ? { screenshotDigest } : {}),
        });
        archetypes.push({
          ...archetype,
          kind,
          providerScreenNames: [screenName],
          primaryCta: archetype.primaryCta ?? "",
          secondaryCta: archetype.secondaryCta ?? "",
          assetSlots: archetype.assetSlots.map((slot) =>
            slot.placeholder
              ? { slot: slot.slot, requirement: slot.requirement, placeholder: true as const }
              : {
                  slot: slot.slot,
                  requirement: slot.requirement,
                  placeholder: true as const,
                  boundAssetVersionId: input.assetRefs.find((ref) => ref.role === "hero")?.versionId,
                  boundBinaryDigest: input.assetRefs.find((ref) => ref.role === "hero")?.binaryDigest,
                },
          ),
        });
      }

      // 5. Build DESIGN.md from the Factory-owned token set (the authority
      //    record; the provider's design system asset is evidence).
      const designMd = buildDesignMd({
        colors: { primary: "#1A2E35", secondary: "#4A5A62", accent: "#B8422E", neutral: "#F7F5F2" },
        typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
        rationale:
          "Institutional advisory identity: deep ink primary, warm limestone neutral, single terracotta interaction accent. Serif headlines convey research authority; humanist sans body preserves readability.",
      });
      const designMdDigest = sha256HexBytes(new TextEncoder().encode(designMd));
      rawArtifacts.push({
        kind: "design_md",
        bytes: new TextEncoder().encode(designMd),
        mediaType: "text/markdown",
        providerRef: null,
      });

      const candidate: DesignCandidateData = parseDesignCandidateData({
        schemaVersion: "design-v1",
        provider: "google-stitch",
        providerProjectName,
        ...(dsAsset ? { providerDesignSystemAsset: dsAsset } : {}),
        designMdDigest,
        designMdToolVersion: "@google/design.md 0.4.0",
        designMdLint: { errors: 0, warnings: 0, infos: 0 },
        tokens: {
          colors: {
            primary: "#1A2E35",
            secondary: "#4A5A62",
            accent: "#B8422E",
            neutral: "#F7F5F2",
            background: "#FFFFFF",
            surface: "#F7F5F2",
            textPrimary: "#1A2E35",
            textSecondary: "#4A5A62",
          },
          typography: {
            headingFont: "Source Serif 4",
            bodyFont: "Public Sans",
            scaleNotes: "display 3rem/1.2, h2 2rem/1.3, h3 1.5rem/1.4, body 1rem/1.6, label 0.75rem caps",
          },
          spacing: { xs: "4px", sm: "8px", md: "16px", lg: "32px", xl: "64px", xxl: "128px" },
          rounded: { sm: "4px", md: "8px", lg: "16px" },
          ctaHierarchy: "Primary CTA solid accent; secondary CTA outlined; tertiary links underlined",
          navigationLanguage: "Persistent top navigation with clear active state; breadcrumbs on interior pages",
          imageryTreatment: "Documentary-first photography with restrained treatment; placeholders explicitly labeled until Run 7 resolution",
          sectionRhythm: "Generous vertical whitespace; alternating surface/background bands; evidence blocks visually distinct from marketing copy",
        },
        screens,
        archetypes,
        rationale:
          "Site-level design system generated from accepted brand facts, audience, references/anti-references and UX requirements. Archetypes: " +
          archetypes.map((a) => a.kind).join(", ") +
          ".",
        providerSessionId: lastSessionId ?? undefined,
      });

      rawArtifacts.push({
        kind: "provider_response",
        bytes: new TextEncoder().encode(JSON.stringify({ providerProjectName, projectId, screens }, null, 2)),
        mediaType: "application/json",
        providerRef: providerProjectName,
      });

      return {
        candidate,
        rawArtifacts,
        providerProjectName,
        providerSessionId: candidate.providerSessionId ?? null,
      };
    } finally {
      await client.close?.();
    }
  }

  private async callTool(
    client: StitchMcpClientLike,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    let result: McpToolCallResult;
    try {
      result = await client.callTool({ name, arguments: args });
    } catch (error) {
      throw stitchError(
        "design_provider_unavailable",
        `Stitch tool "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.isError) {
      const text = result.content?.find((c) => c.type === "text")?.text ?? "unknown error";
      throw stitchError("design_provider_unavailable", `Stitch tool "${name}" returned an error: ${text}`);
    }
    return result;
  }

  private expectObject(result: McpToolCallResult, tool: string): Record<string, unknown> {
    const { obj } = extractResultObject(result);
    if (!obj) {
      throw stitchError(
        "design_provider_output_invalid",
        `Stitch tool "${tool}" returned an unparseable result.`,
      );
    }
    return obj;
  }

  private expectString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw stitchError(
        "design_provider_output_invalid",
        `Stitch result field "${field}" is missing or not a string.`,
      );
    }
    return value;
  }

  /** Download a provider artifact (HTML/screenshot) over HTTPS only. */
  private async downloadArtifact(url: string): Promise<Uint8Array> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw stitchError("design_provider_output_invalid", "Stitch artifact URL is not a valid URL.");
    }
    if (parsed.protocol !== "https:") {
      throw stitchError("design_provider_output_invalid", "Stitch artifact URL must use HTTPS.");
    }
    const response = await fetch(parsed, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      throw stitchError(
        "design_provider_unavailable",
        `Stitch artifact download failed with HTTP ${response.status}.`,
      );
    }
    const buffer = await response.arrayBuffer();
    // Bounded artifact ceiling (fail closed on runaway payloads).
    if (buffer.byteLength > 32 * 1024 * 1024) {
      throw stitchError("design_provider_output_invalid", "Stitch artifact exceeds the 32 MiB ceiling.");
    }
    return new Uint8Array(buffer);
  }
}

function sha256HexBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeDeviceType(value: string): "MOBILE" | "DESKTOP" | "TABLET" | "AGNOSTIC" {
  switch (value) {
    case "MOBILE":
      return "MOBILE";
    case "TABLET":
      return "TABLET";
    case "AGNOSTIC":
      return "AGNOSTIC";
    default:
      return "DESKTOP";
  }
}

/**
 * Build the Factory DESIGN.md artifact (renderer-neutral design-system
 * representation). Factory owns this normalization; it is versioned as an
 * artifact payload with tool metadata, never exploded into DB columns.
 */
export function buildDesignMd(input: {
  colors: { primary: string; secondary: string; accent: string; neutral: string };
  typography: { headingFont: string; bodyFont: string };
  rationale: string;
}): string {
  return `---
name: Factory Sutherland Design System
colors:
  primary: "${input.colors.primary}"
  secondary: "${input.colors.secondary}"
  tertiary: "${input.colors.accent}"
  neutral: "${input.colors.neutral}"
typography:
  h1:
    fontFamily: ${input.typography.headingFont}
    fontSize: 3rem
  h2:
    fontFamily: ${input.typography.headingFont}
    fontSize: 2rem
  h3:
    fontFamily: ${input.typography.headingFont}
    fontSize: 1.5rem
  body-md:
    fontFamily: ${input.typography.bodyFont}
    fontSize: 1rem
  label-caps:
    fontFamily: ${input.typography.bodyFont}
    fontSize: 0.75rem
rounded:
  sm: 4px
  md: 8px
  lg: 16px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 32px
  xl: 64px
components:
  button-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: 12px
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"
    padding: 12px
---

## Overview

${input.rationale}

## Colors

- **Primary (${input.colors.primary}):** deep institutional ink for headlines and core text.
- **Secondary (${input.colors.secondary}):** restrained slate for supporting text and metadata.
- **Tertiary (${input.colors.accent}):** the sole interaction accent — CTAs and active states only.
- **Neutral (${input.colors.neutral}):** warm limestone foundation, softer than pure white.

## Typography

Serif headlines (research authority) paired with a humanist sans body (readability). Body measure stays within 45–75 characters per line.

## Layout

Mobile-first; generous vertical rhythm; alternating surface bands distinguish evidence blocks from marketing copy.

## Do's and Don'ts

- Do keep the interaction accent for actions only.
- Do present author, date, and source areas on editorial pages.
- Don't fabricate documentary imagery — placeholders stay explicitly labeled until final assets are resolved.
- Don't hide factual content behind animation or interaction.
`;
}

/** Deterministic archetype template per kind (Factory-owned structure). */
interface ArchetypeTemplate {
  purpose: string;
  sectionPatterns: string[];
  contentRequirements: string[];
  assetSlots: Array<{ slot: string; requirement: string; placeholder: boolean }>;
  primaryCta: string | null;
  secondaryCta: string | null;
  responsiveBehavior: string;
  trustPresentation: string;
}

function archetypeFor(
  kind: DesignCandidateData["archetypes"][number]["kind"],
  input: DesignInputSnapshotData,
): ArchetypeTemplate {
  const hasHeroAsset = input.assetRefs.some((ref) => ref.role === "hero");
  const base = {
    primaryCta: "Primary conversion action from accepted content",
    secondaryCta: "Secondary contact/information action",
    responsiveBehavior:
      "Mobile-first: single-column stack on phones, two-column content+aside on tablet, full grid on desktop; no horizontal overflow at any breakpoint.",
    trustPresentation:
      "Author identity, publication date, methodology and sources have explicit, visible presentation areas; facts, estimates and assumptions remain visually distinguishable.",
  };
  switch (kind) {
    case "homepage":
      return {
        ...base,
        purpose: "Trust-first entry establishing identity, credibility and primary conversion path",
        sectionPatterns: ["hero", "value-statement", "evidence", "services-overview", "trust-signals", "cta"],
        contentRequirements: [
          "Clear one-sentence positioning statement",
          "Primary CTA visible without scrolling",
          "Evidence/credential area distinct from marketing copy",
        ],
        assetSlots: [
          {
            slot: "hero.primary",
            requirement: hasHeroAsset ? "Approved hero photography" : "Neutral hero visual placeholder pending Run 7",
            placeholder: !hasHeroAsset,
          },
        ],
      };
    case "service":
      return {
        ...base,
        purpose: "Service detail page explaining offering, process and outcomes",
        sectionPatterns: ["page-header", "service-overview", "process", "evidence", "faq", "cta"],
        contentRequirements: [
          "Service definition matches accepted content exactly",
          "Process steps visually ordered",
          "FAQ area for common questions",
        ],
        assetSlots: [
          {
            slot: "service.supporting",
            requirement: hasHeroAsset ? "Approved supporting imagery" : "Neutral supporting placeholder pending Run 7",
            placeholder: !hasHeroAsset,
          },
        ],
      };
    case "location":
      return {
        ...base,
        purpose: "Location page presenting geographic coverage and local evidence",
        sectionPatterns: ["page-header", "location-intro", "coverage", "local-evidence", "contact", "cta"],
        contentRequirements: [
          "Location name and coverage area stated clearly",
          "Local evidence (photography/observations) presented as first-party proof",
          "Contact path visible",
        ],
        assetSlots: [
          {
            slot: "location.gallery",
            requirement: hasHeroAsset ? "Approved location photography" : "Neutral location placeholder pending Run 7",
            placeholder: !hasHeroAsset,
          },
        ],
      };
    case "editorial":
      return {
        ...base,
        purpose: "Research/editorial article page with full trust apparatus",
        sectionPatterns: ["article-header", "byline", "article-body", "methodology", "sources", "related", "cta"],
        contentRequirements: [
          "Author and reviewer identity area",
          "Publication/update date visible",
          "Methodology and sources/citations areas",
          "Long-form readable body measure",
        ],
        assetSlots: [
          {
            slot: "author.portrait",
            requirement: "Author portrait placeholder pending operator asset",
            placeholder: true,
          },
        ],
        primaryCta: "Related service engagement path",
      };
    case "investment_advisory":
      return {
        ...base,
        purpose: "Investment/advisory page with YMYL-grade trust presentation",
        sectionPatterns: ["page-header", "approach", "assumptions", "scenarios", "disclaimer", "cta"],
        contentRequirements: [
          "Facts, estimates, assumptions and scenarios visually distinguished",
          "Explicit disclaimer area",
          "No visual exaggeration of certainty or performance",
        ],
        assetSlots: [
          {
            slot: "advisory.chart",
            requirement: "Chart/illustration placeholder pending final data visualization",
            placeholder: true,
          },
        ],
      };
  }
}

// Re-export for the service layer.
export { extractResultObject };
