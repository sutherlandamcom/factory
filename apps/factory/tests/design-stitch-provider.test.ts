import assert from "node:assert/strict";
import test from "node:test";
import type { DesignGenerationRequest } from "@factory/contracts";
import {
  StitchDesignProvider,
  createStitchMcpClient,
  resolveStitchToken,
  STITCH_MCP_ENDPOINT,
  type StitchMcpClientLike,
  type McpToolCallResult,
} from "../src/design/stitch-provider.js";
import { parseDesignInputSnapshotData, type DesignInputSnapshotData } from "@factory/contracts";

/**
 * Stitch provider adapter tests — deterministic MCP mocks/fixtures only.
 * No network, no paid calls, no credentials required.
 */

function validInputSnapshot(): DesignInputSnapshotData {
  return parseDesignInputSnapshotData({
    schemaVersion: "design-v1",
    acceptedInputSnapshotId: "pis-test-1",
    acceptedInputSnapshotVersion: 1,
    acceptedInputDigest: "a".repeat(64),
    brand: {
      facts: ["Family-owned roofing firm"],
      positioning: "High-altitude roofing expertise",
      tone: "Plain-spoken expert",
      visualIdentityNotes: "",
    },
    audience: { segments: ["Property owners"], needs: ["Durable roofs"], decisionContext: "" },
    references: {
      referenceUrls: [],
      antiReferenceUrls: [],
      learn: [],
      avoid: ["Generic template look"],
      preferredPerception: "",
    },
    uxRequirements: ["Mobile-first responsive layout"],
    contentRefs: [],
    assetRefs: [],
    representativePages: [
      { archetype: "homepage", slug: "home", contentDigest: "b".repeat(64) },
    ],
    archetypes: ["homepage", "service"],
  });
}

class MockStitchClient implements StitchMcpClientLike {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private toolSequence: Array<Record<string, unknown>> = [];

  /** Queue structured results per tool call, in order. */
  queue(result: Record<string, unknown>): void {
    this.toolSequence.push(result);
  }

  async listTools(): Promise<{ tools: Array<{ name: string }> }> {
    return {
      tools: [
        { name: "create_project" },
        { name: "delete_project" },
        { name: "list_screens" },
        { name: "get_screen" },
        { name: "generate_screen_from_text" },
        { name: "create_design_system" },
      ],
    };
  }

  async callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<McpToolCallResult> {
    this.calls.push({ name: params.name, args: params.arguments });
    const next = this.toolSequence.shift();
    if (next === undefined) {
      throw new Error(`MockStitchClient: unexpected tool call ${params.name} (queue exhausted)`);
    }
    if (next["__error"] === true) {
      return {
        content: [{ type: "text", text: String(next["__message"] ?? "mock error") }],
        isError: true,
      };
    }
    return { structuredContent: next };
  }

  async close(): Promise<void> {
    /* no-op */
  }
}

function screenResult(screenName: string): Record<string, unknown> {
  return {
    name: screenName,
    title: "Fixture Screen",
    deviceType: "DESKTOP",
    htmlCode: { name: `${screenName}/html`, mimeType: "text/html", downloadUrl: null },
    screenshot: { name: `${screenName}/shot`, mimeType: "image/png", downloadUrl: null },
  };
}

function generationRequest(): DesignGenerationRequest {
  return {
    inputSnapshot: validInputSnapshot(),
    inputSnapshotId: "dsi-test",
    projectId: "proj-test",
    acceptedCopyByArchetype: {
      homepage: {
        slug: "home",
        title: "Home",
        introduction: "EXACT HOME INTRO",
        sections: [{ heading: "Process", body: "EXACT HOME BODY" }],
        conclusion: "EXACT HOME CONCLUSION",
        cta: "EXACT HOME CTA",
      },
      service: {
        slug: "services/roof-repair",
        title: "Roof Repair",
        introduction: "EXACT SERVICE INTRO",
        sections: [{ heading: "Process", body: "EXACT SERVICE BODY" }],
        conclusion: "EXACT SERVICE CONCLUSION",
        cta: "EXACT SERVICE CTA",
      },
    },
    designSeed: {
      colors: { primary: "#1A2E35", secondary: "#4A5A62", accent: "#B8422E", neutral: "#F7F5F2" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "" },
      rationale: "Institutional advisory identity.",
    },
  };
}

