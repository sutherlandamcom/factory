---
reportVersion: "1.0.0"
runId: "RUN-13"
runName: "Governed Production Delivery vNext"
date: "2026-10-20T14:30:00+02:00"
repository: "sutherlandamcom/factory"
pullRequest:
  number: 47
  url: "https://github.com/sutherlandamcom/factory/pull/47"
  branch: "feat/run13-production-delivery-vnext"
  baseBranch: "main"
git:
  baseSha: "bc39a165ce6002cd8e51268bbfea42bcf76d282b"
  startSha: "23d14beabd1001a5199458270aa3862ca07623fe"
  targetSha: "67125ac8cb78dd8439df5728a3138b39a3f360ae"
verdict: "IMPLEMENTATION COMPLETE — PENDING INDEPENDENT QA"
governanceInvariants:
  - id: "INV-1"
    name: "No release without current publication-eligible QA"
    status: "VERIFIED"
    enforcedBy: "assertCandidateReleaseQaProof"
    errorCode: "delivery_qa_not_eligible"
  - id: "INV-2"
    name: "No approval without exact verified preview"
    status: "VERIFIED"
    enforcedBy: "GovernedDeliveryService.approveRelease"
    errorCode: "delivery_preview_unverified"
  - id: "INV-3"
    name: "No publication without current authenticated approval"
    status: "VERIFIED"
    enforcedBy: "GovernedDeliveryService.publishApprovedRelease"
    errorCode: "delivery_approval_missing"
  - id: "INV-4"
    name: "No release may substitute candidate, asset, route set or version"
    status: "VERIFIED"
    enforcedBy: "GovernedDeliveryService lineage checks & AuditSealKeyring"
    errorCode: "delivery_stale_identity"
  - id: "INV-5"
    name: "No replay, concurrency conflict or stale authority"
    status: "VERIFIED"
    enforcedBy: "PostgreSQL advisory locks (pg_try_advisory_xact_lock) & state machine"
    errorCode: "delivery_concurrency_conflict"
verificationSummary:
  typecheck: "PASS"
  build: "PASS"
  operatorSuite:
    passed: 145
    failed: 0
    durationMs: 273527
  persistenceSuite:
    passed: 363
    failed: 0
    durationMs: 1236414
  run13DeliverySuite:
    passed: 41
    failed: 0
    durationMs: 4561
  dashboardSuite:
    passed: 51
    failed: 0
    durationMs: 2178
  siteStarterSuite:
    passed: 35
    skipped: 35
    failed: 0
---

# Factory Macro Run 13: Governed Production Delivery vNext — Machine-Readable Build Report

## 1. Metadata and Handoff State

