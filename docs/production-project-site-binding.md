# Trusted project/site configuration

Governed production requires one explicit `sites/starter/project-site-binding.json`
per isolated worktree. The existing `site-profile.json` remains rendering authority.
A domain proposed in Intake grants no delivery rights. Reading a workspace never
registers a site or chooses a destination.

An administrator must register the exact project/site and configure its destination
before enabling production. The versioned repository configuration has this shape:

```json
{
  "version": "project-site-binding-v1",
  "projectKey": "registered-project-key",
  "siteKey": "registered-site-key",
  "profileDigest": "<deterministicDigest of parsed SiteProfile>",
  "acceptedSiteIdentityDigest": "<deterministicDigest of exact accepted siteIdentity>",
  "delivery": {
    "workerName": "explicit-existing-worker",
    "productionUrl": "https://explicit-existing-target.example"
  }
}
```

Do not copy one project's binding into another project. The database site must
belong to the project and match both destination fields. Changes to the profile,
accepted identity, delivery destination or binding invalidate downstream authority;
rederive production inputs and repeat build/QA. Older records remain readable,
but their missing binding cannot be retroactively manufactured as historical proof.

Action destinations require accepted Intake `verificationState: VERIFIED` and a
supported safe URL, email or telephone. Internal routes must exist in the candidate
route set. Forms fail closed until a governed form capability exists. CTA text is
copied from exact accepted content and bound alongside destination and snapshot.

Sutherland's explicitly reviewed informational/no-action mode can be represented
by `informationalConversion: { acceptedInputDigest, reason }` in this trusted file.
It applies only to that exact accepted snapshot; arbitrary Intake prose cannot
activate the exception. There is no generated production binding in this repository:
real accepted inputs and delivery authorization must be supplied by the operator.

Historical reconciliation/rollback uses persisted target/version authority rather
than requiring newly accepted Intake to match an old deployment. An existing
binding still pins project/site/destination; when no file exists, recovery requires
one unambiguous, already registered project destination. It never provisions one.

The test harness writes bindings only inside disposable source-isolated copies,
using reserved `.example.test` targets. Fixture approvals authorize test mechanics,
not production publication or live provider evidence.

## Manual setup of a fresh project (e.g. Stark) in an isolated test worktree

This is a MANUAL operator task. There is no one-click automatic site
provisioning; none of these steps happen merely by opening the Dashboard or
inspecting a workspace.

1. Create a fresh Git worktree or copy of the repository (isolated working
   directory; never mutate another project's files).
2. Register the project and its site in the dedicated test/config database
   (project row + sites row with explicit `cloudflareWorkerName` and
   `productionUrl` — both must be exact; the registered delivery target must
   equal the binding to be written).
3. Accept Intake for the project (exact `siteIdentity`: names, `language`,
   canonical origin reserved for tests, e.g. `https://stark.example.test`).
   Sutherland/Stark must stay separate in names, languages and origins; a
   wrong-project profile fails closed at every production mutation.
4. Write `sites/starter/site-profile.json` (SiteProfile `v0` with
   `canonicalOrigin`, `language`, `navigation`) inside that worktree.
5. Compute the binding: `deterministicDigest` of the parsed SiteProfile and of
   the exact accepted `siteIdentity`, explicit `workerName` and
   `productionUrl` (same origin family as the profile; candidate preview
   preflight compares the candidate canonical URL with the registered target
   and rejects a mismatch), then write
   `sites/starter/project-site-binding.json` (`project-site-binding-v1`).
6. Verify with the isolated-regression suites (`e2e01-site-binding` unit +
   persistence) and only then exercise the production pipeline for that
   project. Any later change to profile, accepted identity, delivery target
   or binding invalidates derived authority and forces rederivation.

Sutherland's reviewed informational mode (step 5 alternative) applies only via
`informationalConversion` bound to its exact accepted snapshot.
