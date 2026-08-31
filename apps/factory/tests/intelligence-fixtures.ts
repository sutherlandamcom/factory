import { mkdir, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CodexRunRequest, CodexRunResult, CodexRunner } from "../src/executor/codex.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "intelligence");

/** Raw fixture JSON objects (tests apply their own strict parsing). */
export async function loadFixtureRequestJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(FIXTURE_DIR, "summit-roofing.request.json"), "utf8"));
}

export async function loadFixtureResearchJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(FIXTURE_DIR, "summit-roofing.research.json"), "utf8"));
}

/** Synchronous loaders for test-local scenario builders. */
export function loadFixtureRequestJsonSync(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, "summit-roofing.request.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

export function loadFixtureResearchJsonSync(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, "summit-roofing.research.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

export function fixturePaths(): { request: string; research: string } {
  return {
    request: path.join(FIXTURE_DIR, "summit-roofing.request.json"),
    research: path.join(FIXTURE_DIR, "summit-roofing.research.json"),
  };
}

type AnyRecord = Record<string, unknown>;

function metricsFrom(research: AnyRecord, id: string, keys: string[]): AnyRecord {
  const items = research.items as AnyRecord[];
  const item = items.find((candidate) => candidate.id === id);
  const metrics = (item?.metrics ?? {}) as AnyRecord;
  return Object.fromEntries(keys.map((key) => [key, metrics[key]]).filter(([, value]) => value !== undefined));
}

/**
 * A fully valid SiteIntelligencePlan (raw object form) for the synthetic
 * summit-roofing fixture: 1 homepage + 2 services + 2 articles under a
 * 5-page budget, all provenance-linked to fixture evidence ids.
 */
export function makeValidPlan(request: AnyRecord, research: AnyRecord): AnyRecord {
  const byId = new Map<string, AnyRecord>((research.items as AnyRecord[]).map((item) => [item.id as string, item]));
  const has = (id: string): boolean => byId.has(id);
  const pick = (...candidates: string[]): string[] => candidates.filter((id) => has(id));

  return {
    version: "v0",
    methodologyVersion: "first-site-intelligence-v0",
    siteId: request.siteId,
    marketSummary: {
      niche:
        "Residential roofing and gutter services for Denver homeowners, where recurring hail events concentrate repair and replacement demand in late spring and summer.",
      demandObservations: [
        "Emergency repair demand spikes after hailstorms (kw-emergency-repair).",
        "Cost-research queries dominate the replacement consideration phase (kw-roof-replacement-cost).",
        "Seamless aluminum gutters dominate metro installation interest (mkt-gutter-materials).",
      ],
      planningImplications: [
        "Lead the launch set with emergency repair and gutter installation services to cover must-cover demand.",
        "Support replacement shoppers with a cost-guide article answering commercial investigation intent.",
      ],
      uncertainty: [
        "Competitor cost figures may be stale; no pricing claims should be published.",
        "Search metrics are synthetic fixture observations, not live market data.",
      ],
    },
    audiences: [
      {
        name: "Denver homeowners needing urgent storm repairs",
        intent: "transactional",
        evidenceIds: pick("kw-emergency-repair", "serp-emergency-repair"),
      },
      {
        name: "Homeowners budgeting a full replacement",
        intent: "commercial_investigation",
        evidenceIds: pick("kw-roof-replacement-cost", "comp-front-cost"),
      },
      {
        name: "Owners assessing hail risk after storms",
        intent: "informational",
        evidenceIds: pick("kw-hail-inspection", "mkt-hail-frequency"),
      },
    ],
    competitorInsights: [
      {
        id: "insight-emergency-structure",
        category: "page_structure",
        summary:
          "Competitor emergency-repair pages lead with 24/7 availability and phone CTAs above the fold, suggesting urgency-first page composition.",
        evidenceIds: pick("comp-peak-service"),
      },
      {
        id: "insight-trust-signals",
        category: "trust_signals",
        summary:
          "High-ranking competitors aggregate licenses, review counts, and manufacturer certifications on dedicated trust pages.",
        evidenceIds: pick("comp-summit-trust"),
      },
      {
        id: "insight-content-gap",
        category: "gap",
        summary:
          "Few competitors pair gutter installation services with storm-season maintenance guidance, leaving an informational gap.",
        evidenceIds: pick("comp-front-gutter", "mkt-gutter-materials"),
      },
    ],
    keywordClusters: [
      {
        id: "cluster-emergency-repair",
        primaryTopic: "emergency roof repair",
        supportingTerms: ["24/7 roofer", "storm damage repair", "same day roof repair"],
        intent: "transactional",
        priority: "high",
        evidenceIds: pick("kw-emergency-repair", "serp-emergency-repair", "comp-peak-service"),
        metrics: metricsFrom(research, "kw-emergency-repair", ["searchVolume", "cpc"]),
      },
      {
        id: "cluster-gutter-installation",
        primaryTopic: "gutter installation",
        supportingTerms: ["seamless gutters", "aluminum gutters", "gutter replacement"],
        intent: "transactional",
        priority: "medium",
        evidenceIds: pick("kw-gutter-installation", "serp-gutter-installation", "comp-front-gutter"),
        metrics: metricsFrom(research, "kw-gutter-installation", ["searchVolume"]),
      },
      {
        id: "cluster-hail-inspection",
        primaryTopic: "hail damage roof inspection",
        supportingTerms: ["storm inspection", "hail damage checklist"],
        intent: "informational",
        priority: "high",
        evidenceIds: pick("kw-hail-inspection", "serp-hail-inspection", "mkt-hail-frequency", "comp-peak-article"),
      },
      {
        id: "cluster-replacement-cost",
        primaryTopic: "roof replacement cost",
        supportingTerms: ["replacement pricing", "material cost comparison"],
        intent: "commercial_investigation",
        priority: "medium",
        evidenceIds: pick("kw-roof-replacement-cost", "serp-roof-replacement", "comp-front-cost"),
        metrics: metricsFrom(research, "kw-roof-replacement-cost", ["searchVolume", "cpc", "difficulty"]),
      },
    ],
    pages: [
      {
        type: "homepage",
        slug: "/",
        title: "Summit Roofing LLC | Denver Roofing Contractor",
        description:
          "Family-owned Denver roofing contractor since 2009. Licensed hail damage repair, replacement, and gutter services with free 48-hour inspections.",
        sections: ["hero", "feature_cards", "benefits", "faq", "cta"],
        primaryTopic: "roofing contractor denver",
        intent: "commercial_investigation",
        priority: "high",
        rationale:
          "The homepage establishes the broad local market presence and routes visitors to the two must-cover service lines.",
        evidenceIds: pick("kw-best-roofer", "mkt-seasonal-demand", "comp-summit-trust"),
        operatorFactIds: ["fact-local", "fact-license"],
      },
      {
        type: "service",
        slug: "/services/emergency-roof-repair",
        title: "Emergency Roof Repair in Denver | Summit Roofing LLC",
        description:
          "Rapid emergency roof repair across the Denver metro. Free inspections within 48 hours and a 10-year workmanship warranty on repairs.",
        sections: ["hero", "benefits", "content_section", "faq", "cta"],
        primaryTopic: "emergency roof repair",
        intent: "transactional",
        priority: "high",
        rationale:
          "Highest-intent transactional cluster in the evidence; must-cover service with strong seasonal demand spikes.",
        evidenceIds: pick("kw-emergency-repair", "serp-emergency-repair", "mkt-hail-frequency"),
        operatorFactIds: ["fact-hail", "fact-inspection"],
      },
      {
        type: "service",
        slug: "/services/gutter-installation",
        title: "Gutter Installation in Denver | Summit Roofing LLC",
        description:
          "Seamless gutter installation sized for Colorado snow and hail. Material options, warranties, and tidy same-week scheduling.",
        sections: ["hero", "benefits", "content_section", "faq", "cta"],
        primaryTopic: "gutter installation",
        intent: "transactional",
        priority: "medium",
        rationale:
          "Second must-cover service with steady mid-volume demand and an identified competitor content gap.",
        evidenceIds: pick("kw-gutter-installation", "serp-gutter-installation", "mkt-gutter-materials", "comp-front-gutter"),
        operatorFactIds: ["fact-license"],
      },
      {
        type: "article",
        slug: "/blog/hail-damage-roof-inspection-guide",
        title: "Hail Damage Roof Inspection: A Denver Homeowner's Guide",
        description:
          "Learn what inspectors check after a hailstorm, which damage signs matter, and when repair beats replacement for Denver homes.",
        sections: ["content_section", "faq", "cta"],
        primaryTopic: "hail damage roof inspection",
        intent: "informational",
        priority: "high",
        rationale:
          "Answers the informational bridge between storm events and repair bookings without overlapping either service topic.",
        evidenceIds: pick("kw-hail-inspection", "mkt-hail-frequency", "mkt-insurance-deductibles", "comp-peak-article"),
        operatorFactIds: ["fact-hail"],
      },
      {
        type: "article",
        slug: "/blog/roof-replacement-cost-guide",
        title: "Roof Replacement Cost in Denver: What Drives the Price",
        description:
          "Understand the material, slope, and labor factors behind Denver roof replacement budgets so you can plan with realistic ranges.",
        sections: ["content_section", "faq", "cta"],
        primaryTopic: "roof replacement cost",
        intent: "commercial_investigation",
        priority: "medium",
        rationale:
          "Captures the consideration-phase cost research intent that feeds the replacement funnel without duplicating service pages.",
        evidenceIds: pick("kw-roof-replacement-cost", "serp-roof-replacement", "comp-front-cost"),
      },
    ],
    warnings: ["Fixture metrics are synthetic observations and must not be published as market data."],
  };
}

export interface FakeCodexBehavior {
  /** One entry per attempt; a string is written to output/plan.json. */
  outputs: (string | Error)[];
  exitCode?: number | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  /** When false, the fake does not write the output file (default true). */
  writeOutput?: boolean;
}

export function fakeCodexRunner(behavior: FakeCodexBehavior): {
  runner: CodexRunner;
  calls: CodexRunRequest[];
} {
  const calls: CodexRunRequest[] = [];
  const runner: CodexRunner = async (request: CodexRunRequest): Promise<CodexRunResult> => {
    calls.push(request);
    const index = calls.length - 1;
    const output = behavior.outputs[index] ?? behavior.outputs[behavior.outputs.length - 1];
    if (output instanceof Error) throw output;
    if (behavior.writeOutput !== false && typeof output === "string") {
      const target = path.join(request.worktreePath, request.writablePaths[0]!);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, output, "utf8");
    }
    return {
      exitCode: behavior.exitCode ?? 0,
      timedOut: behavior.timedOut ?? false,
      version: "codex-cli 0.150.1",
      stdout: behavior.stdout ?? `${JSON.stringify({ type: "thread.started", model: "gpt-5.3" })}\n`,
      stderr: behavior.stderr ?? "",
    };
  };
  return { runner, calls };
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