| Attribute | Specification |
| :--- | :--- |
| **Run** | Macro Run 13 |
| **Objective** | Governed Production Delivery vNext |
| **Lifecycle** | `Candidate -> Preview -> Human Approval -> Publish -> Production QA -> Rollback` |
| **PR** | [#47](https://github.com/sutherlandamcom/factory/pull/47) (`feat/run13-production-delivery-vnext`) |
| **Start SHA** | `23d14beabd1001a5199458270aa3862ca07623fe` |
| **Target SHA** | `67125ac8cb78dd8439df5728a3138b39a3f360ae` |
| **Base SHA** | `bc39a165ce6002cd8e51268bbfea42bcf76d282b` (`main`) |
| **Terminal Verdict** | `IMPLEMENTATION COMPLETE — PENDING INDEPENDENT QA` |

---

## 2. Invariant Verification Matrix

```json
[
  {
    "invariant": "INV-1: No release without current publication-eligible QA",
    "mechanism": "assertCandidateReleaseQaProof",
    "requiredConditions": {
      "schemaVersion": "production-v1",
      "trustMode": "STRICT_PRODUCTION",
      "publicationEligible": true,
      "overall": "PASS",
      "canonicalOrigin": "site.productionUrl"
    },
    "violationErrorCode": "delivery_qa_not_eligible",
    "httpStatus": 409,
    "testedIn": "apps/factory/tests/delivery-service.test.ts"
  },
  {
    "invariant": "INV-2: No approval without exact verified preview",
    "mechanism": "GovernedDeliveryService.approveRelease",
    "requiredConditions": {
      "deploymentStatus": "preview_verified",
      "previewVersionId": "matching exact active preview version",
      "previewVerified": true
    },
    "violationErrorCode": "delivery_preview_unverified",
    "httpStatus": 409,
    "testedIn": "apps/factory/tests/governed-delivery.test.ts"
  },
  {
    "invariant": "INV-3: No publication without current authenticated approval",
    "mechanism": "ReleaseApprovalBoundary.verifyApprovalForPublish",
    "requiredConditions": {
      "approvalExists": true,
      "isRevoked": false,
      "isSynthetic": false,
      "sealStatus": "SEALED",
      "hmacVerification": "VALID",
      "sessionPermission": "DEPLOYMENT:PUBLISH"
    },
    "violationErrorCode": "delivery_approval_missing / delivery_approval_invalid",
    "httpStatus": 409,
    "testedIn": "apps/factory/tests/release-approval.test.ts"
  },
  {
    "invariant": "INV-4: No release may substitute candidate, asset, route set or version",
    "mechanism": "GovernedDeliveryService.publishApprovedRelease",
    "requiredConditions": {
      "candidateId": "matches approved candidateId",
      "artifactDigest": "matches approved artifactDigest",
      "previewVersionId": "matches approved previewVersionId",
      "targetWorkerName": "matches approved targetWorkerName",
      "targetProductionUrl": "matches approved targetProductionUrl"
    },
    "violationErrorCode": "delivery_stale_identity",
    "httpStatus": 409,
    "testedIn": "apps/factory/tests/governed-delivery.test.ts"
  },
  {
    "invariant": "INV-5: No replay, concurrency conflict or stale authority",
    "mechanism": "PostgreSQL transaction & pg_try_advisory_xact_lock",
    "requiredConditions": {
      "advisoryLockAcquired": true,
      "stateMachineTransition": "preview_verified -> promoting -> promoted -> verified",
      "reconciliation": "drift check against Cloudflare worker active version"
    },
    "violationErrorCode": "delivery_concurrency_conflict / delivery_stale_identity",
    "httpStatus": 409,
    "testedIn": "apps/factory/tests/delivery-rollback.test.ts"
  }
]
```

---

## 3. Database Persistence and Schema Migrations

### Migration `0038_production_delivery_vnext.sql`
- **Location:** `apps/factory/drizzle/0038_production_delivery_vnext.sql`
- **Applied to:** PostgreSQL 18 container (`factory-ci-pg`)
- **Journal update:** `apps/factory/drizzle/meta/_journal.json`

### Table Definitions

#### `deployments` (Extended)
```sql
ALTER TABLE "deployments" ADD COLUMN "candidate_id" varchar(128);
ALTER TABLE "deployments" ADD COLUMN "qa_run_id" varchar(128);
ALTER TABLE "deployments" ADD COLUMN "release_approval_id" varchar(128);
ALTER TABLE "deployments" ADD COLUMN "candidate_routes" jsonb;
```

#### `release_approvals` (New Table)
```sql
CREATE TABLE IF NOT EXISTS "release_approvals" (
  "id" varchar(128) PRIMARY KEY NOT NULL,
  "project_id" varchar(64) NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "site_id" varchar(64) NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE,
  "candidate_id" varchar(128) NOT NULL,
  "qa_run_id" varchar(128) NOT NULL,
  "artifact_digest" varchar(64) NOT NULL,
  "preview_version_id" varchar(128) NOT NULL,
  "target_worker_name" varchar(128) NOT NULL,
  "target_production_url" text NOT NULL,
  "actor_id" varchar(128) NOT NULL,
  "actor_name" varchar(200) NOT NULL,
  "actor_role" varchar(64) NOT NULL,
  "session_id" varchar(128) NOT NULL,
  "is_synthetic" boolean DEFAULT false NOT NULL,
  "verification_seal" varchar(64),
  "seal_key_id" varchar(64) NOT NULL,
  "seal_status" varchar(32) DEFAULT 'SEALED' NOT NULL,
  "revoked" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "check_artifact_digest_len" CHECK (length(artifact_digest) = 64),
  CONSTRAINT "check_verification_seal_len" CHECK (verification_seal IS NULL OR length(verification_seal) = 64)
);
```

#### Immutability Trigger
```sql
CREATE OR REPLACE FUNCTION enforce_release_approval_immutability()
RETURNS trigger AS $$
BEGIN
  IF OLD.id != NEW.id OR
     OLD.project_id != NEW.project_id OR
     OLD.site_id != NEW.site_id OR
     OLD.candidate_id != NEW.candidate_id OR
     OLD.qa_run_id != NEW.qa_run_id OR
     OLD.artifact_digest != NEW.artifact_digest OR
     OLD.preview_version_id != NEW.preview_version_id OR
     OLD.target_worker_name != NEW.target_worker_name OR
     OLD.target_production_url != NEW.target_production_url OR
     OLD.actor_id != NEW.actor_id OR
     OLD.session_id != NEW.session_id OR
     OLD.verification_seal != NEW.verification_seal OR
     OLD.seal_key_id != NEW.seal_key_id OR
     OLD.created_at != NEW.created_at THEN
    RAISE EXCEPTION 'release_approvals rows are immutable; only revoked may be updated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

---

## 4. Operator API and Error Codes Matrix

| Route | Method | Payload / Contract | Success Status | Error Codes |
| :--- | :---: | :--- | :---: | :--- |
| `/api/projects/:id/deployment` | `GET` | `GovernedDeploymentView` | 200 | `not_found`, `delivery_service_unavailable` |
| `/api/projects/:id/deployment/preview` | `POST` | `{ candidateId: string }` | 200 | `validation_error`, `delivery_qa_not_eligible`, `delivery_stale_identity` |
| `/api/projects/:id/deployment/approve` | `POST` | `{ candidateId: string, previewVersionId: string, sessionToken: string }` | 201 | `validation_error`, `operator_permission_denied`, `delivery_preview_unverified`, `actor_unauthenticated` |
| `/api/projects/:id/deployment/publish` | `POST` | `{ candidateId: string, previewVersionId: string, approvalId: string, sessionToken: string }` | 200 | `validation_error`, `operator_permission_denied`, `delivery_approval_missing`, `delivery_stale_identity`, `delivery_verification_failed` |
| `/api/projects/:id/deployment/rollback` | `POST` | `{ sessionToken: string, targetVersionId?: string }` | 200 | `validation_error`, `operator_permission_denied`, `delivery_no_known_good_deployment`, `delivery_stale_identity` |

### Stable Operator Error Code Catalog
```typescript
OPERATOR_ERROR_STATUS = {
  invalid_json: 400,
  validation_error: 400,
  actor_unauthenticated: 401,
  session_revoked: 401,
  operator_permission_denied: 403,
  governed_site_requires_release_approval: 403,
  invalid_release_approval_seal: 403,
  permission_denied: 403,
  not_found: 404,
  deployment_not_found: 404,
  delivery_no_known_good_deployment: 404,
  delivery_target_unconfigured: 409,
  production_authority_stale: 409,
  preview_not_verified: 409,
  deployment_drift: 409,
  concurrent_deployment_in_progress: 409,
  delivery_qa_not_eligible: 409,
  delivery_preview_unverified: 409,
  delivery_approval_missing: 409,
  delivery_approval_invalid: 409,
  delivery_approval_revoked: 409,
  delivery_stale_identity: 409,
  delivery_concurrency_conflict: 409,
  delivery_service_unavailable: 501,
  delivery_verification_failed: 502,
  internal_error: 500,
}
```

---

## 5. Verification Execution Ledger

```json
{
  "testExecutionSummary": {
    "database": "PostgreSQL 18.0 (Alpine)",
    "databaseUrl": "postgresql://factory:factory_test_password@localhost:5432/factory_test",
    "nodeVersion": "v22.22.3",
    "pnpmVersion": "11.3.0",
    "suites": [
      {
        "suite": "Typecheck (All Packages)",
        "command": "pnpm run check",
        "scope": "@factory/contracts, @factory/factory, @factory/dashboard, @factory/site-starter",
        "result": "PASS",
        "diagnostics": "0 errors, 0 warnings"
      },
      {
        "suite": "Build (All Packages)",
        "command": "pnpm run build",
        "scope": "Vite production build, Astro 7 static build",
        "result": "PASS",
        "diagnostics": "Vite: dist/index.html 0.41kB; Astro: static routes generated"
      },
      {
        "suite": "Dashboard UI Contracts",
        "command": "pnpm --filter @factory/dashboard test",
        "tests": 51,
        "passed": 51,
        "failed": 0,
        "durationMs": 2178,
        "result": "PASS"
      },
      {
        "suite": "Operator Deployment API",
        "command": "pnpm --filter @factory/factory exec tsx --test tests/operator/operator-deployment-api.test.ts",
        "tests": 10,
        "passed": 10,
        "failed": 0,
        "durationMs": 1527,
        "result": "PASS"
      },
      {
        "suite": "Governed Delivery Integration & Persistence",
        "command": "FACTORY_TEST_DATABASE_URL=... pnpm --filter @factory/factory exec tsx --test tests/persistence/governed-delivery-persistence.test.ts tests/governed-delivery.test.ts tests/delivery-service.test.ts tests/delivery-rollback.test.ts tests/release-approval.test.ts",
        "tests": 41,
        "passed": 41,
        "failed": 0,
        "durationMs": 4561,
        "result": "PASS"
      },
      {
        "suite": "Full Operator Test Suite",
        "command": "FACTORY_TEST_DATABASE_URL=... pnpm --filter @factory/factory run test:operator",
        "tests": 145,
        "passed": 145,
        "failed": 0,
        "durationMs": 273527,
        "result": "PASS"
      },
      {
        "suite": "Full Persistence Test Suite",
        "command": "FACTORY_TEST_DATABASE_URL=... pnpm --filter @factory/factory run test:persistence",
        "tests": 363,
        "passed": 363,
        "failed": 0,
        "durationMs": 1236414,
        "result": "PASS"
      },
      {
        "suite": "Site Starter Unit Suite",
        "command": "pnpm --filter @factory/site-starter run test",
        "tests": 70,
        "passed": 35,
        "skipped": 35,
        "failed": 0,
        "result": "PASS"
      }
    ]
  }
}
```

---

## 6. Handoff Statement

All code changes have been validated against live PostgreSQL 18 persistence, compiled across all packages, verified with end-to-end regression test suites, committed to branch `feat/run13-production-delivery-vnext`, and pushed to remote `origin`.

**IMPLEMENTATION COMPLETE — PENDING INDEPENDENT QA**
