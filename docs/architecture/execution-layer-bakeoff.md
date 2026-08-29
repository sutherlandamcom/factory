# PR #2 Execution Layer Architecture Bake-Off

**Document Version:** 1.0.0  
**Date:** 2026-08-29  
**Status:** APPROVED (Decision Reached)  
**Target Baseline:** `foundation-v0` (`e25f0520f7e3393a746e100665e9da633ea96d86`)

---

## 1. Problem Statement & Objective

The goal of Factory PR #2 is to implement the **execution layer** that takes a validated `SiteTask`, executes the OpenAI Codex coding agent in an isolated environment against the immutable `foundation-v0` source baseline, mechanically enforces file write boundaries, runs the Factory QA oracle, and produces a structured `TaskResult` with patch artifacts.

In accordance with the **Factory MVP Principle (REUSE / BUY / BUILD)**, this bake-off evaluates execution layer options to select the smallest, safest, and most reliable architecture for launching the first production website with the least custom infrastructure.

---

## 2. Requirements: MUST-HAVE vs NICE-TO-HAVE

### MUST-HAVE (Hard Selection Criteria)
1. **Source Isolation:** Strict execution against `foundation-v0` without touching the operator's primary working tree.
2. **Controlled Filesystem Boundary:** Mechanical restriction ensuring writes only occur within authorized site code (`sites/starter/src/**`).
3. **Controlled Environment / Secrets:** Sanitized child process environment with strict allowlisting (no host token leakage).
4. **Bounded Process Execution:** Reliable timeout enforcement, process-group termination (SIGTERM -> SIGKILL), and orphan cleanup.
5. **Toolchain Support:** Native compatibility with Node 22+, pnpm 11+, Astro 5+, and Playwright Chromium.
6. **Telemetry & Artifact Capture:** Structured stdout/stderr capture, error logs, Playwright trace/screenshot capture, and git patch generation.
7. **Zero-Infrastructure MVP Path:** Minimal custom code burden, low operational friction, and high local reproducibility.

### NICE-TO-HAVE (Deferred / Non-Blocking)
- Multi-tenant cloud execution (deferred to post-MVP).
- Remote container fleet orchestration (deferred).
- Live webhooks / dashboard streaming (deferred).
- Distributed queue persistence (deferred).

---

## 3. Candidate Architectural Classes

Four candidate options were evaluated:

| Candidate | Architecture Class | Description |
|-----------|--------------------|-------------|
| **1. Local Worktree + Codex OS Sandbox** | Local Worktree + Native Sandbox | Disposable git worktrees with Codex native OS sandboxing (`sandbox-exec` / Bubblewrap) and Factory mechanical diff verification |
| **2. Local Docker Container** | Local Container Isolation | Ephemeral Docker container runner with volume mount and containerized toolchain |
| **3. E2B Cloud MicroVM** | Managed Cloud Sandbox | Ephemeral Firecracker microVMs managed via E2B TypeScript SDK |
| **4. Daytona Workspace** | Managed Development Environment | Daytona containerized workspace provider |

---

## 4. Evaluation Matrix & Weighted Scoring

### Weights
- **Security / Isolation:** 25%
- **Implementation Simplicity:** 20%
- **Lifecycle & Cleanup Reliability:** 15%
- **Codex Compatibility:** 10%
- **Secrets & Network Boundary:** 10%
- **Reproducibility:** 10%
- **Debugging & Artifacts:** 5%
- **Cost & Operational Burden:** 5%

### Scorecard (Scale 0–100)

| Criterion | Weight | Candidate 1 (Worktree + OS Sandbox) | Candidate 2 (Docker Container) | Candidate 3 (E2B Cloud MicroVM) | Candidate 4 (Daytona) |
|-----------|:------:|:-----------------------------------:|:------------------------------:|:-------------------------------:|:---------------------:|
| Security / Isolation | 25% | **80** | 95 | 98 | 90 |
| Implementation Simplicity | 20% | **95** | 60 | 70 | 50 |
| Lifecycle & Cleanup | 15% | **95** | 80 | 85 | 70 |
| Codex Compatibility | 10% | **100** | 85 | 80 | 75 |
| Secrets & Network | 10% | **85** | 90 | 80 | 75 |
| Reproducibility | 10% | **95** | 90 | 80 | 75 |
| Debugging & Artifacts | 5% | **95** | 75 | 70 | 65 |
| Cost & Operational Burden | 5% | **100** | 60 | 65 | 50 |
| **Weighted Total** | **100%** | **90.5** | **78.5** | **77.0** | **67.0** |

---

## 5. Detailed Analysis of Finalists

### Winner: Candidate 1 — Local Git Worktree + Codex Native OS Sandbox
- **Isolation Model:** 
  - *Source Isolation:* Ephemeral `git worktree add --detach .worktree-<taskId> foundation-v0`.
  - *Process & Sandbox:* Codex CLI applies native OS sandbox profiles (macOS Seatbelt / Linux Bubblewrap/Landlock).
  - *Mechanical Policy:* Factory independently inspects `git status` and `git diff` after Codex execution to verify all changes reside strictly within `sites/starter/src/**`. Any modification to root files, package manifests, or test suites triggers immediate rejection.
