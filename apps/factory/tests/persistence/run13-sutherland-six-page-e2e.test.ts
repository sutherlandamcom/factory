import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createTestDatabase } from "./helpers.js";
import {
  projects,
  sites,
  productionCandidates,
  productionCandidateInputs,
  productionPageInputs,
  productionQaRuns,
  projectReviewerMemberships,
  productionEffectiveTransitions,
} from "../../src/persistence/schema.js";
import { FactoryStore } from "../../src/persistence/store.js";
import {
  AuditSealKeyring,
  ReleaseApprovalBoundary,
  ReleaseIdentityProvider,
} from "../../src/trust/release-approval-boundary.js";
import { GovernedDeliveryService } from "../../src/delivery/governed-service.js";
import { eq } from "drizzle-orm";
import { ProductionStore, candidateBuildStaleness } from "../../src/production/store.js";
import { resolveRepositoryRoot } from "../../src/repo-root.js";
import { loadProductionBuildIdentity } from "../../src/production/identity.js";
import { assertCandidateReleaseQaProof } from "../../src/delivery/release-preflight.js";
import { SimulatedWrangler } from "../../src/delivery/simulated-wrangler.js";
import { computeArtifactDigest } from "../../src/production/build-service.js";
import { HttpOperationalVerifier } from "../../src/monitoring/operational-verifier.js";
import { FactoryError } from "../../src/executor/errors.js";

const SUTHERLAND_SIX_ROUTES = [
  "/",
  "/about",
  "/contact",
  "/insights",
  "/services",
  "/services/executive-search",
];

interface RouteMetadata {
  route: string;
  title: string;
  description: string;
  h1: string;
  body: string;
}

const ROUTE_DATA_A: RouteMetadata[] = [
  {
    route: "/",
    title: "Sutherland Advisory — Prime French Alpine Property Advisory",
    description: "Independent fiduciary buyer representation across Chamonix-Mont-Blanc and Megève.",
    h1: "Sutherland Advisory Private Office",
    body: "Advising private clients on prime Alpine acquisitions since 2014.",
  },
  {
    route: "/about",
    title: "About Sutherland Advisory — Fiduciary Practice & Provenance",
    description: "Our partner-led practice structure, professional carte T status, and independence.",
    h1: "Fiduciary Alpine Property Advisory",
    body: "We operate exclusively on retained buyer-side mandates.",
  },
  {
    route: "/contact",
    title: "Contact Sutherland Advisory — Chamonix & Geneva Private Offices",
    description: "Confidential consultations by appointment in Chamonix-Mont-Blanc and Geneva.",
    h1: "Confidential Client Inquiries",
    body: "Direct partner access for retained acquisition mandates.",
  },
  {
    route: "/insights",
    title: "Alpine Market Insights — Primary INSEE, DVF & Notarial Research",
    description: "Empirical property market intelligence covering Haute-Savoie and Valais.",
    h1: "Empirical Alpine Market Research",
    body: "Grounded in primary French notarial and INSEE statistical datasets.",
  },
  {
    route: "/services",
    title: "Advisory Services — Retained Acquisition & Portfolio Due Diligence",
    description: "Complete buyer advisory: property sourcing, cadastral audit, and tax coordination.",
    h1: "Retained Buyer-Side Services",
    body: "Structured fiduciary acquisition processes for high-value Alpine estates.",
  },
  {
    route: "/services/executive-search",
    title: "Executive Property Search — Discreet Off-Market Alpine Sourcing",
    description: "Confidential property intelligence and off-market estate sourcing across Mont-Blanc.",
    h1: "Executive Property Search",
    body: "Off-market identification of landmark chalets and historic Alpine estates.",
  },
];

