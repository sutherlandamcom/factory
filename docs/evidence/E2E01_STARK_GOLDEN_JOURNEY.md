# E2E-01 Stark golden journey

Classification: **FIXTURE_ONLY_NOT_PUBLICATION_AUTHORITY**.
Functional candidate: **`b44ec640706bb0a271ec1e6f6ca398f4449edb97`** (browser
17/17 re-verified at this SHA including this journey); earlier trace
artifacts below were captured at `794c3f48e6142ce4ffdebbd3e7c15b896a81fdb2`
and remain labeled with their capture SHA. No continuous Stark production
HTML, artifact digest or production QA PASS exists beyond the
genuine-evidence gate.

## Scope separation (mandatory reading)

1. **Genuine Stark fixture-mode operator journey** (below): real built
   Dashboard, real Operator API, real PostgreSQL persistence; every provider
   decision node (Search/Competitor/Writer/Design/Visual) explicitly runs in
   fixture mode and stays classified as evidence, never authority. This is
   the Tier-2 objective the brief defines — and it stops at the
   `design_approval_failed` boundary BY DESIGN.
2. **Isolated renderer fixture builds** (below): standalone Astro builds for
   Sutherland/Stark rendered from synthetic manifests. They test the
   renderer, navigation, sitemap and keyboard CTA mechanics only.
3. **Real-provider Stark production journey (Tier 3)**: NOT EXECUTED. It
   requires E2E-G01 (authorized live Russian SERP/Writer/Stitch/Visual pilot),
   E2E-G02 (authorized Cloudflare operations) and E2E-G03 (Stark legal/
   source approval). No stage of this tier has run; nothing in this report
   substitutes or seeds it.
4. **External approval/source requirements** (below, unchanged): exact human
   approvals and primary documents per gate definitions restored in the
   issue register.

## Executed operator journey

The built Dashboard → actual Operator API → migrated isolated PostgreSQL
`factory_test` journey creates a new Russian/Russia project, accepts Intake,
runs fixture Search/competitor/gap acceptance, approves writer policy/brief/exact
prompt, accepts fixture content, uploads/approves/assigns illustrative imagery,
accepts explicitly fixture design, resolves and accepts a visual set, freezes
design and accepts disabled derivatives. All provider evidence stays fixture.

Search hypothesis: `модернизация производства инженерные решения`.
Effective targeting: `ru` / `Russia`, derived from exact accepted Intake.
Accepted CTA: `Обсудить производственную задачу`. Explicit test destination:
`https://contact.stark.example.test/discuss`, verificationState VERIFIED.
No unsupported personnel percentages or RusSilica responsibility claims are used.

The test configures an isolated project/site profile and test target without
seeding or relabelling any provider authority. Production preparation rejects
with the actual response below, proving the fixture-to-production boundary
after configuration succeeds. The QA ledger records the full browser suite
verdict separately; a passing fixture-boundary test is not full production E2E.

Project: `601f8712-6659-42e8-ad18-971dee7a7b11`.

## Durable traceability

