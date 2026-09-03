import type {
  NormalizedResearchEvidenceBundle,
  PageBlueprint,
  SiteBlueprint,
  SiteProfile,
  SiteProductionSpec,
} from "@factory/contracts";
import { deterministicDigest } from "../../src/intelligence/digest.js";

/**
 * Representative realistic GENERIC fixtures for SiteProductionSpec v0.
 *
 * Subject: "meridian-advisory" — a premium independent debt advisory firm.
 * Strictly generic: NOT Sutherland.
 *
 * Expresses all core requirements:
 * - Structured global creative direction & quality bar (must feel like / must not feel like)
 * - Visual references, anti-references, URL-only vs inspectable screenshot references
 * - Approved hero asset with operator-owned rights
 * - Reference-only assets and blocked assets with unknown rights
 * - Manual SEO targeting (search intent, primary keyword, secondary keywords)
 * - Page-specific quality constraints
 * - Page-specific references and asset assignments
 * - Ordered section production instructions with blueprint provenance
 * - Explicit evidence selection (operator facts + discovery evidence)
 * - Discriminated CTA destinations (internal, external, email)
 */

export function makeGenericBlueprint(): SiteBlueprint {
  const bp: SiteBlueprint = {
    version: "v0",
    methodologyVersion: "site-blueprint-v0",
    siteId: "meridian-advisory",
    site: {
      positioningSummary:
        "Meridian Advisory provides conflict-free debt advisory and capital structure solutions for mid-market European enterprises.",
      primaryAudience: "CFOs, Treasurers, and Managing Directors of European mid-market businesses (€50m–€500m revenue).",
      navigation: [
        { label: "Home", targetSlug: "/" },
        { label: "Debt Advisory", targetSlug: "/services/debt-advisory" },
        { label: "About", targetSlug: "/about" },
      ],
      primaryConversionGoal: "Direct engagement inquiry from qualifying corporate borrower.",
    },
    pages: [
      {
        type: "homepage",
        slug: "/",
        primaryTopic: "Independent Corporate Debt Advisory",
        pageRole: "conversion_landing",
        audience: "Corporate leadership evaluating refinancing, restructuring, or acquisition debt",
        intent: "informational",
        seoTitle: "Independent Corporate Debt Advisory | Meridian Advisory",
        metaDescription:
          "Partner-led debt advisory and capital structuring for mid-market European corporations. Conflict-free guidance on refinancing and growth capital.",
        h1: "Strategic Capital Structuring for European Mid-Market Enterprises",
        purpose: "Introduce Meridian Advisory, establish institutional credibility, and prompt senior briefing inquiries.",
        businessGoal: "Position Meridian as the premier boutique debt advisor for non-sponsored corporate borrowers.",
        userQuestions: [
          "What makes Meridian different from lending banks?",
          "What transaction sizes do you advise on?",
        ],
        objections: [
          "Our relationship banks can arrange our financing without an advisor.",
        ],
        sections: [
          {
            id: "sec-home-hero",
            componentType: "hero",
            purpose: "Communicate core independent debt advisory thesis and establish institutional authority.",
            heading: "Strategic Capital Structuring for European Mid-Market Enterprises",
            keyPoints: [
              "100% independent and borrower-aligned: zero lending conflict.",
              "Partner-led execution on every mandate from strategy through syndicate closing.",
            ],
            evidenceIds: ["ev-debt-market-2026"],
            operatorFactIds: ["fact-meridian-founded"],
            prohibitedClaims: ["Guaranteed lowest lending margin across Europe."],
            visualRequirement: {
              required: true,
              purpose: "Architectural imagery conveying permanence and discretion.",
              kind: "photo",
            },
            cta: {
              role: "primary",
              job: "Initiate senior partner confidential conversation",
            },
          },
          {
            id: "sec-home-features",
            componentType: "feature_cards",
            purpose: "Detail advisory capabilities across refinancing, growth debt, and special situations.",
            heading: "Disciplined Advisory Across the Capital Spectrum",
            keyPoints: [
              "Senior secured loans, unitranche structures, and subordinated growth facilities.",
              "Comprehensive covenant modeling and terms negotiation.",
            ],
            evidenceIds: ["ev-debt-market-2026"],
            operatorFactIds: [],
            prohibitedClaims: [],
            visualRequirement: { required: false },
          },
        ],
        internalLinks: [
          {
            targetSlug: "/services/debt-advisory",
            purpose: "Direct borrowers to in-depth service overview",
          },
          {
            targetSlug: "/about",
            purpose: "Introduce the senior leadership team and track record",
          },
        ],
        structuredDataType: "local_business",
        readiness: "ready",
        missingInputs: [],
      },
      {
        type: "service",
        slug: "/services/debt-advisory",
        primaryTopic: "Debt Advisory Practice",
        pageRole: "service_detail",
        audience: "Corporate treasurers and private business owners",
        intent: "commercial_investigation",
        seoTitle: "Mid-Market Debt Advisory Services | Meridian Advisory",
        metaDescription:
          "End-to-end debt advisory services: capital structure evaluation, lender syndicate selection, and covenant optimization.",
        h1: "Comprehensive Debt Advisory & Capital Solutions",
        purpose: "Explain the debt advisory process and mandate deliverables.",
        businessGoal: "Qualify corporate inquiries and demonstrate execution rigor.",
        userQuestions: ["How long does a debt advisory engagement take?"],
        objections: ["Advisor fees may erode transaction savings."],
        sections: [
          {
            id: "sec-service-hero",
            componentType: "hero",
            purpose: "Overview of advisory process.",
            heading: "Objective Capital Sourcing and Syndicate Execution",
            keyPoints: ["Rigorous competitive tension among commercial and private credit lenders."],
            evidenceIds: [],
            operatorFactIds: ["fact-deal-volume-2025"],
            prohibitedClaims: [],
            visualRequirement: { required: false },
          },
        ],
        internalLinks: [
          {
            targetSlug: "/",
            purpose: "Return to homepage",
          },
        ],
        structuredDataType: "service",
        readiness: "ready",
        missingInputs: [],
      },
      {
        type: "general",
        slug: "/about",
        primaryTopic: "About Meridian Advisory",
        pageRole: "trust",
        audience: "Institutional counterparts and prospective clients",
        intent: "informational",
        seoTitle: "About Our Firm & Leadership | Meridian Advisory",
        metaDescription: "Learn about Meridian Advisory's senior leadership, philosophy, and institutional track record.",
        h1: "Principals with Decades of Direct Lending & Advisory Experience",
        purpose: "Establish partner background and institutional ethos.",
        businessGoal: "Build trust with corporate boards.",
        userQuestions: ["Who are the partners leading mandates?"],
        objections: ["Boutiques lack execution capacity compared to bulge-bracket banks."],
        sections: [
          {
            id: "sec-about-team",
            componentType: "content_section",
            purpose: "Present partner credentials and track record.",
            heading: "Partner-Led Delivery on Every Mandate",
            keyPoints: ["Over €3.5bn in closed debt mandates across 15 years."],
            evidenceIds: [],
            operatorFactIds: ["fact-meridian-founded", "fact-deal-volume-2025"],
            prohibitedClaims: [],
            visualRequirement: { required: false },
          },
        ],
        internalLinks: [
          {
            targetSlug: "/",
            purpose: "Return to homepage",
          },
        ],
        structuredDataType: "web_page",
        readiness: "ready",
        missingInputs: [],
      },
    ],
    warnings: [],
    missingInputs: [],
  };

  return bp;
}