test("preflight: missing credentials fail closed with zero network", async () => {
  const provider = new StitchDesignProvider({
    env: {},
    createClient: () => {
      throw new Error("client must never be constructed without credentials");
    },
  });
  const result = await provider.preflight();
  assert.equal(result.configured, false);
  assert.match(result.reason, /credentials are not configured/);
});

test("preflight: configured + reachable with required tool surface", async () => {
  const mock = new MockStitchClient();
  const provider = new StitchDesignProvider({
    env: { STITCH_ACCESS_TOKEN: "test-token" },
    createClient: () => mock,
  });
  const result = await provider.preflight();
  assert.equal(result.configured, true);
  if (result.configured) assert.equal(result.reachable, true);
  assert.equal(mock.calls.length, 0, "preflight must not make paid generation calls");
});

test("preflight: missing required tools fails closed", async () => {
  const mock = new MockStitchClient();
  // Override listTools to drop one required tool.
  mock.listTools = async () => ({
    tools: [
      { name: "create_project" },
      { name: "list_screens" },
      { name: "get_screen" },
      { name: "generate_screen_from_text" },
      { name: "create_design_system" },
    ],
  });
  const provider = new StitchDesignProvider({
    env: { STITCH_ACCESS_TOKEN: "test-token" },
    createClient: () => mock,
  });
  const result = await provider.preflight();
  assert.equal(result.configured, false);
  assert.match(result.reason, /missing required tools: delete_project/);
});

test("generation: happy path creates project, design system, and one screen per archetype", async () => {
  const mock = new MockStitchClient();
  mock.queue({ name: "projects/123", title: "factory-proj-tes-design" }); // create_project
  mock.queue({ name: "assets/456" }); // create_design_system
  mock.queue({
    outputComponents: [
      { design: { screens: [{ name: "projects/123/screens/home", title: "Home", deviceType: "DESKTOP" }] } },
    ],
    sessionId: "sess-1",
  }); // generate homepage (desktop)
  mock.queue(screenResult("projects/123/screens/home")); // get_screen home
  mock.queue({
    outputComponents: [
      { design: { screens: [{ name: "projects/123/screens/home-mobile", title: "Home mobile", deviceType: "MOBILE" }] } },
    ],
    sessionId: "sess-1m",
  }); // generate homepage (mobile)
  mock.queue(screenResult("projects/123/screens/home-mobile")); // get_screen home-mobile
  mock.queue({
    outputComponents: [
      { design: { screens: [{ name: "projects/123/screens/service", title: "Service", deviceType: "DESKTOP" }] } },
    ],
    sessionId: "sess-2",
  }); // generate service
  mock.queue(screenResult("projects/123/screens/service")); // get_screen service

  const provider = new StitchDesignProvider({
    env: { STITCH_ACCESS_TOKEN: "test-token" },
    createClient: () => mock,
  });
  const result = await provider.generateDesignSystem(generationRequest());

  // Correct tools called in order (homepage desktop + homepage mobile +
  // service desktop, each followed by get_screen).
  assert.deepEqual(
    mock.calls.map((c) => c.name),
    [
      "create_project",
      "create_design_system",
      "generate_screen_from_text",
      "get_screen",
      "generate_screen_from_text",
      "get_screen",
      "generate_screen_from_text",
      "get_screen",
    ],
  );
  // The homepage prompt embeds authority-binding instructions and ONLY the
  // homepage representative page's accepted copy (page-exact routing).
  const homePrompt = String(mock.calls[2]!.args["prompt"]);
  assert.ok(homePrompt.includes("do not rewrite, shorten, expand, or improve it"));
  assert.ok(homePrompt.includes("EXACT HOME INTRO"));
  assert.ok(homePrompt.includes("EXACT HOME BODY"));
  assert.ok(!homePrompt.includes("EXACT SERVICE INTRO"), "homepage prompt must NOT contain service copy");
  assert.ok(!homePrompt.includes("EXACT SERVICE BODY"), "homepage prompt must NOT contain service body copy");
  // The service prompt contains ONLY the service representative page.
  const servicePrompt = String(mock.calls[6]!.args["prompt"]);
  assert.ok(servicePrompt.includes("EXACT SERVICE INTRO"));
  assert.ok(servicePrompt.includes("EXACT SERVICE BODY"));
  assert.ok(!servicePrompt.includes("EXACT HOME INTRO"), "service prompt must NOT contain homepage copy");
  assert.ok(!servicePrompt.includes("EXACT HOME BODY"), "service prompt must NOT contain homepage body copy");
  assert.ok(homePrompt.includes("Generic template look"));
  // The homepage mobile generation reuses the same prompt with MOBILE device.
  assert.equal(mock.calls[4]!.args["deviceType"], "MOBILE");
  assert.equal(String(mock.calls[4]!.args["prompt"]), homePrompt, "mobile homepage uses the same accepted copy");
  // Candidate validates against the contract and binds lineage.
  assert.equal(result.candidate.provider, "google-stitch");
  assert.equal(result.candidate.providerMode, "live");
  assert.equal(result.candidate.designMdToolVersion, "@google/design.md@0.4.0+factory-design-requirements-v1");
  assert.equal(result.candidate.providerProjectName, "projects/123");
  // Desktop + mobile homepage screens + service desktop screen.
  assert.equal(result.candidate.screens.length, 3);
  assert.equal(result.candidate.screens.filter((s) => s.archetype === "homepage").length, 2);
  assert.ok(result.candidate.screens.some((s) => s.deviceType === "MOBILE"), "a mobile homepage screen exists for responsive review");
  assert.deepEqual(result.candidate.archetypes.map((a) => a.kind), ["homepage", "service"]);
  assert.equal(result.candidate.providerSessionId, "sess-2");
  // DESIGN.md artifact is produced.
  const designMd = result.rawArtifacts.find((a) => a.kind === "design_md");
  assert.ok(designMd);
  assert.ok(new TextDecoder().decode(designMd.bytes).startsWith("---"));
  // Provider response evidence preserved.
  assert.ok(result.rawArtifacts.some((a) => a.kind === "provider_response"));
});