```json
{
  "1. Accepted Intake": {
    "snapshotId": "ea90a3e6-7f4d-432c-8ab5-5337916bd2f4",
    "version": 1,
    "digest": "7f60cb73c3ad495e4f1caa9f90e2d7b34b8988844d8e5df16147523184305437"
  },
  "2. Search run": {
    "id": "16849466-4d50-4ce8-846d-1928a4c7a05b",
    "provider": "fixture",
    "query": "модернизация производства инженерные решения"
  },
  "3. Writer policy": {
    "id": "wpol-8247a218-7c38-47ec-89fe-a9806b7989c7",
    "version": 1,
    "digest": "9272d7eedc468eb3d30e0b9851742f27570b34b6aa8797196afe2c768f53409c",
    "lineage": {
      "acceptedInputSnapshotId": "ea90a3e6-7f4d-432c-8ab5-5337916bd2f4",
      "acceptedInputSnapshotVersion": 1,
      "acceptedInputDigest": "7f60cb73c3ad495e4f1caa9f90e2d7b34b8988844d8e5df16147523184305437"
    }
  },
  "4. Writer brief": {
    "id": "wbrf-101b0b77-f29e-4556-9822-ebff1bb876a7",
    "version": 1,
    "digest": "4d4e29997b56c4e5fc6d4323e72d22a1f9c8b577c9dc538e0e7cc1d54b7f6ea9",
    "lineage": {
      "gapSnapshotId": "5d1cd77f-a33c-460a-af3d-5d2784feff41",
      "writerPolicyId": "wpol-8247a218-7c38-47ec-89fe-a9806b7989c7",
      "gapSnapshotDigest": "0d623917a660c401768406dd2a0b73aa1f028fc26caad05f563b438c8f22ecd7",
      "gapSnapshotVersion": 1,
      "writerPolicyDigest": "9272d7eedc468eb3d30e0b9851742f27570b34b6aa8797196afe2c768f53409c",
      "acceptedInputDigest": "7f60cb73c3ad495e4f1caa9f90e2d7b34b8988844d8e5df16147523184305437",
      "writerPolicyVersion": 1,
      "acceptedInputSnapshotId": "ea90a3e6-7f4d-432c-8ab5-5337916bd2f4",
      "acceptedInputSnapshotVersion": 1
    }
  },
  "5. Writer snapshot": {
    "id": "wsnp-dc2c85cb-5484-48bf-93e8-fc47745b693f",
    "version": 1,
    "digest": "c5026562158c61060a721371841b9d01705b927a68989ae5395077d0596f87da",
    "briefId": "wbrf-101b0b77-f29e-4556-9822-ebff1bb876a7",
    "briefVersion": 1,
    "briefDigest": "4d4e29997b56c4e5fc6d4323e72d22a1f9c8b577c9dc538e0e7cc1d54b7f6ea9"
  },
  "6. Writer proposal": {
    "id": "wprp-29b6bf1f-cb54-4d31-80a1-52f68654963b",
    "snapshotId": "wsnp-dc2c85cb-5484-48bf-93e8-fc47745b693f",
    "version": 1,
    "digest": "588aa4c4a1a7759ec86121fb20ff50d6cf576bda71226a4f9ddb0e1e7594ba44",
    "provider": "fixture",
    "snapshotVersion": 1,
    "snapshotDigest": "c5026562158c61060a721371841b9d01705b927a68989ae5395077d0596f87da"
  },
  "7. Writer accepted": {
    "id": "wacc-a4ad4ece-ae6c-45ba-b3b5-f8c963a915bd",
    "version": 1,
    "digest": "2ef3c5bc28bc0bc9753b58f5cea4bc8521545371328f55d58483d8ca0dc44164",
    "proposalId": "wprp-29b6bf1f-cb54-4d31-80a1-52f68654963b",
    "proposalDigest": "588aa4c4a1a7759ec86121fb20ff50d6cf576bda71226a4f9ddb0e1e7594ba44",
    "qaReportDigest": "fcae91244a157be431430a75b847f0a067df1b0717e03f67991e2bfed28f935a"
  },
  "8. Asset assignment": {
    "id": "apa-a07f0ccb-9f47-4fd5-b5d8-7228ed8cece4",
    "versionId": "asv-d3d84dcb-b63b-48ca-b2f7-075b8537cbf6",
    "versionNumber": 1,
    "versionDigest": "6ca9f0ae0094f45cc1cffe2a8585d1fc227d2a8192e29310db2876903dbf9fe2",
    "binaryDigest": "953010b8df0b809aaaabeaf4eb0f9541ccc0d2a6f8a08b3d502b5bfb882d9975",
    "acceptedPageContentId": "wacc-a4ad4ece-ae6c-45ba-b3b5-f8c963a915bd",
    "acceptedPageContentVersion": 1,
    "acceptedPageContentDigest": "2ef3c5bc28bc0bc9753b58f5cea4bc8521545371328f55d58483d8ca0dc44164",
    "assetId": "asst-f07dec0c-0dd5-454a-a3d8-7df8461306c5"
  },
  "9. Asset assignment": {
    "id": "apa-2dd95793-f895-4e90-adf4-85440ac1b9e3",
    "versionId": "asv-586f135c-1cd1-4e16-a468-2dd19c57a580",
    "versionNumber": 1,
    "versionDigest": "ebc49ebc491b4f22a3819895b9e9fc97c3c0e4bdd98d89a876130668e6582f07",
    "binaryDigest": "230c2b691dcb99f7c7633b2b78fa72f8fe02e6b2785df2a6e9b3e71cdd9fb3de",
    "acceptedPageContentId": "wacc-a4ad4ece-ae6c-45ba-b3b5-f8c963a915bd",
    "acceptedPageContentVersion": 1,
    "acceptedPageContentDigest": "2ef3c5bc28bc0bc9753b58f5cea4bc8521545371328f55d58483d8ca0dc44164",
    "assetId": "asst-ee91635f-fb5d-4ca8-8aa0-90e6ba1bb22b"
  },
  "10. Accepted design": {
    "id": "dsac-1f377dda-d32a-4a9b-90f8-19543bbc6afc",
    "version": 1,
    "candidateId": "dsn-122e74e1-1225-4a3b-822b-0c8c93e54948",
    "candidateDigest": "1fe7c83ebb6aad29fa0712f6134bac2b30349675d1ceb1ed25581c2a24003fc3",
    "inputSnapshotId": "dsi-571d8954-cd78-45ab-ae85-2a47aa5aeab4",
    "inputSnapshotVersion": 1,
    "inputDigest": "021d9df9dca5fa10e150bbb1a6f62b1632c4997f85345f04cfe0f94db690769d",
    "provider": "google-stitch",
    "providerMode": "fixture"
  },
  "11. Accepted visual set": {
    "id": "avs-7ba2befa-7181-4591-8d30-837b38d977d3",
    "version": 1,
    "setDigest": "2aaac36ad75f254fa237bb20d5a13c3982c59e39c8b3af3a32bfc359b2e5705f",
    "providerMode": "fixture",
    "slots": [
      {
        "slot": "hero-primary.homepage",
        "pageSlug": "homepage",
        "role": "hero",
        "versionId": "asv-586f135c-1cd1-4e16-a468-2dd19c57a580",
        "resolutionMode": "ai_generate",
        "truthClass": "illustrative",
        "providerConsumed": true,
        "visualProviderConsumedSourceAsset": false,
        "visualProviderProducedAsset": true,
        "designProviderReferencedFinalAsset": true,
        "designProviderConsumedFinalAsset": false
      }
    ]
  },
  "12. Derivative set (disabled)": {
    "id": "derivative_set_56cfe85c-90fb-4825-b450-0c2a1256d5af",
    "version": 1,
    "digest": "40bc5dc9a31e6e35797c69e5c9a7c16bcf5232f235f0d8a1ccb035388cb17af0"
  }
}
```

