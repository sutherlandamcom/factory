/** One env-gated production-service execution; no retries and no ordinary CI calls. */
import { StitchDesignProvider } from "../src/design/stitch-provider.js";
import { DesignStore } from "../src/design/design-store.js";
import { DesignService } from "../src/design/service.js";
import { createDatabaseInstance } from "../src/persistence/db.js";
import { parseDesignInputSnapshotData } from "@factory/contracts";

if (process.env.FACTORY_DESIGN_LIVE_PROOF !== "1") {
  console.log("Live proof disabled; no provider calls.");
} else {
  const projectId = process.env.FACTORY_LIVE_PROOF_PROJECT_ID?.trim();
  if (!projectId) throw new Error("NOT VERIFIED: a real qualified project ID is required.");
  const db = createDatabaseInstance();
  try {
    const store = new DesignStore(db.db);
    const snapshot = await store.latestInputSnapshot(projectId);
    if (!snapshot) throw new Error("NOT VERIFIED: derive a real design input snapshot first.");
    const data = parseDesignInputSnapshotData(snapshot.data);
    if (!data.contentRefs.length || !data.assetRefs.length || !data.representativePages.length || data.archetypes.length > 3) {
      throw new Error("NOT VERIFIED: proof needs exact accepted content/assets and one to three archetypes.");
    }
    const freshness = await store.inputSnapshotStaleness(projectId, snapshot);
    if (freshness.stale) throw new Error(`NOT VERIFIED: ${freshness.reason}`);
    const service = await DesignService.create({ store, provider: new StitchDesignProvider() });
    // Exactly one service execution. It resolves acceptedCopyByArchetype itself.
    const result = await service.generateCandidate({ projectId });
    console.log(JSON.stringify({ candidateId: result.id, candidateDigest: result.candidateDigest,
      inputSnapshotId: snapshot.id, inputDigest: snapshot.inputDigest, contentRefs: data.contentRefs,
      assetRefs: data.assetRefs, authority: "production service; pending human design acceptance" }));
  } finally { await db.close(); }
}
