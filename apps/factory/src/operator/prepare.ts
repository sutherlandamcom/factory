import type { SiteProductionSpec, SiteBlueprint, SiteProfile, SiteTask } from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { evaluateSiteReadiness, type ReadinessContext } from "../site-production/readiness.js";
import { compilePageProductionPacket } from "../site-production/packet.js";
import { projectPacketToSiteTask } from "../site-production/packet-projection.js";
import { deterministicDigest } from "../intelligence/digest.js";

export interface PreparedPageProduction {
  readonly pageSlug: string;
  readonly pageReadiness: Awaited<ReturnType<typeof evaluateSiteReadiness>>["pages"][number];
  readonly packetDigest: string;
  readonly siteTask: SiteTask;
  readonly taskDigest: string;
  readonly eligible: boolean;
  readonly ineligibleReason?: string;
}

/**
 * Governed application seam for page production execution (Macro Run 1):
 *
 * accepted/resolved inputs -> readiness -> packet compilation -> packet digest
 *   -> SiteTask projection -> task digest -> execution eligibility
 *
 * The caller (CLI / Dashboard / automation) receives a fully validated,
 * digest-bound candidate. Execution itself goes through the existing executor
 * boundary via `executePreparedPageProduction`; no new executor is created.
 */
export async function preparePageProductionExecution(input: {
  productionSpec: SiteProductionSpec;
  blueprint: SiteBlueprint;
  siteProfile: SiteProfile;
  pageSlug: string;
  inputRoot?: string | undefined;
  sourceBlueprintRunId: string;
}): Promise<PreparedPageProduction> {
  const context: ReadinessContext = {
    inputRoot: input.inputRoot ?? "",
    blueprint: input.blueprint,
    siteProfile: input.siteProfile,
  };

  // 1. Validate + evaluate readiness for the whole site.
  const readiness = await evaluateSiteReadiness(input.productionSpec, context);

  const pageReadiness = readiness.pages.find((p) => p.slug === input.pageSlug);
  if (!pageReadiness) {
    throw new FactoryError(
      "execution_blocked",
      `page "${input.pageSlug}" not found in production spec readiness evaluation`,
    );
  }

  // 2. Compile the packet (fail closed on structural mismatch).
  const packet = await compilePageProductionPacket({
    productionSpec: input.productionSpec,
    blueprint: input.blueprint,
    siteProfile: input.siteProfile,
    pageSlug: input.pageSlug,
    inputRoot: input.inputRoot,
  });
  const packetDigest = deterministicDigest(packet);

  // 3. Project the packet into a validated SiteTask (contract bounds apply).
  const siteTask = projectPacketToSiteTask({
    packet,
    sourceBlueprintRunId: input.sourceBlueprintRunId,
  });
  const taskDigest = deterministicDigest(siteTask);

  // 4. Execution eligibility gate: page readiness must be READY.
  const eligible = pageReadiness.status === "READY";
  const ineligibleReason = eligible
    ? undefined
    : `page "${input.pageSlug}" readiness is ${pageReadiness.status}: ${pageReadiness.blockers.join("; ")}`;

  return {
    pageSlug: input.pageSlug,
    pageReadiness,
    packetDigest,
    siteTask,
    taskDigest,
    eligible,
    ineligibleReason,
  };
}

/**
 * Execute a prepared page production through the EXISTING executor boundary.
 *
 * `executor` injects the persisted-run driver so tests can supply a spy/mock;
 * production callers omit it and the real `runPersistedSiteTask` driver is
 * used. No new executor is created and no live paid execution happens unless
 * a production executor is explicitly provided.
 */
export async function executePreparedPageProduction(
  prepared: PreparedPageProduction,
  opts: import("../persistence/driver.js").PersistedRunOptions,
  executor: (
    task: PreparedPageProduction["siteTask"],
    runOpts: import("../persistence/driver.js").PersistedRunOptions,
  ) => Promise<Awaited<ReturnType<typeof import("../persistence/driver.js").runPersistedSiteTask>>> =
    async (task, runOpts) => {
      const { runPersistedSiteTask } = await import("../persistence/driver.js");
      return await runPersistedSiteTask(task, runOpts);
    },
): Promise<Awaited<ReturnType<typeof import("../persistence/driver.js").runPersistedSiteTask>>> {
  if (!prepared.eligible) {
    throw new FactoryError(
      "execution_blocked",
      prepared.ineligibleReason ?? "page production is not eligible for execution",
    );
  }
  return await executor(prepared.siteTask, opts);
}
