/**
 * LIVE STITCH INTEGRATION PROOF (Run 6, Checkpoint F) — controlled, one-shot.
 *
 * Executes a REAL generation against the official Google Stitch remote MCP
 * service using real Google OAuth credentials from the local environment:
 *   create project -> create design system -> generate ONE homepage screen
 *   -> fetch screen detail -> download HTML artifact.
 *
 * NOT part of ordinary unit/CI test runs (env-gated):
 *   FACTORY_DESIGN_LIVE_PROOF=1 STITCH_ACCESS_TOKEN=<token> \
 *     tsx tests/design-live-proof.ts
 *
 * Cost discipline: exactly one generation call; results and provider
 * identifiers are printed for the PR report. Never runs without the env gate.
 */
import { StitchDesignProvider } from "../src/design/stitch-provider.js";
import { parseDesignInputSnapshotData, type DesignInputSnapshotData } from "@factory/contracts";

const ENABLED = process.env.FACTORY_DESIGN_LIVE_PROOF === "1";
if (!ENABLED) {
  console.log("Live proof disabled (set FACTORY_DESIGN_LIVE_PROOF=1 to run).");
  process.exit(0);
}

const input = parseDesignInputSnapshotData({
  schemaVersion: "design-v1",
  acceptedInputSnapshotId: "pis-live-proof",
  acceptedInputSnapshotVersion: 1,
  acceptedInputDigest: "0".repeat(64),
  brand: {
    facts: ["Family-owned roofing firm in Chamonix since 1998"],
    positioning: "High-altitude roofing and alpine property expertise",
    tone: "Plain-spoken expert",
    visualIdentityNotes: "Alpine restraint, documentary photography",
  },
  audience: {
    segments: ["Alpine property owners"],
    needs: ["Durable roofs in extreme mountain climate"],
    decisionContext: "High-stakes renovation decisions",
  },
  references: {
    referenceUrls: [],
    antiReferenceUrls: [],
    learn: ["Restrained institutional typography"],
    avoid: ["Generic real-estate template look", "Luxury clichés"],
    preferredPerception: "Institutional advisory",
  },
  uxRequirements: ["Mobile-first responsive layout", "Single clear primary CTA"],
  contentRefs: [],
  assetRefs: [],
  archetypes: ["homepage"],
});

const provider = new StitchDesignProvider();
const preflight = await provider.preflight();
console.log("PREFLIGHT:", JSON.stringify(preflight));
if (!preflight.configured) {
  console.log("PREFLIGHT FAILED — live proof cannot proceed.");
  process.exit(1);
}

const started = Date.now();
const result = await provider.generateDesignSystem({
  inputSnapshot: input,
  inputSnapshotId: "dsi-live-proof",
  projectId: "live-proof",
  acceptedCopy: [],
});
const durationMs = Date.now() - started;

console.log("DURATION_MS:", durationMs);
console.log("PROVIDER_PROJECT:", result.providerProjectName);
console.log("PROVIDER_SESSION:", result.providerSessionId);
console.log("SCREENS:", JSON.stringify(result.candidate.screens, null, 1));
console.log("DESIGN_MD_DIGEST:", result.candidate.designMdDigest);
console.log("ARTIFACTS:", result.rawArtifacts.map((a) => `${a.kind}:${a.bytes.byteLength}B`).join(", "));
const html = result.rawArtifacts.find((a) => a.kind === "screen_html");
if (html) {
  console.log("HTML_HEAD:", new TextDecoder().decode(html.bytes).slice(0, 500));
}
console.log("LIVE PROOF COMPLETE");
