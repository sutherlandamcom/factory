# Factory Foundation v0 Independent Acceptance Report

**Auditor:** Independent Software Auditor & Architecture Engineer  
**Date:** 2026-08-29  
**Audited Baseline:** `3e2837070bc50ef42e9538222602390d5a1ead15`  
**Accepted Candidate SHA:** `e25f0520f7e3393a746e100665e9da633ea96d86`  
**Foundation Tag:** `foundation-v0`  
**Verdict:** **GO**

---

## 1. Executive Summary

An independent acceptance audit was performed on candidate commit `e25f0520f7e3393a746e100665e9da633ea96d86`. All acceptance checks were conducted in fresh disposable detached worktrees outside the primary development checkout, ensuring absolute preservation of user-owned working state.

All eight remediation findings from `docs/audits/factory-foundation-independent-audit.md` were independently reproduced, proven, and verified. Fresh Playwright browser installation passed in an isolated cache. Environment resolution for canonical origins and shell precedence was validated. The adversarial mutation test suite (7 structural mutations + cross-worktree collision regression) confirmed that the QA oracle fails closed with zero false passes.

The candidate commit satisfies all MVP Foundation requirements and is frozen as immutable tag `foundation-v0`.

---

## 2. Environment & System Details

- **OS / Kernel:** Darwin 25.3.0 (macOS)
- **Architecture:** x86_64
- **Node.js:** v22.22.3 (satisfies engines `>=22.12.0`)
- **pnpm:** 11.3.0
- **Astro:** ^5.1.0
- **Playwright:** 1.61.1

---

## 3. Clean Reproduction Command Matrix

All commands executed in a clean, detached worktree (`.worktree-acceptance`) at `e25f0520f7e3393a746e100665e9da633ea96d86`:

| Command | Exit Code | Result Summary |
|---------|:---------:|----------------|
| `pnpm install --frozen-lockfile` | **0** | Resolved and linked all 4 workspace packages cleanly |
| `pnpm factory` | **0** | CLI loaded example `SiteTask` (`/services/roof-repair`) |
| `pnpm check` | **0** | 3 of 3 projects checked (0 errors, 0 warnings, 0 hints) |
| `pnpm build` | **0** | 4 static pages built, 11 optimized WebP assets generated |
| `pnpm test` | **0** | 8/8 Playwright tests passed (desktop & mobile Chromium) |
| `pnpm qa` | **0** | Full pipeline (`check` → `build` → `test`) succeeded in 32s |
| `pnpm --filter @factory/contracts run check` | **0** | TypeScript contracts check passed (`tsc --noEmit`) |
| `pnpm --filter @factory/factory run check` | **0** | Control plane TypeScript check passed |
| `pnpm --filter @factory/site-starter run check` | **0** | Astro check passed (17 files, 0 errors) |
| `pnpm audit` | **0** | Zero known vulnerabilities found |
| `pnpm install --offline --frozen-lockfile` | **0** | Offline frozen install verified (494ms) |

Manifests, lockfile, and sources remained unmodified after testing.

---

## 4. Fresh Playwright Browser Reproduction

- **Isolated Browser Path:** `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers-acceptance`
- **Installation:** Executed `pnpm --filter @factory/site-starter exec playwright install chromium` downloading Chromium CFT 149.0.7827.55 and headless shell to temporary path.
- **Execution:** Plain `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers-acceptance pnpm test` executed and completed with **Exit Code 0** (8 passed).
- **Cleanup:** Temporary browser cache removed.

---

## 5. Canonical Origin & Configuration Verification

- **Configured Origin:** `PUBLIC_SITE_URL=https://example.invalid`
- **Build Output:** Inspected `sites/starter/dist/` HTML files.
- **Verified Fields:**
  - `/` (Home): `<link rel="canonical" href="https://example.invalid/">`, `og:url: https://example.invalid/`, JSON-LD url `https://example.invalid/`
  - `/services/example/`: `<link rel="canonical" href="https://example.invalid/services/example/">`, `og:url: https://example.invalid/services/example/`, JSON-LD url `https://example.invalid/services/example/`
  - `/blog/example/`: `<link rel="canonical" href="https://example.invalid/blog/example/">`, `og:url: https://example.invalid/blog/example/`, JSON-LD `@id: https://example.invalid/blog/example/`
  - `/404.html`: `<link rel="canonical" href="https://example.invalid/404/">`, `og:url: https://example.invalid/404/`
