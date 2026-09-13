/**
 * LIVE STITCH INTEGRATION PROOF (Run 6, Checkpoint H) — controlled, one-shot.
 *
 * Executes a REAL generation against the official Google Stitch remote MCP
 * service using real Google OAuth credentials from the local environment,
 * through the SAME governed pipeline the production service uses.
 *
 * NOT part of ordinary unit/CI test runs (env-gated):
 *   FACTORY_DESIGN_LIVE_PROOF=1 STITCH_ACCESS_TOKEN=<token> \
 *     tsx tests/design-live-proof.ts
 *
 * HONEST SCOPE (§23): when run WITHOUT accepted Factory upstream authority
 * (real ProjectInputSnapshot, AcceptedPageContent, approved asset), this
 * script proves LIVE PROVIDER CONNECTIVITY + GENERATION ONLY — never the
 * full Run 6 authority pipeline. It must be reported as such. To exercise
 * the full pipeline, seed a real project through the governed service and
 * pass its ids via FACTORY_LIVE_PROOF_PROJECT_ID (the script then derives
 * the input snapshot from the real accepted authority).
 *
 * Cost discipline: exactly one create_project + one create_design_system +
 * two generate calls (homepage desktop + homepage mobile). Never runs
 * without the env gate.
 */
import { StitchDesignProvider, DESIGN_MD_TOOL_VERSION } from "../src/design/stitch-provider.js";
import { DesignStore } from "../src/design/design-store.js";
import { DesignService, FACTORY_DESIGN_SEED } from "../src/design/service.js";
import { createDatabaseInstance } from "../src/persistence/db.js";
import { parseDesignInputSnapshotData, type DesignInputSnapshotData } from "@factory/contracts";

const ENABLED = process.env.FACTORY_DESIGN_LIVE_PROOF === "1";
if (!ENABLED) {
  console.log("Live proof disabled (set FACTORY_DESIGN_LIVE_PROOF=1 to run).");
  process.exit(0);
}

const REAL_PROJECT_ID = process.env.FACTORY_LIVE_PROOF_PROJECT_ID?.trim() || null;

let input: DesignInputSnapshotData;
let inputSnapshotId: string;
let authorityNote: string;

if (REAL_PROJECT_ID) {
  // Full-authority mode: derive the input snapshot from the project's real
  // accepted upstream (ProjectInputSnapshot + AcceptedPageContent + approved
  // asset assignments). The stored DesignInputSnapshot is immutable and
  // digest-bound; this proof uses EXACTLY that authority.
  const dbInst = createDatabaseInstance();
  const designStore = new DesignStore(dbInst.db);
  const snapshot = await designStore.latestInputSnapshot(REAL_PROJECT_ID);
  if (!snapshot) {
    console.error(
      `No design input snapshot exists for project ${REAL_PROJECT_ID}; derive one via the governed service first.`,
    );
    await dbInst.close();
    process.exit(1);
  }
  input = parseDesignInputSnapshotData(snapshot.data);
  inputSnapshotId = snapshot.id;
  authorityNote = "REAL accepted Factory authority (DesignInputSnapshot derived by the governed service).";
  console.log("AUTHORITY: real DesignInputSnapshot", snapshot.id, "v" + snapshot.version, snapshot.inputDigest.slice(0, 12));
  await dbInst.close();
} else {
  // Connectivity-only mode: synthetic bounded input. PROVES NOTHING about
  // the Run 6 authority pipeline — reported as connectivity proof only.
  input = parseDesignInputSnapshotData({
    schemaVersion: "design-v1",
    acceptedInputSnapshotId: "pis-live-proof-connectivity",
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
    representativePages: [],
    archetypes: ["homepage"],
  });
  inputSnapshotId = "dsi-live-proof-connectivity";
  authorityNote =
    "SYNTHETIC connectivity-only input (no accepted Factory upstream): this proves LIVE STITCH CONNECTIVITY/GENERATION ONLY, NOT the Run 6 authority pipeline.";
}

console.log("SCOPE:", authorityNote);

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
  inputSnapshotId,
  projectId: REAL_PROJECT_ID ?? "live-proof-connectivity",
  // Connectivity mode: no accepted copy exists — the prompt carries no
  // accepted copy section (structural slots only). Full-authority mode
  // would route per-archetype copy; the governed service does this.
  acceptedCopyByArchetype: {},
  designSeed: {
    colors: { ...FACTORY_DESIGN_SEED.colors },
    typography: { ...FACTORY_DESIGN_SEED.typography },
    rationale: FACTORY_DESIGN_SEED.rationale,
  },
});
const durationMs = Date.now() - started;

console.log("DURATION_MS:", durationMs);
console.log("PROVIDER_MODE: live (real Stitch MCP execution)");
console.log("DESIGN_MD_TOOL_VERSION:", DESIGN_MD_TOOL_VERSION, "(Factory internal validator — the DESIGN.md is validated in-process, NOT by official Google tooling)");
console.log("PROVIDER_PROJECT:", result.providerProjectName);
console.log("PROVIDER_SESSION:", result.providerSessionId);
console.log("SCREENS:", JSON.stringify(result.candidate.screens, null, 1));
console.log("DESIGN_MD_DIGEST:", result.candidate.designMdDigest);
console.log("ARTIFACTS:", result.rawArtifacts.map((a) => `${a.kind}:${a.bytes.byteLength}B`).join(", "));
const assetSlots = result.candidate.archetypes.flatMap((a) => a.assetSlots);
console.log(
  "ASSET_CONSUMPTION:",
  assetSlots.length === 0
    ? "no asset slots in this input"
    : assetSlots
        .map(
          (s) =>
            `${s.slot} [page ${s.pageSlug}/${s.role}] providerConsumed=${s.providerConsumed}${s.unresolvedReason ? ` (${s.unresolvedReason})` : ""}`,
        )
        .join("; "),
);
const html = result.rawArtifacts.find((a) => a.kind === "screen_html");
if (html) {
  console.log("HTML_HEAD:", new TextDecoder().decode(html.bytes).slice(0, 500));
}
console.log("LIVE PROOF COMPLETE");
console.log(
  "REPORT HONESTY: this live proof verifies Stitch connectivity/generation and truthful asset-consumption recording.",
  REAL_PROJECT_ID
    ? "It used REAL accepted Factory authority for the design input."
    : "It did NOT exercise accepted Factory content/asset authority (synthetic input) — do not report it as a Run 6 pipeline proof.",
);
