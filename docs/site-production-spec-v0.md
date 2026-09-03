# Site Production Spec v0 — Production Input Contract

## 1. Why This Layer Exists

The first real-site experiment proved that Factory's autonomous execution mechanics operate reliably:
- **Execution pipeline**: works (clean worktrees, bounded attempt loops, error recovery).
- **Write authority**: works (strict scoping to authorized page routes, fail-closed enforcement).
- **Deterministic QA**: works (typecheck, build, Playwright, SEO governance).
- **Business-truth transport**: improved through `contentBrief`.

However, the experiment revealed a critical missing layer in the pipeline:
- **Visual quality was insufficient**: generic card-grid layouts, lack of art direction, template clichés.
- **Editorial quality was insufficient**: promotional phrases, vague institutional adjectives ("calm", "editorial") that gave workers no actionable visual or typographic boundary.
- **Page-specific production direction was insufficient**: no structured way to prescribe hero compositions, reference layouts, anti-references, or approved photography.

The core lesson from the first build: **correct execution != high-quality site**.

A coding agent given only page names and content points will default to generic framework starter patterns. The **Site Production Spec v0** provides the missing deterministic, versioned production-input model that defines *how* an accepted blueprint must be produced before a worker generates code.

---

## 2. Architecture Ownership Boundaries

The Site Production Spec is **NOT** an alternative source of business truth. The system maintains strict separation of concerns across lifecycle stages:

| Stage / Artifact | Authoritative Responsibility | What It Owns | What It MUST NOT Own |
| :--- | :--- | :--- | :--- |
| **Discovery / Evidence** | Factual truth | Observed metrics, competitor data, verbatim operator facts | Site structure, layout, styling |
| **Intelligence** | Strategic implications | Market positioning, keyword clusters, target topics | Final copy, page components |
| **Site Blueprint** | Information Architecture & Business Intent | Page inventory, audience, page purpose, conversion goals, prohibited claims, accepted section key points | Visual aesthetics, asset licenses, CSS rules, reference screenshots |
| **Site Profile** | Deployable site identity & shell configuration | Site name, canonical origin, BCP47 language, header navigation, address | Page content, visual art direction |
| **Site Production Spec** | **Production overlay: HOW the blueprint is produced** | Quality bar, visual direction, reference library, anti-references, approved assets, SEO targeting, ordered production sections, CTA implementation | Positioning statements, business claims, new pages outside blueprint |
| **Site Task** | One bounded mutation unit | Target slug, isolated file path, single-page execution scope | Cross-page architecture, site-level governance |

---

## 3. Data Flow

```text
Discovery / Evidence (facts)
        ↓
Site Intelligence (strategy)
        ↓
Accepted Site Blueprint (IA & business truth)
        +
Site Profile (shell configuration & identity)
        +
Site Production Spec (production overlay)
        ↓
──────────────────────────────────────────────────────────────
Deterministic Semantic Validation (validateSiteProductionSpec)
        ↓
Objective Readiness Evaluation (evaluateSiteReadiness)
        ↓ (only if status === "READY")
Bounded Page Production Packet Compiler (compilePageProductionPacket)
        ↓
Future Factory Executor (SiteTask create_page)
──────────────────────────────────────────────────────────────
```

---

## 4. Reference Semantics

Workers run in network-isolated execution environments. The reference system distinguishes metadata from inspectable material:

1. **`REFERENCE_METADATA_ONLY`**:
   - Contains a `sourceUrl` with learning/avoidance notes and dimension tags (e.g., layout, typography).
   - Valid for informational and strategic context.
2. **`REFERENCE_LOCALLY_INSPECTABLE`**:
   - Contains a verified `localArtifactPath` pointing to a file on disk (e.g., screenshot, layout diagram).
   - When a page brief declares `localVisualReferenceRequired: true`, at least one assigned reference must be locally inspectable on disk.
3. **Anti-References**:
   - References with `role: "anti_reference"` define explicit negative design controls (e.g., "generic SaaS landing page", "floating glassmorphism cards", "cartoon isometric illustrations").

---

## 5. Asset Semantics & Rights Governance

Assets assigned for site production are strictly governed to avoid accidental copyright infringement or placeholder leakage:

### Usage Status
- **`approved`**: Cleared for public production generation.
- **`reference_only`**: For internal visual/moodboard guidance only. Prohibited from being assigned as a production page asset.
- **`blocked`**: Prohibited from all production usage (e.g., unverified origin, copyright concern).

### Rights Status
- **`operator_owned`**: Intellectual property owned by the site operator.
- **`licensed`**: Valid commercial web license secured.
- **`public_domain`**: Public domain / CC0 cleared.
- **`unknown`**: Rights unverified. **Readiness fails closed (BLOCKED)** if an asset with `unknown` rights is assigned to a production page.

### Path Safety
Asset and reference local paths must be safe relative POSIX paths:
- No absolute paths (`/etc/passwd`).
- No path traversal (`../`).
- No backslashes (`\\`).
- Resolved against an explicit input root with realpath symlink containment protection.