Actual production-preparation rejection:

```json
{
  "error": {
    "code": "design_approval_failed",
    "message": "Test fixture acceptance is never production design authority."
  }
}
```

Local full trace: `.factory/e2e01/stark-browser/traceability.json`. These
runtime files are inspection evidence, not durable approval authority.

## Separate renderer evidence

The following build evidence is independent of the accepted operator chain.
It must never be joined to that chain as a production candidate.

```json
{
  "classification": "SYNTHETIC_RENDERER_FIXTURE_NOT_PUBLICATION_AUTHORITY",
  "projectKey": "sutherland",
  "profile": {
    "version": "v0",
    "siteId": "sutherland",
    "siteName": "Sutherland Private Office",
    "canonicalOrigin": "https://sutherlandam.com",
    "language": "en",
    "navigation": [
      {
        "label": "Home",
        "targetSlug": "/"
      },
      {
        "label": "Contact",
        "targetSlug": "/contact"
      }
    ]
  },
  "bindingDigest": "d64e8fe8b88e9f3692adb9a8eeae6b2e4407f5192a6b76bf7742691a28a1ec88",
  "manifestDigests": [
    "63c96cd54b3dca3e69ab2316eb6d60d6545c034020441b87c06b0ae0b46466ce",
    "be8718431a6e2d48f46a0681f12e6ec36eceee8b13214b3cd92e0037c35db01c"
  ],
  "repositorySha": "794c3f48e6142ce4ffdebbd3e7c15b896a81fdb2",
  "sourceWorkingTreeClean": true,
  "artifactDigest": "8e55250a44e66fdc8477115bdc36771a8068d3ed95efd3d8c625d9343f5fa057",
  "htmlPath": "/Users/startupery/Documents/factory-girl/.factory/e2e01/renderer/sutherland/dist/index.html",
  "rendererAssertions": "PASS",
  "keyboardNavigation": "/contact",
  "productionQaVerdict": "NOT_RUN_FIXTURE_ONLY"
}
```

