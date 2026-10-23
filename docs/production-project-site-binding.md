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