---

## 6. Quality Semantics: Production Instructions, Not Fake Scores

The creative quality bar:
- Defines explicit **`mustFeelLike`** and **`mustNotFeelLike`** constraints.
- Replaces vague adjectives ("calm", "premium") with actionable directives and concrete anti-patterns.
- **Does not attempt subjective scoring**: Factory does not compute artificial metrics like `DESIGN_SCORE = 92`.
- Readiness evaluates **objective, deterministic conditions** (missing CTA, absent SEO keyword, missing asset file, unknown rights status). Aesthetic acceptance remains senior human/operator review.

---

## 7. Representative Generic JSON Example

```json
{
  "version": "v0",
  "siteId": "meridian-advisory",
  "sourceBlueprint": {
    "runId": "20260901T120000Z-abcd1234",
    "digest": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  "creativeDirection": {
    "qualityBar": {
      "mustFeelLike": [
        "prestigious boutique financial institution",
        "calm high-conviction editorial journal",
        "restrained Swiss financial typography with generous margins"
      ],
      "mustNotFeelLike": [
        "generic SaaS landing page with pill badges and gradient buttons",
        "mass-market template with floating cards",
        "cluttered commercial broker listing portal",
        "AI-generated marketing brochure"
      ]
    },
    "editorial": {
      "rules": [
        "assert data-backed conclusions before operational implications",
        "restrained declarative copy without marketing hyperbole",
        "active institutional voice with numerical precision"
      ],
      "avoid": [
        "hollow buzzwords (world-class, bespoke synergies, cutting-edge)",
        "unsubstantiated league table claims",
        "generic luxury cliches"
      ]
    },
    "layout": {
      "principles": [
        "asymmetric executive summary block in first viewport",
        "spacious single-column narrative pacing paired with clear financial data blocks",
        "strict hairline dividers separating thematic modules"
      ],
      "avoid": [
        "three-card icon grids",
        "glowing neon borders and glassmorphism cards",
        "infinite logo carousels"
      ]
    },
    "typography": {
      "direction": "Editorial serif headlines with disciplined tracking paired with crisp neo-grotesque sans-serif body; high contrast between hero scale and reading text.",
      "avoid": ["rounded geometric sans", "all-caps body text", "script fonts"]
    },
    "color": {
      "direction": "Deep navy foundation (#0d1b2a) with warm bone paper backdrop (#f7f5f0) and subtle slate border accents (#2b3a4a).",
      "avoid": ["high-saturation neon green/purple", "rainbow gradients", "stark pure black on pure white"]
    },
    "imagery": {
      "direction": "Authentic architectural photography and high-density financial data charts; strictly zero generic stock photography.",
      "avoid": ["smiling corporate handshake photos", "abstract 3D glass orbs", "generic vector illustrations"]
    },
    "density": {
      "direction": "Generous architectural white space around narrative blocks with compact, precise callout figures."
    },
    "motion": {
      "direction": "Static-first presentation with instantaneous state changes; subtle CSS transitions under 150ms for links."
    }
  },
  "references": [
    {
      "id": "ref-ft-lex",
      "role": "reference",
      "kind": "website",
      "sourceUrl": "https://example.com/editorial-journal/lex-column",
      "dimensions": ["editorial", "typography", "layout"],
      "learn": [
        "authoritative two-column opinion layout",
        "tight headline hierarchy with date and metadata"
      ],
      "avoid": ["commercial banner ads", "paywall overlay"],
      "notes": "Exemplary standard for calm institutional financial editorial tone."
    },
    {
      "id": "ref-saas-anti",
      "role": "anti_reference",
      "kind": "website",
      "sourceUrl": "https://example.com/generic-b2b-saas-template",
      "dimensions": ["layout", "imagery", "section_composition"],
      "learn": [],
      "avoid": [
        "three-column card grid with floating icons",
        "centered pill badge 'Announcing V2.0'",
        "cartoon isometric illustrations"
      ],
      "notes": "Negative design control: explicitly forbids adopting SaaS startup layout patterns."
    },
    {
      "id": "ref-swiss-annual-report",
      "role": "reference",
      "kind": "screenshot",
      "localArtifactPath": "references/swiss-banking-annual-report.png",
      "dimensions": ["layout", "density", "color"],
      "learn": [
        "asymmetric first viewport with prominent lead paragraph",
        "subtle hairline borders"
      ],
      "avoid": ["dense unreadable appendices"]
    }
  ],
  "assets": [
    {
      "id": "asset-hero-monochrome",
      "kind": "photo",
      "localPath": "assets/meridian-headquarters-exterior.jpg",
      "usageStatus": "approved",
      "rightsStatus": "operator_owned",
      "provenanceNote": "Commissioned architectural photography, rights fully owned by Meridian Advisory Ltd",
      "altIntent": "Monochrome architectural view of stone headquarters entrance"
    },
    {
      "id": "asset-logo-mark",
      "kind": "logo",
      "localPath": "assets/meridian-mark.svg",
      "usageStatus": "approved",
      "rightsStatus": "operator_owned",
      "provenanceNote": "Corporate vector mark, operator owned"
    },
    {
      "id": "asset-stock-broker",
      "kind": "photo",
      "localPath": "assets/reference-desk-trading.jpg",
      "usageStatus": "reference_only",
      "rightsStatus": "licensed",
      "provenanceNote": "Licensed for reference moodboard only; not cleared for public web distribution"
    },
    {
      "id": "asset-unverified-chart",
      "kind": "chart",
      "localPath": "assets/unverified-market-share.png",
      "usageStatus": "blocked",
      "rightsStatus": "unknown",
      "provenanceNote": "Source unverified; prohibited from production"
    }
  ],
  "pages": [
    {
      "slug": "/",
      "blueprintPageType": "homepage",
      "requirements": {
        "seoTargetingRequired": true,
        "primaryCtaRequired": true,
        "localVisualReferenceRequired": true,
        "approvedAssetRequired": true
      },
      "seo": {
        "searchIntent": "Executive search for independent mid-market debt and capital advisory",
        "primaryKeyword": "independent debt advisory",
        "secondaryKeywords": [
          "capital structure advisory",
          "mid-market corporate financing",
          "refinancing advisor"
        ],
        "notes": "Targeting non-sponsored UK and European corporate executives."
      },
      "qualityBar": {
        "must": [
          "first viewport immediately establishes institutional advisory positioning and independence",
          "visible lead paragraph explains scope of mandates without scrolling"
        ],
        "avoid": [
          "generic hero with 'Unlock Your Growth' headline",
          "three card icons with features"
        ]
      },
      "editorialEmphasis": {
        "emphasis": [
          "highlight 15-year independent advisory track record",
          "emphasize conflict-free partner-led delivery"
        ],
        "avoid": [
          "marketing fluff or retail investment jargon",
          "unsupported league table rankings"
        ],
        "guidance": "Lead with market clarity; state typical mandate sizes explicitly."
      },
      "evidenceRefs": [
        { "kind": "operator_fact", "id": "fact-meridian-founded" },
        { "kind": "discovery_evidence", "id": "ev-debt-market-2026" }
      ],
      "referenceIds": ["ref-ft-lex", "ref-swiss-annual-report", "ref-saas-anti"],
      "assets": [
        {
          "assetId": "asset-hero-monochrome",
          "role": "hero",
          "guidance": "Use in asymmetric first-viewport hero block"
        },
        {
          "assetId": "asset-logo-mark",
          "role": "logo"
        }
      ],
      "sections": [
        {
          "id": "hero-overview",
          "purpose": "Establish institutional corporate debt advisory positioning and clear mandate criteria",
          "headingIntent": "State firm's primary advisory focus in one high-conviction headline",
          "editorialDirection": "Concise declarative prose; no buzzwords",
          "layoutDirection": "Asymmetric split viewport: 60% typography and thesis, 40% subtle architectural visual",
          "referenceIds": ["ref-swiss-annual-report"],
          "assets": [
            {
              "assetId": "asset-hero-monochrome",
              "role": "hero"
            }
          ],
          "sourceBlueprintSectionIds": ["sec-home-hero"]
        },
        {
          "id": "market-landscape",
          "purpose": "Review mid-market capital constraints and covenant tightening",
          "headingIntent": "Anchor advisory value in current European refinancing conditions",
          "editorialDirection": "Cite verified Euribor and covenant trends directly",
          "layoutDirection": "Two-column financial editorial breakdown",
          "evidenceRefs": [
            { "kind": "discovery_evidence", "id": "ev-debt-market-2026" }
          ],
          "sourceBlueprintSectionIds": ["sec-home-features"]
        }
      ],
      "primaryCta": {
        "label": "Request Strategic Briefing",
        "destination": {
          "kind": "internal",
          "targetSlug": "/about"
        }
      }
    }
  ]
}
```

---

## 8. CLI Usage

The Factory CLI exposes deterministic inspection subcommands:

```bash
# Validate production spec strictly against blueprint and profile
pnpm factory site-production validate site-production-spec.json \
  --blueprint site-blueprint.json \
  --profile site-profile.json

# Evaluate objective readiness (checks required files and licenses on disk)
pnpm factory site-production readiness site-production-spec.json \
  --input-root ./production-input \
  --blueprint site-blueprint.json \
  --profile site-profile.json

# Compile bounded PageProductionPacket for one target page
pnpm factory site-production page-packet site-production-spec.json / \
  --blueprint site-blueprint.json \
  --profile site-profile.json \
  --input-root ./production-input
```

---

## 9. Next Steps

After this PR is independently reviewed and accepted:
1. **Sutherland High-Quality Rebuild**:
   - Construct a genuine Sutherland Production Spec with real curated alpine/private-office references, anti-references, approved photography, verified license metadata, and bespoke editorial directions.
2. **Page Production Packet → Executor Integration**:
   - Evaluate the exact projection shape required across the model execution boundary into `SiteTask`.