```json
{
  "classification": "SYNTHETIC_RENDERER_FIXTURE_NOT_PUBLICATION_AUTHORITY",
  "projectKey": "stark",
  "profile": {
    "version": "v0",
    "siteId": "stark",
    "siteName": "Stark Engineering",
    "canonicalOrigin": "https://stark.example.test",
    "language": "ru-RU",
    "navigation": [
      {
        "label": "Home",
        "targetSlug": "/"
      },
      {
        "label": "Contact",
        "targetSlug": "/contact"
      }
    ]
  },
  "bindingDigest": "0fbcaeb675245ea01f6eb3d6a4b64bebc05d0978d42f92787a6d677a67ee07d3",
  "manifestDigests": [
    "952d30c4828d854bcf868f09f817b4dfe03b05bd6122956c86e7ae1924bf0f45",
    "0920fbad49f330f86a23ddbd1359cea06a1d946a393ab2d0cfeb9396fa0c352a"
  ],
  "repositorySha": "794c3f48e6142ce4ffdebbd3e7c15b896a81fdb2",
  "sourceWorkingTreeClean": true,
  "artifactDigest": "eac5b94b921c67511109d66c799fd58c682adf5ed5e911f0349aea5630c3c41b",
  "htmlPath": "/Users/startupery/Documents/factory-girl/.factory/e2e01/renderer/stark/dist/index.html",
  "rendererAssertions": "PASS",
  "keyboardNavigation": "/contact",
  "productionQaVerdict": "NOT_RUN_FIXTURE_ONLY"
}
```

## Persisted Search acquisition identity

A read-only inspection of the validated dedicated `factory_test` database captured the actual row after the UI journey. No product authority was changed by this inspection.

```json
{
  "classification": "FIXTURE_ONLY_NOT_PUBLICATION_AUTHORITY",
  "repositorySha": "794c3f48e6142ce4ffdebbd3e7c15b896a81fdb2",
  "rows": [
    {
      "id": "16849466-4d50-4ce8-846d-1928a4c7a05b",
      "project_id": "601f8712-6659-42e8-ad18-971dee7a7b11",
      "accepted_input_snapshot_id": "ea90a3e6-7f4d-432c-8ab5-5337916bd2f4",
      "accepted_input_version": 1,
      "accepted_input_digest": "7f60cb73c3ad495e4f1caa9f90e2d7b34b8988844d8e5df16147523184305437",
      "query": "модернизация производства инженерные решения",
      "location": "Russia",
      "language": "ru",
      "device": "desktop",
      "provider": "fixture",
      "request_context": {
        "language": "ru",
        "location": "Russia",
        "policyVersion": "search-context-v1",
        "languageSource": "accepted_input",
        "locationSource": "accepted_input"
      },
      "request_digest": "8511cc3280eddb4df9de24874c31db7c26bd3e08453316182f61bcd462e42808",
      "status": "succeeded"
    }
  ]
}
```

The preserved artifact digest is recomputed after replacing its directory and
asserted equal to the exact tested build. HTML is retained locally at each
reported absolute path. Both routes verify language, brand, canonicals, JSON-LD,
sitemap, configured navigation and exact CTA text/destination; Chromium Enter
activation reaches `/contact`. `NOT_RUN_FIXTURE_ONLY` is the actual production
QA verdict for these renderer fixtures, not PASS.

## External boundary (restated with gate definitions)

Proceeding beyond this report requires, in order:

1. **E2E-G01** — Real Russian SERP, Writer, Stitch and Visual provider
   execution (behavior AND cost), through an explicitly authorized live
   provider pilot with actual evidence. Fixture/mock/synthetic providers do
   NOT close this.
2. **E2E-G02** — Real Cloudflare preview, production and rollback executed at
   the correct route/target under authorized controlled deployment and a
   verified domain/worker binding. Local simulated-wrangler control flow
   (17/17 browser suite) does NOT close this.
3. **E2E-G03** — Stark legal, brand, client, intellectual-property,
   photography and claim authority, via primary documents and legitimate
   human approval. In particular, the personnel-experience percentage and
   any RusSilica project responsibility attribution (P1-06) stay excluded
   from production-approved content until their primary source and
   publication permission are independently verified.
4. Genuine live accepted design/visual authority bound to an authorized
   project/site (`project-site-binding-v1` with a real delivery target), new
   production inputs/candidate and successful mandatory candidate QA.

Additionally, configuring a FRESH Stark site remains an operator-manual task
(isolated worktree + reserved `.example.test` origin + `site-profile.json` +
registered project/site + `sites/starter/project-site-binding.json`); no
automatic one-click provisioning exists and none is claimed. Workspace
inspection never provisions a target.

No paid provider call, deployment, production database operation or merge was
performed. Producer/consumer/contracts/store validation mappings are preserved
in the remediation summary.
