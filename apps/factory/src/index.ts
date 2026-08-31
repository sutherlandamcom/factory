import path from "node:path";
import { readFile } from "node:fs/promises";
import { exampleSiteTask } from "@factory/contracts";
import { runPersistedSiteTask } from "./persistence/driver.js";
import { resolveDatabaseConfig, sanitizeDatabaseUrl } from "./persistence/config.js";
import { createDatabaseInstance } from "./persistence/db.js";
import { migrateDb } from "./persistence/migrate.js";
import { FactoryStore } from "./persistence/store.js";
import { FactoryError } from "./executor/errors.js";
import {
  runExplicitRollback,
  runProductionDelivery,
  validateProductionUrl,
  validateWorkerName,
} from "./delivery/index.js";
import { runIntelligence } from "./intelligence/index.js";
import { runBlueprint } from "./blueprint/index.js";
import { runRoleEval } from "./evals/index.js";
import { resolveRepositoryRoot } from "./repo-root.js";
import type { DeploymentResult } from "@factory/contracts";
import pkg from "../package.json" with { type: "json" };

const USAGE = `Factory persistent control plane v${pkg.version}

Usage:
  pnpm factory site-task <task.json> [--idempotency-key <key>]
      Run one SiteTask through the persistent control-plane executor
  pnpm factory intelligence build <request.json> <research.json>
      Produce a Site Intelligence Plan from a validated request and research
      evidence bundle; emits one IntelligenceResult JSON document to stdout
  pnpm factory blueprint build <plan.json> <request.json> <research.json>
      Produce a SiteBlueprint from a validated SiteIntelligencePlan, request,
      and research evidence bundle through the Factory model gateway;
      emits one BlueprintResult JSON document to stdout
  pnpm factory db migrate
      Apply committed PostgreSQL migrations
  pnpm factory db check
      Verify PostgreSQL connectivity and schema state
  pnpm factory project create <key> <name>
      Create a Factory project boundary in PostgreSQL
  pnpm factory site register <key> --project <projectKey> --name <name>
      Register a site in PostgreSQL for task execution
  pnpm factory site delivery set <siteKey> --worker <workerName> --production-url <https://origin>
      Configure the provisioned Cloudflare delivery target for a site
  pnpm factory deploy <siteKey>
      Build accepted origin/main once, verify its version preview, then promote and verify production
  pnpm factory rollback <siteKey>
      Roll production back to an earlier Factory-verified Cloudflare version and verify it
  pnpm factory run show <runId>
      Inspect historical execution records and quality evidence
  pnpm factory
      Print this message

Example task: packages/contracts/fixtures/create-roof-repair.json
Run artifacts: .factory/runs/<runId>/ (gitignored)
Intelligence artifacts: .factory/intelligence/<runId>/ (gitignored)
Blueprint artifacts: .factory/blueprint/<runId>/ (gitignored)
Eval artifacts: .factory/evals/autonomy-v0/<runId>/ (gitignored)
`;

