# Factory Persistent Control Plane — Build & QA Handoff Report

## 1. Executive Summary

This report documents the design, implementation, testing, and operational validation of the **Factory Persistent Control Plane**.

The Persistent Control Plane establishes the first durable operational-state layer for Factory. It integrates a minimal, strongly typed PostgreSQL 18 persistence layer into the accepted execution architecture using **Drizzle ORM** and `node-postgres` (`pg`).

Factory execution is now **durable, inspectable, idempotent, single-writer concurrent-safe, and restart-safe**, while preserving 100% of the existing security boundaries, isolation model, quality gates, and bounded repair loop.

---

## 2. Baseline Verification

- **Baseline Commit**: `fbaea5d397a385462e1dcca4b73d39638b59e02b` (PR #2 merge commit).
- **Annotated Tag**: `factory-core-v0` created and pushed to origin pointing to `fbaea5d`.
- **Feature Branch**: `feat/persistent-control-plane` branched cleanly from `main`.

---

## 3. Persistence Architecture & Relational Schema

### 3.1 Relational Architecture

The persistence model defines exactly seven tables strictly aligned with Factory operational entities:

```
[projects]
   └── [sites] (unique: project_id + key)
          └── [runs] (unique: idempotency_key; foreign keys: project_id, site_id)
                 ├── [tasks] (foreign keys: run_id, site_id)
                 │      └── [attempts] (1..3 check constraint; foreign keys: run_id, task_id)
                 │             ├── [quality_results] (foreign key: attempt_id)
                 │             └── [model_invocations] (foreign key: attempt_id)
```

### 3.2 Key Constraints & Invariants

1. **Attempts Bounds**: `CHECK (attempt_number >= 1 AND attempt_number <= 3)` enforced mechanically at the database level.
2. **Non-negative Metrics**: `CHECK (duration_ms >= 0)` on runs, attempts, and model invocations; `CHECK (prompt_tokens >= 0 AND completion_tokens >= 0 AND total_tokens >= 0)` on model invocations.
3. **Idempotency**: `runs.idempotency_key` is uniquely indexed. Computed as `sha256("siteKey:baseCommit:canonicalTaskJson")`.
4. **Site Scoping**: `sites` enforces composite unique index `(project_id, key)`.
5. **Relational Cascade**: Foreign keys ensure referential integrity; deletion cascades cleanly.
6. **Separation of Operational State vs Artifacts**:
   - **PostgreSQL**: Stores operational lifecycle state, attempt records, timing, quality verdicts, model tokens/costs, error classifications, and relative directory references.
   - **Filesystem (`.factory/runs/<runId>/`)**: Stores large binary/text artifacts (patches, Git raw evidence, Playwright traces/screenshots, and task QA specs).

---

## 4. Drizzle ORM & Versioned Migrations

- **Drizzle ORM & Kit**: Pinned `drizzle-orm@0.45.2` and `drizzle-kit@0.31.10`.
- **Schema**: Strongly typed in `apps/factory/src/persistence/schema.ts`.
- **Migration Location**: `apps/factory/drizzle/0000_glorious_forgotten_one.sql` with version journal.
- **Migration Runner**: `migrateDb` in `apps/factory/src/persistence/migrate.ts` executes cleanly and idempotently.

---

## 5. Single-Writer Concurrency & Crash Recovery

### 5.1 Single-Writer Advisory Lock

- Active control plane execution acquires PostgreSQL session-level advisory lock `pg_try_advisory_lock(1428570001)` on a dedicated `pg.Client` connection.
- The connection is held throughout execution and released on cleanup.
- If another process attempts concurrent execution, it fails immediately with `control_plane_busy` and does not mutate state.

### 5.2 Crash & Restart Recovery

- When the control plane starts under the advisory lock, it runs `recoverStaleExecutionState`.
- Any runs, tasks, and attempts left in `running` state by a previous process crash/kill are updated to `interrupted` with `errorMessage = "control_plane_restart"`.
- Recovery does **not** auto-retry or generate Attempt 2; historical execution records are preserved accurately for post-mortem analysis.

---

## 6. Execution Core & Lifecycle Decoupling

- **Clean Decoupling**: `apps/factory/src/executor/run.ts` remains completely database-agnostic. It defines an optional `ExecutorLifecycleObserver` interface.
- **Observer Implementation**: `DatabaseLifecycleObserver` in `apps/factory/src/persistence/lifecycle.ts` translates execution events (`onAttemptStarted`, `onModelInvocation`, `onQualityGateEvaluated`, `onAttemptCompleted`) into atomic database writes.
- **Execution Driver**: `runPersistedSiteTask` in `apps/factory/src/persistence/driver.ts` orchestrates lock acquisition, crash recovery, site resolution, idempotency check, execution core delegation, and final terminal run recording.

---

## 7. Security & Secret Isolation

1. **Protected Module Policy**: `persistence` module is registered in `MODULE_REGISTRY` with `protected: true` and `ordinaryTaskWritable: false`. Ordinary AI tasks receive write authority only for their exact target page.
2. **Environment Scrubbing**: `FACTORY_DATABASE_URL`, `FACTORY_TEST_DATABASE_URL`, `DATABASE_URL`, and `PGPASSWORD` are stripped by the strict child process allowlist in `apps/factory/src/executor/env.ts`.
3. **Container Isolation**: Database credentials are never mounted or passed to the Colima QEMU VM or Docker worker container.
4. **Artifact / Report Scrubbing**: Database URLs and credentials are redacted from all failure reports, prompt excerpts, TaskResults, and CLI outputs.

---

## 8. CLI & Developer Experience

The Factory CLI (`apps/factory/src/index.ts`) supports:

```bash
# Database management
pnpm factory db check               # Check DB connection and readiness
pnpm factory db migrate             # Apply pending Drizzle SQL migrations

# Project and site provisioning
pnpm factory project create <key> <name>
pnpm factory site register <projKey> <siteKey> <siteName>

# Execution and inspection
pnpm factory site-task <task.json>  # Run persisted site task
pnpm factory run show <runId>       # Inspect run, attempts, quality gates, and model metrics
```

---

## 9. GitHub Actions CI Configuration

`.github/workflows/pr-ci.yml` is updated with:
- Ephemeral official PostgreSQL 18 service container (`postgres:18-alpine`).
- Health check via `pg_isready`.
- Test database environment `FACTORY_TEST_DATABASE_URL` exposed to the persistence test step.

---

## 10. Complete Test Matrix Execution Results

### 10.1 Persistence Integration Tests (`test:persistence`)

All 10 integration tests run against real PostgreSQL 18 and pass:

| # | Test Name | Result |
| --- | --- | --- |
| 1 | `attempts & constraints: attempt limit (1..3), unique attempts, and transaction rollback` | **PASSED** |
| 2 | `execution integration: happy path persists Run, Task, Attempt, QualityResults, ModelInvocation` | **PASSED** |
| 3 | `execution integration: scope violation terminal failure persists failed state without retry` | **PASSED** |
| 4 | `execution integration: bounded repair loop (Attempt 1 QA failure -> Attempt 2 success)` | **PASSED** |
| 5 | `execution integration: unregistered site fails closed before Codex` | **PASSED** |
| 6 | `idempotency: sequential and concurrent idempotency deduplication` | **PASSED** |
| 7 | `advisory lock: single-writer session lock blocks concurrent writer and releases cleanly` | **PASSED** |
| 8 | `recovery: stale running Run/Task/Attempt marked interrupted on restart without auto-attempt-2` | **PASSED** |
| 9 | `project & site: unique keys, composite constraints, and foreign keys` | **PASSED** |
| 10 | `schema & migrations: clean DB migration succeeds and is idempotent` | **PASSED** |

### 10.2 Factory Unit & Regression Tests (`pnpm test`)

- **Total Tests**: 99 tests
- **Passed**: 99 (100%)
- **Failed**: 0
- **Regressions**: 0

### 10.3 Full QA Pipeline (`pnpm qa`)

- **Check**: Typecheck passed on `@factory/contracts`, `sites/starter`, and `@factory/factory`.
- **Build**: Astro static site build succeeded.
- **Unit Tests**: 99 tests passed.
- **Playwright QA**: 8 passed, 2 skipped across desktop and mobile viewports.

---

---

## 11. Independent QA Remediation (PR #3 Targeted Fixes)

Following independent QA of the initial Persistent Control Plane implementation, three P1 findings were addressed in a targeted remediation:

### 11.1 P1-1 — Global Site Identity across Projects

- **Problem**: `sites` table enforced unique constraint only per-project `(project_id, key)`, allowing ambiguous site resolution for the globally-scoped `SiteTask.siteId`.
- **Remediation**:
  - `sites.key` made globally unique in PostgreSQL schema (`sites_key_unique` constraint via migration `0001_rapid_absorbing_man.sql`).
  - `findSiteByGlobalKey` enforces deterministic exact site lookup (returns `null` or exact unique record, fails closed on multiple).
  - Attempting to register an already-used site key under another project fails cleanly with `site_already_exists`.
  - Idempotency key generation incorporates globally unique site identity, ensuring distinct sites with identical payloads never collide.

### 11.2 P1-2 — Durable Idempotent TaskResult Reconstruction

- **Problem**: When `task-result.json` artifact was missing or corrupt, idempotent re-execution returned an unvalidated fallback with fake 0 attempts, violating contract and losing historical context.
- **Remediation**:
  - Re-execution checks durable PostgreSQL state as operational source of truth.
  - If `task-result.json` exists, it is parsed and validated with `taskResultSchema.safeParse` and cross-checked against DB truth.
  - If artifact is missing, malformed JSON, schema-invalid, or contradicts DB truth, `resolveDurableTaskResult` reconstructs the complete `TaskResult` graph (all attempts, classifications, timing, quality gates, and error details) purely from PostgreSQL state.
  - `successfulAttempt` derived accurately from the attempt that actually succeeded (or `null` if none).
  - Reconstructed `TaskResult` validated against `taskResultSchema` (fails closed with `persistence_state_invalid` on invalid state).

### 11.3 P1-3 — Advisory Lock PoolClient Leak on Error Paths

- **Problem**: In `acquireControlPlaneLock`, if the acquisition query threw an error or connection was busy, the checked-out `PoolClient` was not consistently released, risking pool exhaustion.
- **Remediation**:
  - Explicit client ownership transfer pattern with `try/finally` block.
  - Every checked-out `PoolClient` is guaranteed released exactly once unless transferred to the returned `ControlPlaneLockHandle`.
  - Acquisition query errors, busy lock failures, and unlock query exceptions all cleanly release the client back to the pool.
  - `lock.release()` is strictly idempotent.

---

## 12. Updated Complete Test Matrix

### 12.1 Persistence Integration Tests (`test:persistence`)

All 14 integration tests run against real PostgreSQL 18 and pass:

| # | Test Name | Result |
| --- | --- | --- |
| 1 | `attempts & constraints: attempt limit (1..3), unique attempts, and transaction rollback` | **PASSED** |
| 2 | `execution integration: happy path persists Run, Task, Attempt, QualityResults, ModelInvocation` | **PASSED** |
| 3 | `execution integration: scope violation terminal failure persists failed state without retry` | **PASSED** |
| 4 | `execution integration: bounded repair loop (Attempt 1 QA failure -> Attempt 2 success)` | **PASSED** |
| 5 | `execution integration: unregistered site fails closed before Codex` | **PASSED** |
| 6 | `idempotency: sequential and concurrent idempotency deduplication` | **PASSED** |
| 7 | `idempotency fallback: missing artifact reconstructs accurate multi-attempt TaskResult from DB` | **PASSED** |
| 8 | `idempotency fallback: malformed, invalid, or contradicting artifact yields to DB truth` | **PASSED** |
| 9 | `idempotency fallback: terminal failure run with missing artifact reconstructs failure details` | **PASSED** |
| 10 | `advisory lock: single-writer session lock blocks concurrent writer and releases cleanly` | **PASSED** |
| 11 | `advisory lock error paths: client release and leak-free ownership invariants` | **PASSED** |
| 12 | `recovery: stale running Run/Task/Attempt marked interrupted on restart without auto-attempt-2` | **PASSED** |
| 13 | `project & site: global site key uniqueness across projects and deterministic resolution` | **PASSED** |
| 14 | `schema & migrations: clean DB migration succeeds and is idempotent` | **PASSED** |

### 12.2 Factory Unit & Regression Tests (`pnpm test`)

- **Total Tests**: 99 tests
- **Passed**: 99 (100%)
- **Failed**: 0
- **Regressions**: 0

### 12.3 Full QA Pipeline (`pnpm qa`)

- **Check**: Typecheck passed across `@factory/contracts`, `sites/starter`, and `@factory/factory`.
- **Build**: Astro static site build succeeded.
- **Unit Tests**: 99 tests passed.
- **Playwright QA**: 8 passed, 2 skipped across desktop and mobile viewports.

---

## 13. Conclusion & Terminal Status

The Persistent Control Plane targeted remediation is complete, all 3 P1 QA findings are resolved and covered by adversarial tests, and all Factory regressions pass.

`PERSISTENT CONTROL PLANE REMEDIATION COMPLETE — PENDING INDEPENDENT QA`