- **Precedence Verification:** Verified that shell variable `PUBLIC_SITE_URL` overrides `.env` file values, while `.env` file values override default `http://localhost:4321`.

---

## 6. Adversarial Mutation & Port Collision Matrix

Tested against disposable worktree derived from `CANDIDATE_SHA`:

| # | Injected Mutation / Fault | Target Component | Expected Result | Actual Result | Exit Code | Oracle Detection Point |
|---|---------------------------|------------------|:---------------:|:-------------:|:---------:|------------------------|
| **1** | Remove Homepage `<h1>` | `Hero.astro` | FAIL | **FAIL** | 1 | `expect(locator('h1')).toHaveCount(1)` failed (received 0) |
| **2** | Break Services Nav link (`/services/broken`) | `Header.astro` | FAIL | **FAIL** | 1 | `expect(page).toHaveURL(/\/services\/example\/?$/)` failed |
| **3** | Remove Service CTA Link | `services/example.astro` | FAIL | **FAIL** | 1 | `expect(locator).toBeVisible()` failed (`element(s) not found`) |
| **4** | Injected runtime `console.error` | `index.astro` | FAIL | **FAIL** | 1 | `assertNoPageErrors` failed (`MUTATION_4_INJECTED_ERROR`) |
| **5** | Break Blog Article Service Link | `blog/example.astro` | FAIL | **FAIL** | 1 | `expect(page).toHaveURL(...)` failed |
| **6** | Modify 404 Heading (`404` → `Missing Page`) | `404.astro` | FAIL | **FAIL** | 1 | `expect(locator('h1')).toHaveText("404")` failed |
| **7** | Force Content Canonicals to Root `/` | `Layout.astro` | FAIL | **FAIL** | 1 | `expect(canonical).toHaveAttribute("href", ...)` failed for `/services/example/` and `/blog/example/` |
| **8a** | Foreign server occupying port 4321 | Port 4321 | FAIL CLOSED | **FAIL** | 1 | `Error: http://localhost:4321 is already used` (`reuseExistingServer: false`) |
| **8b** | Dynamic Port Override (`FACTORY_QA_PORT=4322`) | Port 4322 | PASS | **PASS** | 0 | 8/8 tests passed against actual build on port 4322 |
| **8c** | Defect on Port 4322 while 4321 occupied | `Hero.astro` (no H1) | FAIL | **FAIL** | 1 | Caught missing H1 on port 4322 without false pass |
| **8d** | Invalid Port Numbers (0, 70000, "abc") | `playwright.config.ts` | FAIL CLOSED | **FAIL** | 1 | `Error: FACTORY_QA_PORT must be an integer between 1 and 65535` |

---

## 7. Deferred Items (P2 / P3)

No P0 (blockers) or P1 (material defects) remain.

| ID | Item | Severity | Description & PR #2 Recommendation |
|----|------|:--------:|-------------------------------------|
| P2-1 | `SiteTask` Runtime Validator | P2 | Runtime schema validation (using plain TypeScript validator function) will be implemented in PR #2 control plane entrypoint before dispatching to executor. |
| P2-2 | Mechanical Write Scope Enforcer | P2 | PR #2 executor must mechanically enforce that Codex only writes inside `sites/starter/src/**` and rejects changes to test specs or lockfiles. |
| P3-1 | Custom 404 JSON-LD | P3 | Optional metadata schema for 404 error page. |

---

## 8. Final Acceptance Verdict

**VERDICT: GO**

The tested candidate commit `e25f0520f7e3393a746e100665e9da633ea96d86` is approved and frozen under tag `foundation-v0`.