function printDeployment(result: DeploymentResult): void {
  console.log(`deploymentId:       ${result.deploymentId}`);
  console.log(`site:               ${result.siteId}`);
  console.log(`status:             ${result.status}`);
  console.log(`sourceCommit:       ${result.sourceCommit}`);
  console.log(`artifactDigest:     ${result.artifactDigest ?? "(not built)"}`);
  console.log(`versionId:          ${result.versionId ?? "(not uploaded)"}`);
  console.log(`previewUrl:         ${result.previewUrl ?? "(not uploaded)"}`);
  console.log(`productionUrl:      ${result.productionUrl}`);
  console.log(`previousVersionId:  ${result.previousVersionId ?? "(none)"}`);
  console.log(`previewVerified:    ${result.previewVerified}`);
  console.log(`productionVerified: ${result.productionVerified}`);
  console.log(`rolledBack:         ${result.rolledBack}`);
  if (result.error) console.error(`error:               [${result.error.code}] ${result.error.message}`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined) {
    console.log(USAGE);
    console.log(
      `Loaded example SiteTask from @factory/contracts: type=${exampleSiteTask.type} site=${exampleSiteTask.siteId} slug=${exampleSiteTask.page.slug}`,
    );
    return 0;
  }

  try {
    if (command === "db") {
      const sub = rest[0];
      if (sub === "migrate") {
        const config = resolveDatabaseConfig({ requireConfigured: true });
        const dbInst = createDatabaseInstance(config);
        try {
          const result = await migrateDb(dbInst.db);
          console.log(`DATABASE MIGRATION COMPLETE: applied from ${result.migrationsFolder}`);
          return 0;
        } finally {
          await dbInst.close();
        }
      }

      if (sub === "check") {
        const config = resolveDatabaseConfig({ requireConfigured: true });
        const dbInst = createDatabaseInstance(config);
        try {
          const res = await dbInst.pool.query("SELECT 1 as ok;");
          if (res.rows[0]?.ok === 1) {
            console.log("DATABASE OK");
            return 0;
          }
          console.error("DATABASE CHECK FAILED: query did not return expected value.");
          return 1;
        } finally {
          await dbInst.close();
        }
      }

      console.error(USAGE);
      return 2;
    }

    if (command === "project") {
      const sub = rest[0];
      if (sub === "create" && rest.length >= 3) {
        const key = rest[1]!;
        const name = rest.slice(2).join(" ");
        const config = resolveDatabaseConfig({ requireConfigured: true });
        const dbInst = createDatabaseInstance(config);
        try {
          const store = new FactoryStore(dbInst.db);
          const project = await store.createProject({ key, name });
          console.log(`PROJECT CREATED: key=${project.key} id=${project.id} name="${project.name}"`);
          return 0;
        } finally {
          await dbInst.close();
        }
      }
      console.error("Usage: pnpm factory project create <key> <name>");
      return 2;
    }

    if (command === "site") {
      const sub = rest[0];
      if (sub === "delivery" && rest[1] === "set") {
        const siteKey = rest[2];
        let worker = "";
        let productionUrl = "";
        for (let i = 3; i < rest.length; i++) {
          if (rest[i] === "--worker" && rest[i + 1]) worker = rest[++i]!;
          else if (rest[i] === "--production-url" && rest[i + 1]) productionUrl = rest[++i]!;
        }
        if (!siteKey || !worker || !productionUrl) {
          console.error("Usage: pnpm factory site delivery set <siteKey> --worker <workerName> --production-url <https://origin>");
          return 2;
        }
        const validatedWorker = validateWorkerName(worker);
        const validatedUrl = validateProductionUrl(productionUrl);
        const config = resolveDatabaseConfig({ requireConfigured: true });
        const dbInst = createDatabaseInstance(config);
        try {
          const site = await new FactoryStore(dbInst.db).setSiteDeliveryConfiguration({
            siteKey,
            cloudflareWorkerName: validatedWorker,
            productionUrl: validatedUrl,
          });
          console.log(`SITE DELIVERY CONFIGURED: key=${site.key} worker=${site.cloudflareWorkerName} production=${site.productionUrl}`);
          return 0;
        } finally {
          await dbInst.close();
        }
      }
      if (sub === "register") {
        let key = "";
        let projectKey = "default";
        let name = "";

        for (let i = 1; i < rest.length; i++) {
          const arg = rest[i]!;
          if (arg === "--project" && rest[i + 1]) {
            projectKey = rest[++i]!;
          } else if (arg === "--name" && rest[i + 1]) {
            name = rest[++i]!;
          } else if (!arg.startsWith("--") && !key) {
            key = arg;
          }
        }

        if (!key) {
          console.error("Usage: pnpm factory site register <key> --project <projectKey> --name <name>");
          return 2;
        }

        const config = resolveDatabaseConfig({ requireConfigured: true });
        const dbInst = createDatabaseInstance(config);
        try {
          const store = new FactoryStore(dbInst.db);
          const site = await store.registerSite({
            key,
            projectKey,
            name: name || `Site ${key}`,
          });
          console.log(`SITE REGISTERED: key=${site.key} id=${site.id} project=${projectKey} name="${site.name}"`);
          return 0;
        } finally {
          await dbInst.close();
        }
      }
      console.error("Usage: pnpm factory site register <key> --project <projectKey> --name <name>");
      return 2;
    }

    if (command === "deploy" && rest.length === 1) {
      const repoRoot = await resolveRepositoryRoot();
      const result = await runProductionDelivery({ repoRoot, siteKey: rest[0]! });
      printDeployment(result);
      return result.status === "verified" ? 0 : 1;
    }

    if (command === "rollback" && rest.length === 1) {
      const repoRoot = await resolveRepositoryRoot();
      const result = await runExplicitRollback({ repoRoot, siteKey: rest[0]! });
      printDeployment(result);
      return result.status === "rolled_back" ? 0 : 1;
    }

    if (command === "run") {
      const sub = rest[0];
      if (sub === "show" && rest[1]) {
        const runId = rest[1];
        const config = resolveDatabaseConfig({ requireConfigured: true });
        const dbInst = createDatabaseInstance(config);
        try {
          const store = new FactoryStore(dbInst.db);
          const details = await store.getRunDetails(runId);
          if (!details) {
            console.error(`Run '${runId}' not found in database.`);
            return 1;
          }

          console.log(`runId:        ${details.run.id}`);
          console.log(`project:      ${details.project.key} (${details.project.name})`);
          console.log(`site:         ${details.site.key} (${details.site.name})`);
          console.log(`status:       ${details.run.status}`);
          console.log(`baseCommit:   ${details.run.baseCommit || "(unresolved)"}`);
          console.log(`startedAt:    ${details.run.startedAt.toISOString()}`);
          console.log(`finishedAt:   ${details.run.finishedAt?.toISOString() ?? "(in progress)"}`);
          console.log(`durationMs:   ${details.run.durationMs ?? "(n/a)"}`);
          console.log(`attempts:     ${details.attempts.length}`);

          for (const att of details.attempts) {
            console.log(
              `  [Attempt ${att.attemptNumber}] kind=${att.kind} stage=${att.stage} status=${att.status}${att.classification ? ` classification=${att.classification}` : ""}${att.durationMs ? ` duration=${att.durationMs}ms` : ""}`,
            );
            for (const qr of att.qualityResults) {
              console.log(
                `    - Gate: ${qr.gate} passed=${qr.passed}${qr.summary ? ` summary="${qr.summary}"` : ""}${qr.artifactRef ? ` ref=${qr.artifactRef}` : ""}`,
              );
            }
            for (const mi of att.modelInvocations) {
              console.log(
                `    - Model: ${mi.provider}/${mi.runtime} status=${mi.status}${mi.durationMs ? ` duration=${mi.durationMs}ms` : ""}`,
              );
            }
          }

          return 0;
        } finally {
          await dbInst.close();
        }
      }
      console.error("Usage: pnpm factory run show <runId>");
      return 2;
    }

    if (command === "intelligence") {
      const sub = rest[0];
      if (sub === "build" && rest.length === 3) {
        const invocationDir = process.env.INIT_CWD ?? process.cwd();
        let requestRaw: string;
        let researchRaw: string;
        try {
          // Input paths are trusted operator CLI arguments; only the two
          // explicitly supplied files are read (no directory scans).
          requestRaw = await readFile(path.resolve(invocationDir, rest[1]!), "utf8");
          researchRaw = await readFile(path.resolve(invocationDir, rest[2]!), "utf8");
        } catch (err) {
          console.error(`error: [intelligence_input_invalid] ${err instanceof Error ? err.message : String(err)}`);
          return 1;
        }

        const repoRoot = await resolveRepositoryRoot();
        const result = await runIntelligence(
          { repoRoot, requestInput: requestRaw, researchInput: researchRaw },
          { onProgress: (message) => console.error(`intelligence: ${message}`) },
        );

        // Exactly one machine-readable IntelligenceResult document on stdout.
        console.log(JSON.stringify(result, null, 2));
        if (result.error) {
          console.error(`error: [${result.error.code}] ${result.error.message}`);
        } else {
          console.error(
            `intelligence: status=${result.status} runId=${result.runId} tasks=${result.taskCount} artifacts=${result.artifacts?.runDirectory ?? "(none)"}`,
          );
        }
        return result.status === "succeeded" ? 0 : 1;
      }
      console.error("Usage: pnpm factory intelligence build <request.json> <research.json>");
      return 2;
    }

    if (command === "blueprint") {
      const sub = rest[0];
      if (sub === "build" && rest.length === 4) {
        const invocationDir = process.env.INIT_CWD ?? process.cwd();
        let planRaw: string;
        let requestRaw: string;
        let researchRaw: string;
        try {
          // Input paths are trusted operator CLI arguments; only the three
          // explicitly supplied files are read (no directory scans).
          planRaw = await readFile(path.resolve(invocationDir, rest[1]!), "utf8");
          requestRaw = await readFile(path.resolve(invocationDir, rest[2]!), "utf8");
          researchRaw = await readFile(path.resolve(invocationDir, rest[3]!), "utf8");
        } catch (err) {
          console.error(`error: [blueprint_input_invalid] ${err instanceof Error ? err.message : String(err)}`);
          return 1;
        }

        const repoRoot = await resolveRepositoryRoot();
        const result = await runBlueprint(
          { repoRoot, planInput: planRaw, requestInput: requestRaw, researchInput: researchRaw },
          { onProgress: (message) => console.error(`blueprint: ${message}`) },
        );

        // Exactly one machine-readable BlueprintResult document on stdout.
        console.log(JSON.stringify(result, null, 2));
        if (result.error) {
          console.error(`error: [${result.error.code}] ${result.error.message}`);
        } else {
          console.error(
            `blueprint: status=${result.status} runId=${result.runId} pages=${result.pageCount} ready=${result.readyCount} blocked=${result.blockedCount} artifacts=${result.artifacts?.runDirectory ?? "(none)"}`,
          );
        }
        return result.status === "succeeded" ? 0 : 1;
      }
      console.error("Usage: pnpm factory blueprint build <plan.json> <request.json> <research.json>");
      return 2;
    }

    if (command === "eval") {
      const sub = rest[0];
      if (sub === "run") {
        const invocationDir = process.env.INIT_CWD ?? process.cwd();
        const args = rest.slice(1);
        const readOption = (flag: string): string | undefined => {
          const index = args.indexOf(flag);
          return index >= 0 ? args[index + 1] : undefined;
        };
        const role = readOption("--role");
        const requestPath = readOption("--request");
        const researchPath = readOption("--research");
        const planPath = readOption("--plan");
        if (!role || !requestPath || !researchPath) {
          console.error(
            "Usage: pnpm factory eval run --role <roleId> --request <request.json> --research <research.json> [--plan <plan.json>]",
          );
          return 2;
        }
        const readJsonFile = async (value: string): Promise<unknown> => {
          const raw = await readFile(path.resolve(invocationDir, value), "utf8");
          return JSON.parse(raw);
        };
        const repoRoot = await resolveRepositoryRoot();
        const result = await runRoleEval(repoRoot, {
          roleId: role as Parameters<typeof runRoleEval>[1]["roleId"],
          requestInput: await readJsonFile(requestPath),
          researchInput: await readJsonFile(researchPath),
          planInput: planPath ? await readJsonFile(planPath) : undefined,
          onProgress: (message) => console.error(`eval: ${message}`),
        });
        console.log(JSON.stringify(result, null, 2));
        return result.status === "succeeded" ? 0 : 1;
      }
      console.error(
        "Usage: pnpm factory eval run --role <roleId> --request <request.json> --research <research.json> [--plan <plan.json>]",
      );
      return 2;
    }

    if (command === "site-task") {
      let taskPath: string | undefined;
      let idempotencyKey: string | undefined;

      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]!;
        if (arg === "--idempotency-key" && rest[i + 1]) {
          idempotencyKey = rest[++i];
        } else if (!arg.startsWith("--") && !taskPath) {
          taskPath = arg;
        }
      }

      if (!taskPath) {
        console.error(USAGE);
        return 2;
      }

      const invocationDir = process.env.INIT_CWD ?? process.cwd();
      let raw: string;
      let taskInput: unknown;
      try {
        raw = await readFile(path.resolve(invocationDir, taskPath), "utf8");
        taskInput = JSON.parse(raw);
      } catch (err) {
        taskInput = {
          __unparseable: taskPath,
          __error: err instanceof Error ? err.message : String(err),
        };
      }

      const repoRoot = await resolveRepositoryRoot();
      const result = await runPersistedSiteTask(taskInput, {
        repoRoot,
        idempotencyKey,
      });

      console.log(`runId:        ${result.runId}`);
      console.log(`status:       ${result.status}`);
      console.log(`finalStage:   ${result.finalStage}`);
      console.log(`baseCommit:   ${result.baseCommit || "(unresolved)"}`);
      console.log(
        `attempts:     total=${result.totalAttempts}${result.successfulAttempt ? ` succeededOn=${result.successfulAttempt}` : ""}`,
      );
      console.log(`duration:     ${result.durationMs}ms`);
      console.log(`artifacts:    ${result.artifacts.runDirectory}`);
      if (result.changes) {
        console.log(`changedFiles: ${result.changes.changedFiles.join(", ") || "(none)"}`);
        console.log(`patch:        ${result.changes.patchPath ?? "(none)"}`);
      }
      if (result.qa) console.log(`qa:           passed=${result.qa.passed} exit=${result.qa.exitCode}`);
      if (result.taskVerification) {
        console.log(`verification: passed=${result.taskVerification.passed} — ${result.taskVerification.details}`);
      }
      if (result.error) {
        console.error(`error:        [${result.error.code}] ${sanitizeDatabaseUrl(result.error.message)}`);
      }

      return result.status === "succeeded" ? 0 : 1;
    }

    console.error(USAGE);
    return 2;
  } catch (err) {
    const code = err instanceof FactoryError ? err.code : "internal_error";
    const msg = sanitizeDatabaseUrl(err instanceof Error ? err.message : String(err));
    console.error(`error:        [${code}] ${msg}`);
    return 1;
  }
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