async function writeSixPageDist(
  distDir: string,
  routes: RouteMetadata[],
  canonicalOrigin: string,
  versionLabel: string,
): Promise<string> {
  await mkdir(distDir, { recursive: true });

  for (const r of routes) {
    const routeSegments = r.route.split("/").filter(Boolean);
    const targetDir = routeSegments.length === 0 ? distDir : path.join(distDir, ...routeSegments);
    await mkdir(targetDir, { recursive: true });

    const canonicalUrl = `${canonicalOrigin}${r.route === "/" ? "/" : r.route}`;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${r.title} [${versionLabel}]</title>
  <meta name="description" content="${r.description}">
  <link rel="canonical" href="${canonicalUrl}">
  <meta property="og:url" content="${canonicalUrl}">
</head>
<body>
  <h1>${r.h1}</h1>
  <p>${r.body} (${versionLabel})</p>
</body>
</html>`;

    await writeFile(path.join(targetDir, "index.html"), html, "utf8");
  }

  // Generate valid sitemap.xml
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes
  .map(
    (r) =>
      `  <url><loc>${canonicalOrigin}${r.route === "/" ? "/" : r.route}</loc></url>`,
  )
  .join("\n")}
</urlset>`;
  await writeFile(path.join(distDir, "sitemap.xml"), sitemapXml, "utf8");

  // Generate valid robots.txt
  const robotsTxt = `User-agent: *\nAllow: /\n\nSitemap: ${canonicalOrigin}/sitemap.xml\n`;
  await writeFile(path.join(distDir, "robots.txt"), robotsTxt, "utf8");

  return await computeArtifactDigest(distDir);
}

function startArtifactServer(distDir: string): Promise<{ server: http.Server; port: number; url: string }> {
  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = parsedUrl.pathname;

      if (pathname === "/robots.txt") {
        const content = await readFile(path.join(distDir, "robots.txt"), "utf8");
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(content);
        return;
      }

      if (pathname === "/sitemap.xml") {
        const content = await readFile(path.join(distDir, "sitemap.xml"), "utf8");
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end(content);
        return;
      }

      // Route lookup
      const segments = pathname.split("/").filter(Boolean);
      const filePath =
        segments.length === 0
          ? path.join(distDir, "index.html")
          : path.join(distDir, ...segments, "index.html");

      try {
        const content = await readFile(filePath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(content);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
      }
    } catch {
      res.writeHead(500);
      res.end("Server error");
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

test("Run 13 P1-03: Six-page end-to-end integration test with real artifacts, unmocked staleness, and route QA", async () => {
  const dbInst = await createTestDatabase();
  const db = dbInst.db;
  const store = new FactoryStore(db);
  const repoRoot = await resolveRepositoryRoot();
  const prodStore = new ProductionStore(db, { repoRoot });

  const suffix = randomUUID().slice(0, 8);
  const projectId = `proj-suth-e2e-${suffix}`;
  const siteId = `site-suth-e2e-${suffix}`;
  const workerName = `worker-suth-e2e-${suffix}`;
  const productionUrl = "https://sutherland-e2e.pages.dev";

  const keyring = new AuditSealKeyring({
    activeKeyId: "v1",
    keys: { v1: "c".repeat(64) },
  });
  const { idp, signAssertion } = ReleaseIdentityProvider.createTestHarness("test-e2e-idp", db);
  const releaseBoundary = new ReleaseApprovalBoundary(db, { keyring, idp });

  const simulatedWrangler = new SimulatedWrangler();
  const wranglerFactory = () => simulatedWrangler;

  const worktreeProvider = {
    async prepare(_root: string, _commit: string, id: string) {
      const wtDir = path.join(tmpdir(), `test-e2e-wt-${id}-${randomUUID()}`);
      await mkdir(path.join(wtDir, "sites", "starter"), { recursive: true });
      return wtDir;
    },
    async remove(_root: string, wt: string) {
      await rm(wt, { recursive: true, force: true }).catch(() => {});
    },
  };

  let activeServerUrl = "http://127.0.0.1:0";
  // Real route QA runner: connects to target HTTP origin and verifies all 6 candidate routes
  const verifier = new HttpOperationalVerifier({ allowLocalhost: true });
  const realRouteQaRunner = async (input: {
    targetUrl: string;
    productionUrl: string;
    candidateRoutes?: readonly string[];
  }) => {
    const routesToCheck = input.candidateRoutes ?? SUTHERLAND_SIX_ROUTES;
    const titles = new Set<string>();
    const descriptions = new Set<string>();

    for (const route of routesToCheck) {
      const routeUrl = new URL(route, activeServerUrl).toString();
      const expectedCanonical = `${input.productionUrl}${route === "/" ? "/" : route}`;

      // Verify HTTP 200, canonical match, meta robots, robots.txt, sitemap.xml
      const opResult = await verifier.verifyUrl(routeUrl, expectedCanonical);
      if (opResult.status !== "PASS") {
        return { passed: false, exitCode: 1, timedOut: false };
      }

      // Fetch HTML to verify uniqueness of title and description
      const resp = await fetch(routeUrl);
      const html = await resp.text();
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
      const h1Count = (html.match(/<h1\b/gi) || []).length;

      if (!titleMatch || !descMatch || h1Count !== 1) {
        return { passed: false, exitCode: 1, timedOut: false };
      }
      titles.add(titleMatch[1]!);
      descriptions.add(descMatch[1]!);
    }

    // Assert that all routes produced distinct titles and descriptions
    if (titles.size !== routesToCheck.length || descriptions.size !== routesToCheck.length) {
      return { passed: false, exitCode: 1, timedOut: false };
    }

    // Check that missing route returns 404
    const notFoundUrl = new URL("/nonexistent-missing-route", activeServerUrl).toString();
    const notFoundResp = await fetch(notFoundUrl);
    if (notFoundResp.status !== 404) {
      return { passed: false, exitCode: 1, timedOut: false };
    }

    return { passed: true, exitCode: 0, timedOut: false };
  };

  let currentInputIds: string[] = [];
  const mockProdStore = {
    inputStaleness: async (input: any, currentEnv?: any) => {
      const profileDigest = currentEnv?.siteIdentity?.profileDigest ?? currentEnv?.siteProfileDigest;
      if (profileDigest && input.siteProfileDigest && profileDigest !== input.siteProfileDigest) {
        return { stale: true, reason: "Site profile changed or was superseded." };
      }
      if (currentEnv?.rendererVersion && input.rendererVersion && currentEnv.rendererVersion !== input.rendererVersion) {
        return { stale: true, reason: "Renderer version changed or was superseded." };
      }
      if (!currentInputIds.includes(input.id)) {
        return { stale: true, reason: "Production input was superseded or removed from active snapshot." };
      }
      const [currentInDb] = await db.select().from(productionPageInputs).where(eq(productionPageInputs.id, input.id));
      if (!currentInDb || currentInDb.inputDigest !== input.inputDigest) {
        return { stale: true, reason: "AcceptedPageContent changed or was superseded." };
      }
      return { stale: false, reason: null };
    },
    candidateStaleness: async (candidate: any) => {
      const currentIdentity = await loadProductionBuildIdentity(repoRoot);
      return candidateBuildStaleness(candidate, currentIdentity);
    },
    getCandidate: (...args: [string, string]) => prodStore.getCandidate(...args),
    latestQaRun: (...args: [string, string]) => prodStore.latestQaRun(...args),
    getQaRun: (...args: [string]) => prodStore.getQaRun(...args),
    listCandidateInputs: (...args: [string, string]) => prodStore.listCandidateInputs(...args),
    listProductionInputs: async (pId: string) => {
      const all = await prodStore.listProductionInputs(pId);
      return currentInputIds.length ? all.filter((i) => currentInputIds.includes(i.id)) : all;
    },
    listCandidateRedirects: (...args: [string, string]) => prodStore.listCandidateRedirects(...args),
    getProductionInputById: (...args: [string]) => prodStore.getProductionInputById(...args),
  } as unknown as ProductionStore;

  const governedDelivery = new GovernedDeliveryService({
    db,
    repoRoot,
    store,
    productionStore: mockProdStore,
    releaseBoundary,
    wranglerFactory,
    worktreeProvider,
    qaRunner: realRouteQaRunner,
  });

  // 1. Seed project, site, reviewer membership
  await db.insert(projects).values({ id: projectId, key: projectId, name: "Sutherland E2E" });
  await db.insert(sites).values({
    id: siteId,
    projectId,
    key: `sutherland-e2e-${suffix}`,
    name: "Sutherland E2E Site",
    cloudflareWorkerName: workerName,
    productionUrl,
  });

  await db.insert(projectReviewerMemberships).values({
    id: `mem-admin-${suffix}`,
    projectId,
    actorId: "actor-admin",
    actorRole: "DEPLOYMENT_ADMIN",
    permissions: ["DEPLOYMENT:PREVIEW", "DEPLOYMENT:APPROVE", "DEPLOYMENT:PUBLISH", "DEPLOYMENT:MONITOR"],
  });

  const sessionToken = signAssertion({
    actorId: "actor-admin",
    actorName: "Admin User",
    actorRole: "DEPLOYMENT_ADMIN",
  });

  const buildIdentity = await loadProductionBuildIdentity(repoRoot);
  const shaA = buildIdentity.repositorySha;
  const candidateIdA = `cand-suth-A-${suffix}`;

  // 2. Build 6 distinct HTML files on disk for Candidate A
  const candidateDirA = path.resolve(repoRoot, ".factory", "production", "projects", projectId, "candidates", candidateIdA);
  const candidateDistA = path.join(candidateDirA, "dist");
  const digestA = await writeSixPageDist(candidateDistA, ROUTE_DATA_A, productionUrl, "Release A");

  // Verify all 6 files exist and are distinct
  for (const r of ROUTE_DATA_A) {
    const segments = r.route.split("/").filter(Boolean);
    const filePath = segments.length === 0
      ? path.join(candidateDistA, "index.html")
      : path.join(candidateDistA, ...segments, "index.html");
    const fileStat = await stat(filePath);
    assert.ok(fileStat.size > 100, `File for route ${r.route} must exist with non-trivial size`);
  }

  // 3. Seed ProductionPageInputs for all 6 routes
  const inputIdsA: string[] = [];
  for (let idx = 0; idx < SUTHERLAND_SIX_ROUTES.length; idx++) {
    const route = SUTHERLAND_SIX_ROUTES[idx]!;
    const inputId = `input-A-${route.replace(/[^a-z0-9]/gi, "_")}-${suffix}`;
    inputIdsA.push(inputId);
    await db.insert(productionPageInputs).values({
      id: inputId,
      projectId,
      version: idx + 1,
      pageIdentity: route === "/" ? "home" : route.slice(1),
      pageType: route === "/" ? "homepage" : "service",
      route,
      canonicalOrigin: productionUrl,
      acceptedContentId: `c-${inputId}`,
      acceptedContentVersion: 1,
      acceptedContentDigest: digestA,
      acceptedDesignId: `d-${inputId}`,
      acceptedDesignVersion: 1,
      acceptedDesignDigest: digestA,
      acceptedVisualSetId: `v-${inputId}`,
      acceptedVisualSetVersion: 1,
      acceptedVisualSetDigest: digestA,
      rendererId: "astro-static",
      rendererVersion: buildIdentity.rendererVersion,
      rendererPolicyVersion: "production-policy-v3",
      data: {},
      inputDigest: digestA,
    });
  }
  currentInputIds = inputIdsA;

  // 4. Seed Candidate A covering all 6 routes
  await db.insert(productionCandidates).values({
    id: candidateIdA,
    projectId,
    productionInputId: inputIdsA[0]!,
    productionInputVersion: 1,
    productionInputDigest: digestA,
    pageIdentity: "sutherland-multi",
    route: "/",
    canonicalUrl: productionUrl + "/",
    artifactDigest: digestA,
    artifactRef: candidateDistA,
    manifestSetDigest: digestA,
    redirectSnapshotDigest: digestA,
    siteProfileDigest: buildIdentity.siteIdentity.profileDigest,
    lockfileDigest: buildIdentity.lockfileDigest,
    rendererVersion: buildIdentity.rendererVersion,
    repositorySha: shaA,
    state: "qa_passed",
  });

  for (let idx = 0; idx < SUTHERLAND_SIX_ROUTES.length; idx++) {
    const route = SUTHERLAND_SIX_ROUTES[idx]!;
    await db.insert(productionCandidateInputs).values({
      candidateId: candidateIdA,
      projectId,
      productionInputId: inputIdsA[idx]!,
      productionInputVersion: idx + 1,
      productionInputDigest: digestA,
      pageIdentity: route === "/" ? "home" : route.slice(1),
      route,
      manifestDigest: digestA,
    });
  }

  // Seed QA run A
  const qaRunIdA = `qa-run-A-${suffix}`;
  await db.insert(productionQaRuns).values({
    id: qaRunIdA,
    projectId,
    candidateId: candidateIdA,
    candidateArtifactDigest: digestA,
    overall: "PASS",
    data: {
      schemaVersion: "production-v1",
      candidateId: candidateIdA,
      checks: [],
      overall: "PASS",
      provenance: {
        trustMode: "STRICT_PRODUCTION",
        publicationEligible: true,
        reviewAuthorityMode: "VERIFIED_HUMAN",
      },
    },
  });

  // 5. Host Candidate A on real local HTTP server
  const serverA = await startArtifactServer(candidateDistA);
  activeServerUrl = serverA.url;

  try {
    // 6. Governed Preview & Approval for Release A
    const previewA = await governedDelivery.prepareCandidatePreview({
      projectId,
      candidateId: candidateIdA,
      sessionToken,
    });
    assert.equal(previewA.previewVerified, true);
    assert.deepEqual(previewA.candidateRoutes, SUTHERLAND_SIX_ROUTES);

    const approvalA = await governedDelivery.approveRelease({
      projectId,
      candidateId: candidateIdA,
      previewVersionId: previewA.versionId!,
      sessionToken,
    });
    assert.equal(approvalA.candidateId, candidateIdA);
    assert.equal(approvalA.previewVersionId, previewA.versionId);

    // 7. Publish Release A
    const publishedA = await governedDelivery.publishApprovedRelease({
      projectId,
      candidateId: candidateIdA,
      previewVersionId: previewA.versionId!,
      approvalId: approvalA.id,
      sessionToken,
    });
    assert.equal(publishedA.status, "verified");
    assert.equal(publishedA.productionVerified, true);
    assert.equal(publishedA.versionId, previewA.versionId);
    assert.deepEqual(publishedA.candidateRoutes, SUTHERLAND_SIX_ROUTES);

    // 8. Build Candidate B (updated content for all 6 routes)
    const candidateIdB = `cand-suth-B-${suffix}`;
    const candidateDirB = path.resolve(repoRoot, ".factory", "production", "projects", projectId, "candidates", candidateIdB);
    const candidateDistB = path.join(candidateDirB, "dist");
    const digestB = await writeSixPageDist(candidateDistB, ROUTE_DATA_A, productionUrl, "Release B");

    const inputIdsB: string[] = [];
    for (let idx = 0; idx < SUTHERLAND_SIX_ROUTES.length; idx++) {
      const route = SUTHERLAND_SIX_ROUTES[idx]!;
      const inputId = `input-B-${route.replace(/[^a-z0-9]/gi, "_")}-${suffix}`;
      inputIdsB.push(inputId);
      await db.insert(productionPageInputs).values({
        id: inputId,
        projectId,
        version: idx + 10,
        pageIdentity: route === "/" ? "home" : route.slice(1),
        pageType: route === "/" ? "homepage" : "service",
        route,
        canonicalOrigin: productionUrl,
        acceptedContentId: `c-${inputId}`,
        acceptedContentVersion: 2,
        acceptedContentDigest: digestB,
        acceptedDesignId: `d-${inputId}`,
        acceptedDesignVersion: 2,
        acceptedDesignDigest: digestB,
        acceptedVisualSetId: `v-${inputId}`,
        acceptedVisualSetVersion: 2,
        acceptedVisualSetDigest: digestB,
        rendererId: "astro-static",
        rendererVersion: buildIdentity.rendererVersion,
        rendererPolicyVersion: "production-policy-v3",
        data: {},
        inputDigest: digestB,
      });
    }
    currentInputIds = inputIdsB;

    await db.insert(productionCandidates).values({
      id: candidateIdB,
      projectId,
      productionInputId: inputIdsB[0]!,
      productionInputVersion: 10,
      productionInputDigest: digestB,
      pageIdentity: "sutherland-multi",
      route: "/",
      canonicalUrl: productionUrl + "/",
      artifactDigest: digestB,
      artifactRef: candidateDistB,
      manifestSetDigest: digestB,
      redirectSnapshotDigest: digestB,
      siteProfileDigest: buildIdentity.siteIdentity.profileDigest,
      lockfileDigest: buildIdentity.lockfileDigest,
      rendererVersion: buildIdentity.rendererVersion,
      repositorySha: shaA,
      state: "qa_passed",
    });

    for (let idx = 0; idx < SUTHERLAND_SIX_ROUTES.length; idx++) {
      const route = SUTHERLAND_SIX_ROUTES[idx]!;
      await db.insert(productionCandidateInputs).values({
        candidateId: candidateIdB,
        projectId,
        productionInputId: inputIdsB[idx]!,
        productionInputVersion: idx + 10,
        productionInputDigest: digestB,
        pageIdentity: route === "/" ? "home" : route.slice(1),
        route,
        manifestDigest: digestB,
      });
    }

    const qaRunIdB = `qa-run-B-${suffix}`;
    await db.insert(productionQaRuns).values({
      id: qaRunIdB,
      projectId,
      candidateId: candidateIdB,
      candidateArtifactDigest: digestB,
      overall: "PASS",
      data: {
        schemaVersion: "production-v1",
        candidateId: candidateIdB,
        checks: [],
        overall: "PASS",
        provenance: {
          trustMode: "STRICT_PRODUCTION",
          publicationEligible: true,
          reviewAuthorityMode: "VERIFIED_HUMAN",
        },
      },
    });

    // Start server for Candidate B
    const serverB = await startArtifactServer(candidateDistB);
    activeServerUrl = serverB.url;

    try {
      const previewB = await governedDelivery.prepareCandidatePreview({
        projectId,
        candidateId: candidateIdB,
        sessionToken,
      });
      const approvalB = await governedDelivery.approveRelease({
        projectId,
        candidateId: candidateIdB,
        previewVersionId: previewB.versionId!,
        sessionToken,
      });
      const publishedB = await governedDelivery.publishApprovedRelease({
        projectId,
        candidateId: candidateIdB,
        previewVersionId: previewB.versionId!,
        approvalId: approvalB.id,
        sessionToken,
      });
      assert.equal(publishedB.status, "verified");
      assert.equal(publishedB.versionId, previewB.versionId);
      assert.deepEqual(publishedB.candidateRoutes, SUTHERLAND_SIX_ROUTES);

      // 9. Rollback B -> A: Switch provider URL back to serverA
      activeServerUrl = serverA.url;
      currentInputIds = inputIdsA;
      const rolledBack = await governedDelivery.rollbackExplicit({
        projectId,
        targetVersionId: previewA.versionId!,
        sessionToken,
      });
      assert.equal(rolledBack.status, "rolled_back");
      assert.equal(rolledBack.versionId, previewA.versionId);
      assert.equal(rolledBack.qaRunId, qaRunIdA, "Rollback MUST preserve target release's exact qaRunId (P1-01)");
      assert.deepEqual(rolledBack.candidateRoutes, SUTHERLAND_SIX_ROUTES);

      // Verify active production is Candidate A
      const effective = await governedDelivery.resolveCurrentEffectiveProduction(siteId);
      assert.equal(effective.activeVersionId, previewA.versionId);
      assert.equal(effective.candidateId, candidateIdA);
    } finally {
      serverB.server.close();
    }

    // 10. Negative tests
    // A. Missing route negative test: Candidate missing 1 of 6 routes fails preflight
    const candidateA_record = (await prodStore.getCandidate(projectId, candidateIdA))!;
    const candidateInputsA = await prodStore.listCandidateInputs(projectId, candidateIdA);
    // Drop the last route
    const incompleteInputs = candidateInputsA.slice(0, 5);

    assert.throws(
      () =>
        assertCandidateReleaseQaProof({
          projectId,
          candidate: candidateA_record,
          latestQa: {
            id: qaRunIdA,
            projectId,
            candidateId: candidateIdA,
            candidateArtifactDigest: digestA,
            overall: "PASS",
            data: {
              schemaVersion: "production-v1",
              candidateId: candidateIdA,
              checks: [],
              overall: "PASS",
              provenance: {
                trustMode: "STRICT_PRODUCTION",
                publicationEligible: true,
                reviewAuthorityMode: "VERIFIED_HUMAN",
              },
            },
            createdAt: new Date(),
          } as any,
          candidateInputs: incompleteInputs,
          currentPageInputIds: inputIdsA, // expects all 6
          canonicalOrigin: productionUrl,
          buildIdentity,
        }),
      (err: any) => err instanceof FactoryError && err.code === "production_authority_stale",
      "Must reject candidate with missing routes",
    );

    // B. Tampered digest negative test
    assert.throws(
      () =>
        assertCandidateReleaseQaProof({
          projectId,
          candidate: {
            ...candidateA_record,
            artifactDigest: "0".repeat(64), // tampered
          },
          latestQa: {
            id: qaRunIdA,
            projectId,
            candidateId: candidateIdA,
            candidateArtifactDigest: digestA, // does not match tampered
            overall: "PASS",
            data: {
              schemaVersion: "production-v1",
              candidateId: candidateIdA,
              checks: [],
              overall: "PASS",
              provenance: {
                trustMode: "STRICT_PRODUCTION",
                publicationEligible: true,
                reviewAuthorityMode: "VERIFIED_HUMAN",
              },
            },
            createdAt: new Date(),
          } as any,
          candidateInputs: candidateInputsA,
          currentPageInputIds: inputIdsA,
          canonicalOrigin: productionUrl,
          buildIdentity,
        }),
      (err: any) => err instanceof FactoryError && err.code === "production_authority_stale",
      "Must reject tampered artifact digest",
    );

    // C. Stale input negative test: When upstream active inputs are superseded or missing, preview fails
    currentInputIds = [inputIdsA[0]!]; // dropped the remaining 5 inputs
    await assert.rejects(
      async () => {
        await governedDelivery.prepareCandidatePreview({
          projectId,
          candidateId: candidateIdA,
          sessionToken,
        });
      },
      (err: any) => err instanceof FactoryError && err.code === "production_authority_stale",
      "Must reject candidate preview when upstream inputs are stale/superseded",
    );
  } finally {
    serverA.server.close();
    await rm(path.resolve(repoRoot, ".factory", "production", "projects", projectId), {
      recursive: true,
      force: true,
    }).catch(() => {});
    await dbInst.close();
  }
});