export function makeGenericSiteProfile(): SiteProfile {
  return {
    version: "v0",
    siteId: "meridian-advisory",
    siteName: "Meridian Advisory",
    canonicalOrigin: "https://meridian-advisory.com",
    language: "en-GB",
    navigation: [
      { label: "Home", targetSlug: "/" },
      { label: "Debt Advisory", targetSlug: "/services/debt-advisory" },
      { label: "About", targetSlug: "/about" },
    ],
    addressLines: ["30 St Mary Axe", "London EC3A 8EP", "United Kingdom"],
  };
}

export function makeGenericEvidenceBundle(): {
  evidence: NormalizedResearchEvidenceBundle;
  operatorFacts: Array<{ id: string; text: string }>;
} {
  return {
    evidence: {
      version: "v0",
      collectedAt: "2026-09-01T10:00:00Z",
      items: [
        {
          id: "ev-debt-market-2026",
          kind: "market_observation",
          provider: "European Central Bank & S&P LCD",
          title: "European Mid-Market Lending Report Q2 2026",
          text: "Senior secured unitranche margins stabilized at Euribor + 575bps with tighter leverage covenants across mid-market corporate borrowers.",
          metrics: {
            difficulty: 65,
          },
          collectedAt: "2026-09-01T09:30:00Z",
        },
      ],
    },
    operatorFacts: [
      {
        id: "fact-meridian-founded",
        text: "Meridian Advisory was established in 2011 in London as an independent corporate finance partnership.",
      },
      {
        id: "fact-deal-volume-2025",
        text: "In 2025, Meridian advised on 14 completed credit transactions totaling €420m in arranged facilities.",
      },
    ],
  };
}