test("generation: provider error result surfaces as typed provider failure", async () => {
  const mock = new MockStitchClient();
  mock.queue({ __error: true, __message: "quota exceeded" });
  const provider = new StitchDesignProvider({
    env: { STITCH_ACCESS_TOKEN: "test-token" },
    createClient: () => mock,
  });
  await assert.rejects(
    provider.generateDesignSystem(generationRequest()),
    (e: unknown) => e instanceof Error && /quota exceeded/.test(e.message),
  );
});

test("generation: missing screen in output fails closed", async () => {
  const mock = new MockStitchClient();
  mock.queue({ name: "projects/123" });
  mock.queue({ name: "assets/456" });
  mock.queue({ outputComponents: [{ design: { screens: [] } }] });
  const provider = new StitchDesignProvider({
    env: { STITCH_ACCESS_TOKEN: "test-token" },
    createClient: () => mock,
  });
  await assert.rejects(
    provider.generateDesignSystem(generationRequest()),
    /returned no screen/,
  );
});

test("generation: malformed structured output fails closed", async () => {
  const mock = new MockStitchClient();
  mock.queue({ name: 42 }); // create_project returns a non-string name
  mock.queue({ name: "assets/456" });
  mock.queue({ outputComponents: [] });
  const provider = new StitchDesignProvider({
    env: { STITCH_ACCESS_TOKEN: "test-token" },
    createClient: () => mock,
  });
  await assert.rejects(
    provider.generateDesignSystem(generationRequest()),
    /"project name" is missing or not a string/,
  );
});

test("generation: unparseable tool result fails closed", async () => {
  const mock = new MockStitchClient();
  mock.callTool = async () => ({ content: [{ type: "text", text: "not json at all" }] });
  const provider = new StitchDesignProvider({
    env: { STITCH_ACCESS_TOKEN: "test-token" },
    createClient: () => mock,
  });
  await assert.rejects(
    provider.generateDesignSystem(generationRequest()),
    /unparseable result/,
  );
});

test("default client factory: constructs without network on creation", () => {
  // The default factory must be constructible without side effects; actual
  // network happens only on listTools/callTool after connect().
  const client = createStitchMcpClient({ env: { STITCH_ACCESS_TOKEN: "x" } });
  assert.ok(client);
  assert.ok(typeof client.callTool === "function");
});

test("endpoint constant points at the official Google Stitch MCP service", () => {
  assert.equal(STITCH_MCP_ENDPOINT, "https://stitch.googleapis.com/mcp");
});

test("token resolution: prefers STITCH_ACCESS_TOKEN over alternate env", () => {
  assert.equal(resolveStitchToken({ STITCH_ACCESS_TOKEN: " primary " }), "primary");
  assert.equal(resolveStitchToken({ GOOGLE_OAUTH_ACCESS_TOKEN: " alt " }), "alt");
  assert.equal(resolveStitchToken({}), null);
});