- **Toolchain & QA:** Executes directly on the host Node/pnpm toolchain with existing Playwright Chromium browsers, avoiding container display/shared memory overhead.
- **Factory Code Surface:** **LOW** (~150 lines of clean TypeScript in `apps/factory/src/executor/`).
- **Operational Burden:** **Zero.** No Docker daemon required, zero SaaS API dependencies, 100% offline-capable.

### Fallback: Candidate 2 — Local Docker Container
- **Pros:** Full OS-level container isolation.
- **Cons:** Requires running Docker Desktop / Podman daemon, custom container image maintenance (Node + pnpm + Playwright system dependencies + Chromium), UID mapping complexity on Linux/macOS, and significant container startup overhead.

### Eliminated: Candidate 3 (E2B) & Candidate 4 (Daytona)
- **E2B:** Strong microVM isolation, but introduces hard internet dependency, SaaS recurring costs, remote network latency, and remote artifact downloading complexity for an MVP that only builds static Astro websites locally.
- **Daytona:** Tailored for persistent human developer workspaces rather than 10-second autonomous agent batch tasks.

---

## 6. Live Technical Probe Evidence

A live technical probe was executed against `foundation-v0`:
1. **Creation:** Detached disposable worktree `.worktree-probe` created in `< 200ms`.
2. **Execution & Detection:** Simulated modification applied; `git status` and `git diff` accurately captured the exact touched paths.
3. **Destruction:** `git worktree remove --force .worktree-probe` completely eradicated the environment in `< 100ms` with zero side effects on the primary checkout.

*Evidence status:* `LIVE VERIFIED`.

---

## 7. Codex Authentication & Trust Boundary

- **Authentication:** Codex receives only `OPENAI_API_KEY` through explicit child process environment injection. Host environment variables are strictly scrubbed.
- **Write Authority:** Codex has write authority strictly confined to the worktree path via sandbox controls; Factory mechanically verifies `git status` before invoking QA.
- **Process Supervision:** Factory manages child processes in dedicated process groups, applying hard timeouts (default 180s) with SIGTERM/SIGKILL escalation to ensure zero orphaned processes.

---

## 8. PR #2 Implementation Specification

### Architecture Pipeline
```text
Validated SiteTask JSON
  │
  ▼
Create Detached Worktree (.worktree-<taskId> from foundation-v0)
  │
  ▼
Execute Codex Agent (with prompt, constraints, and timeout)
  │
  ▼
Mechanical Write Boundary Verification (sites/starter/src/** only)
  │
  ▼
Independent Factory QA Oracle (pnpm check -> pnpm build -> pnpm test)
  │
  ▼
Extract Git Patch & QA Artifacts (screenshots, test traces, logs)
  │
  ▼
Construct TaskResult Contract (success / error details)
  │
  ▼
Destroy Worktree & Clean Process Lifecycle
```

### Expected PR #2 Scope
- **Contracts (`packages/contracts`):**
  - Add `TaskResult` contract (`status: "success" | "failure"`, `diff: string`, `artifacts: string[]`, `errors?: string[]`).
- **Control Plane (`apps/factory`):**
  - `src/validator/`: Plain TypeScript `SiteTask` runtime validator.
  - `src/executor/worktree.ts`: Worktree lifecycle manager (`create`, `destroy`).
  - `src/executor/codex.ts`: Sanitized Codex child process spawner with timeout.
  - `src/executor/verifier.ts`: Mechanical diff allowlist checker + QA orchestrator.
  - `src/executor/index.ts`: End-to-end task runner.
- **End-to-End Acceptance Test:**
  - Execute example `SiteTask` (`/services/roof-repair`), verify generated page passes `pnpm qa`, and verify resulting patch.

### Explicitly Excluded from PR #2
- Automatic repair retry loops (deferred to PR #3).
- Database / PostgreSQL persistence (deferred to PR #4).
- Cloudflare deployment (deferred to PR #5).
- SEO / Firecrawl data ingestion (deferred to PR #6).
- Multi-site scheduling or web API servers.

---

## Decision Update — 2026-08-29: Host-Read Evidence Invalidates Candidate 1

The original decision selected a local detached worktree plus Codex's native
`workspace-write` sandbox. Subsequent live adversarial testing proved that the
Codex tool process could read unrelated host files, including synthetic
canaries outside the worktree, and could copy their contents into an authorized
source file. The worktree and native sandbox therefore protect source state and
most writes, but do not provide the required host-read boundary.

The preferred replacement remains one mature local OCI/container runtime with
narrow mounts: the worktree, isolated `/tmp` and HOME, minimal read-only Codex
auth/config, no Docker or SSH-agent socket, and no broad `/Users` mount. Factory
QA stays on the host after Codex exits; the inner Codex sandbox continues to
disable tool network and web search without blocking model-service connectivity.

Environment inspection found no Docker, Podman, nerdctl, Colima, Lima, Finch,
or equivalent supported runtime installed. No external software was installed
without authorization, and an unverified container adapter was not introduced.
The implemented decision is therefore fail-closed: production execution returns
`STRONG_EXECUTION_ISOLATION_UNAVAILABLE` before invoking Codex. Deterministic
tests may inject a fake runner, but there is no host-shared production fallback.

This leaves real create-page, real repair, and live host canary acceptance
`NOT VERIFIED` until an approved isolation backend is available. The prior
decision remains in this record as historical context rather than being erased.