export function makeGenericProductionSpec(
  blueprint: SiteBlueprint = makeGenericBlueprint(),
): SiteProductionSpec {
  const digest = deterministicDigest(blueprint);

  return {
    version: "v0",
    siteId: "meridian-advisory",
    sourceBlueprint: {
      runId: "20260901T120000Z-abcd1234",
      digest,
    },
    creativeDirection: {
      qualityBar: {
        mustFeelLike: [
          "prestigious boutique financial institution",
          "calm high-conviction editorial journal",
          "restrained Swiss financial typography with generous margins",
        ],
        mustNotFeelLike: [
          "generic SaaS landing page with pill badges and gradient buttons",
          "mass-market template with floating cards",
          "cluttered commercial broker listing portal",
          "AI-generated marketing brochure",
        ],
      },
      editorial: {
        rules: [
          "assert data-backed conclusions before operational implications",
          "restrained declarative copy without marketing hyperbole",
          "active institutional voice with numerical precision",
        ],
        avoid: [
          "hollow buzzwords (world-class, bespoke synergies, cutting-edge)",
          "unsubstantiated league table claims",
          "generic luxury cliches",
        ],
      },
      layout: {
        principles: [
          "asymmetric executive summary block in first viewport",
          "spacious single-column narrative pacing paired with clear financial data blocks",
          "strict hairline dividers separating thematic modules",
        ],
        avoid: [
          "three-card icon grids",
          "glowing neon borders and glassmorphism cards",
          "infinite logo carousels",
        ],
      },
      typography: {
        direction:
          "Editorial serif headlines with disciplined tracking paired with crisp neo-grotesque sans-serif body; high contrast between hero scale and reading text.",
        avoid: ["rounded geometric sans", "all-caps body text", "script fonts"],
      },
      color: {
        direction:
          "Deep navy foundation (#0d1b2a) with warm bone paper backdrop (#f7f5f0) and subtle slate border accents (#2b3a4a).",
        avoid: ["high-saturation neon green/purple", "rainbow gradients", "stark pure black on pure white"],
      },
      imagery: {
        direction:
          "Authentic architectural photography and high-density financial data charts; strictly zero generic stock photography.",
        avoid: ["smiling corporate handshake photos", "abstract 3D glass orbs", "generic vector illustrations"],
      },
      density: {
        direction:
          "Generous architectural white space around narrative blocks with compact, precise callout figures.",
      },
      motion: {
        direction:
          "Static-first presentation with instantaneous state changes; subtle CSS transitions under 150ms for links.",
      },
    },
    references: [
      {
        id: "ref-ft-lex",
        role: "reference",
        kind: "website",
        sourceUrl: "https://example.com/editorial-journal/lex-column",
        dimensions: ["editorial", "typography", "layout"],
        learn: [
          "authoritative two-column opinion layout",
          "tight headline hierarchy with date and metadata",
        ],
        avoid: ["commercial banner ads", "paywall overlay"],
        notes: "Exemplary standard for calm institutional financial editorial tone.",
      },
      {
        id: "ref-saas-anti",
        role: "anti_reference",
        kind: "website",
        sourceUrl: "https://example.com/generic-b2b-saas-template",
        dimensions: ["layout", "imagery", "section_composition"],
        learn: [],
        avoid: [
          "three-column card grid with floating icons",
          "centered pill badge 'Announcing V2.0'",
          "cartoon isometric illustrations",
        ],
        notes: "Negative design control: explicitly forbids adopting SaaS startup layout patterns.",
      },
      {
        id: "ref-swiss-annual-report",
        role: "reference",
        kind: "screenshot",
        localArtifactPath: "references/swiss-banking-annual-report.png",
        dimensions: ["layout", "density", "color"],
        learn: [
          "asymmetric first viewport with prominent lead paragraph",
          "subtle hairline borders",
        ],
        avoid: ["dense unreadable appendices"],
      },
    ],
    assets: [
      {
        id: "asset-hero-monochrome",
        kind: "photo",
        localPath: "assets/meridian-headquarters-exterior.jpg",
        usageStatus: "approved",
        rightsStatus: "operator_owned",
        provenanceNote: "Commissioned architectural photography, rights fully owned by Meridian Advisory Ltd",
        altIntent: "Monochrome architectural view of stone headquarters entrance",
      },
      {
        id: "asset-logo-mark",
        kind: "logo",
        localPath: "assets/meridian-mark.svg",
        usageStatus: "approved",
        rightsStatus: "operator_owned",
        provenanceNote: "Corporate vector mark, operator owned",
      },
      {
        id: "asset-stock-broker",
        kind: "photo",
        localPath: "assets/reference-desk-trading.jpg",
        usageStatus: "reference_only",
        rightsStatus: "licensed",
        provenanceNote: "Licensed for reference moodboard only; not cleared for public web distribution",
      },
      {
        id: "asset-unverified-chart",
        kind: "chart",
        localPath: "assets/unverified-market-share.png",
        usageStatus: "blocked",
        rightsStatus: "unknown",
        provenanceNote: "Source unverified; prohibited from production",
      },
    ],
    pages: [
      {
        slug: "/",
        blueprintPageType: "homepage",
        requirements: {
          seoTargetingRequired: true,
          primaryCtaRequired: true,
          localVisualReferenceRequired: true,
          approvedAssetRequired: true,
        },
        seo: {
          searchIntent: "Executive search for independent mid-market debt and capital advisory",
          primaryKeyword: "independent debt advisory",
          secondaryKeywords: [
            "capital structure advisory",
            "mid-market corporate financing",
            "refinancing advisor",
          ],
          notes: "Targeting non-sponsored UK and European corporate executives.",
        },
        qualityBar: {
          must: [
            "first viewport immediately establishes institutional advisory positioning and independence",
            "visible lead paragraph explains scope of mandates without scrolling",
          ],
          avoid: [
            "generic hero with 'Unlock Your Growth' headline",
            "three card icons with features",
          ],
        },
        editorialEmphasis: {
          emphasis: [
            "highlight 15-year independent advisory track record",
            "emphasize conflict-free partner-led delivery",
          ],
          avoid: [
            "marketing fluff or retail investment jargon",
            "unsupported league table rankings",
          ],
          guidance: "Lead with market clarity; state typical mandate sizes explicitly.",
        },
        evidenceRefs: [
          { kind: "operator_fact", id: "fact-meridian-founded" },
          { kind: "discovery_evidence", id: "ev-debt-market-2026" },
        ],
        referenceIds: ["ref-ft-lex", "ref-swiss-annual-report", "ref-saas-anti"],
        assets: [
          {
            assetId: "asset-hero-monochrome",
            role: "hero",
            guidance: "Use in asymmetric first-viewport hero block",
          },
          {
            assetId: "asset-logo-mark",
            role: "logo",
          },
        ],
        sections: [
          {
            id: "hero-overview",
            purpose: "Establish institutional corporate debt advisory positioning and clear mandate criteria",
            headingIntent: "State firm's primary advisory focus in one high-conviction headline",
            editorialDirection: "Concise declarative prose; no buzzwords",
            layoutDirection: "Asymmetric split viewport: 60% typography and thesis, 40% subtle architectural visual",
            referenceIds: ["ref-swiss-annual-report"],
            assets: [
              {
                assetId: "asset-hero-monochrome",
                role: "hero",
              },
            ],
            evidenceRefs: [],
            sourceBlueprintSectionIds: ["sec-home-hero"],
          },
          {
            id: "market-landscape",
            purpose: "Review mid-market capital constraints and covenant tightening",
            headingIntent: "Anchor advisory value in current European refinancing conditions",
            editorialDirection: "Cite verified Euribor and covenant trends directly",
            layoutDirection: "Two-column financial editorial breakdown",
            referenceIds: [],
            assets: [],
            evidenceRefs: [
              { kind: "discovery_evidence", id: "ev-debt-market-2026" },
            ],
            sourceBlueprintSectionIds: ["sec-home-features"],
          },
        ],
        primaryCta: {
          label: "Request Strategic Briefing",
          destination: {
            kind: "internal",
            targetSlug: "/about",
          },
        },
      },
    ],
  };
}
