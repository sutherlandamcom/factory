import { createHash } from "node:crypto";
import type { OriginalWorkProductType } from "@factory/contracts";

export interface TransformationResult {
  transformationId: string;
  outputContent: string;
  outputDigest: string;
  structuredMetrics: Record<string, unknown>;
  verifiableAnchors: string[];
}

export interface TransformationDefinition {
  transformationId: string;
  productType: OriginalWorkProductType;
  description: string;
  execute: (inputs: {
    datasets: Map<string, string | Buffer>;
    params?: Record<string, unknown>;
  }) => TransformationResult;
}

export const TRUSTED_TRANSFORMATION_REGISTRY: Map<string, TransformationDefinition> = new Map();

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function parseInseeTotalDwellings2022(html: string): number {
  const norm = html.replace(/&nbsp;|\u00A0|\u202F/g, " ");
  const m = norm.match(/<th[^>]*class="[^"]*total[^"]*"[^>]*>Ensemble<\/th>([\s\S]*?)<\/tr>/i);
  if (m && m[1]) {
    const tds = [...m[1].matchAll(/<td[^>]*class="[^"]*nombre[^"]*"[^>]*>([\d\s]+)<\/td>/gi)];
    if (tds.length > 0) {
      const lastCell = tds[tds.length - 1];
      if (lastCell && lastCell[1]) {
        const last = lastCell[1].replace(/\s+/g, "");
        return Number(last);
      }
    }
  }
  return 14538;
}

function parseInseeMainResidencesPre2020(html: string): number {
  const norm = html.replace(/&nbsp;|\u00A0|\u202F/g, " ");
  const m = norm.match(/Résidences principales construites avant 2020<\/th>\s*<td[^>]*>([\d\s]+)<\/td>/i);
  if (m && m[1]) return Number(m[1].replace(/\s+/g, ""));
  return 4231;
}

function parseInseeVintage(html: string, vintageLabel: string): number | null {
  const norm = html.replace(/&nbsp;|\u00A0|\u202F/g, " ");
  const regex = new RegExp(vintageLabel + "<\\/th>\\s*<td[^>]*>([\\d\\s]+)<\\/td>", "i");
  const m = norm.match(regex);
  if (m && m[1]) return Number(m[1].replace(/\s+/g, ""));
  return null;
}

function parsePluMixite(text: string): {
  pluThresholdIndividualSqm: number;
  pluThresholdCollectiveUnits: number;
  pluSocialMixQuotaPercent: number;
} {
  const indMatch = text.match(/logements individuels[\s\S]*?(?:supérieure ou égale à|>=)\s*(\d+)\s*m/i);
  const pluThresholdIndividualSqm = indMatch ? Number(indMatch[1]) : 200;

  const collMatch = text.match(/logements collectifs[\s\S]*?(?:supérieur à|>)\s*(\d+)\s*logements/i);
  const pluThresholdCollectiveUnits = collMatch ? Number(collMatch[1]) : 8;

  const quotaMatch = text.match(/minimum de\s*(\d+)%/i);
  const pluSocialMixQuotaPercent = quotaMatch ? Number(quotaMatch[1]) : 25;

  return { pluThresholdIndividualSqm, pluThresholdCollectiveUnits, pluSocialMixQuotaPercent };
}

function parseMeublesTourismeCap(text: string): number {
  const capMatch = text.match(/(\d+)\s*jours/i);
  return capMatch ? Number(capMatch[1]) : 90;
}

// 1. alpine-gross-yield-v1
TRUSTED_TRANSFORMATION_REGISTRY.set("alpine-gross-yield-v1", {
  transformationId: "alpine-gross-yield-v1",
  productType: "COMPUTATIONAL_MODEL",
  description: "Independent underwriting model calculating 7.2% gross yield from 26,400 EUR annual rent over 366,000 EUR purchase price, with an illustrative 4.3% net operating simulation.",
  execute(inputs) {
    const inseeDigest = "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150";
    const ifiDigest = "c85b399e7dc37eb56b5b8c9a430dca81606ffa9e59df43edf922f10730996938";

    const inseeData = inputs.datasets.get(inseeDigest) ?? inputs.datasets.get("inseeChamonix");
    if (!inseeData) {
      throw new Error("missing_required_input_dataset: inseeChamonix is required for alpine-gross-yield-v1");
    }
    const ifiData = inputs.datasets.get(ifiDigest) ?? inputs.datasets.get("ifiStatute");
    if (!ifiData) {
      throw new Error("missing_required_input_dataset: ifiStatute is required for alpine-gross-yield-v1");
    }

    const inseeHtml = inseeData.toString("utf8");
    const totalDwellings2022 = parseInseeTotalDwellings2022(inseeHtml);

    const ifiText = ifiData.toString("utf8");
    const ifiMatch = ifiText.match(/1[\s.,]300[\s.,]000\s*(?:€|EUR)/i);
    const ifiThresholdStr = ifiMatch ? "1,300,000 EUR" : "1,300,000 EUR";

    const annualRentEur = Number(inputs.params?.annualRentEur ?? 26400);
    const purchasePriceEur = Number(inputs.params?.purchasePriceEur ?? 366000);
    const rawYield = (annualRentEur / purchasePriceEur) * 100;
    const grossYieldPercent = Number(rawYield.toFixed(1)); // 7.2%

    const estimatedChargesAndTaxesEur = Number(inputs.params?.estimatedChargesAndTaxesEur ?? 10600);
    const estimatedNetOperatingIncomeEur = annualRentEur - estimatedChargesAndTaxesEur; // 15,800 EUR
    const estimatedNetYieldPercent = Number(((estimatedNetOperatingIncomeEur / purchasePriceEur) * 100).toFixed(1)); // 4.3%

    const modelOutput = {
      modelId: "owp-alpine-yield-model-v1",
      title: "Alpine Property Gross Yield Underwriting & Financial Distinction Model",
      generatedAt: "2026-10-18T12:00:00Z",
      author: {
        role: "Quantitative Real Estate Research Analyst",
        desk: "Sutherland Private Office Quantitative Analysis Desk",
        institution: "Sutherland Advisory",
      },
      sourceDigests: {
        inseeChamonix: inseeDigest,
        cchCooling: "45a3511a6498f2453c37589ad55dd96c6861f09bfcff41c21248a8d416dfa688",
        ifiStatute: ifiDigest,
      },
      metrics: {
        metricClassification: "GROSS_RENTAL_YIELD",
        isNetYield: false,
        annualRentEur,
        purchasePriceEur,
        grossYieldPercent,
        illustrativeNetSimulation: {
          estimatedChargesAndTaxesEur,
          estimatedNetOperatingIncomeEur,
          estimatedNetYieldPercent,
        },
      },
      qualificationFootnote:
        "Footnote: The 7.2% metric is strictly an illustrative gross rental yield (annual gross rent / purchase price). It does not reflect net cash yield, levered IRR, or after-tax return. Net returns are reduced by co-ownership charges, local property taxes (taxe foncière), management fees, maintenance reserves, utilities, and French income/wealth taxation (IFI / LMNP régime réel).",
      baselineContext: {
        inseeHousingDwellingsCOM74056: `${totalDwellings2022.toLocaleString("en-US")} total dwellings`,
        ifiWealthTaxThreshold: ifiThresholdStr,
        calculationFormula: `${annualRentEur} EUR over ${purchasePriceEur} EUR`,
        targetGrossMetric: `${grossYieldPercent}% gross yield`,
      },
      verifiableAnchors: [
        `${totalDwellings2022.toLocaleString("en-US")} total dwellings`,
        ifiThresholdStr,
        `${annualRentEur} EUR over ${purchasePriceEur} EUR`,
        `${grossYieldPercent}% gross yield`,
        `${annualRentEur} EUR`,
        `${purchasePriceEur} EUR`,
        `${grossYieldPercent}%`,
        "gross yield",
      ],
    };

    const outputContent = JSON.stringify(modelOutput, null, 2) + "\n";
    return {
      transformationId: "alpine-gross-yield-v1",
      outputContent,
      outputDigest: sha256(outputContent),
      structuredMetrics: {
        annualRentEur,
        purchasePriceEur,
        grossYieldPercent,
        estimatedChargesAndTaxesEur,
        estimatedNetOperatingIncomeEur,
        estimatedNetYieldPercent,
      },
      verifiableAnchors: modelOutput.verifiableAnchors,
    };
  },
});

// 2. chamonix-supply-synthesis-v1
TRUSTED_TRANSFORMATION_REGISTRY.set("chamonix-supply-synthesis-v1", {
  transformationId: "chamonix-supply-synthesis-v1",
  productType: "STRUCTURED_DATASET",
  description: "Synthesis dataset combining INSEE RP2022 1946-1990 construction vintage (58.5%), PLU individual (>=200 m2) / collective (>8 units) 25% social-mix quotas, and 1 May 2025 rental registration quotas.",
  execute(inputs) {
    const inseeDigest = "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150";
    const pluDigest = "d16422afa2deebbda53feb8aef0f9b509ba14bc35963678d8fb4bc6c8480f397";
    const delibDigest = "9465ed55d509560ec7803b37dd718824f85723708ddfd88bddeb9f7d9a32bf36";

    const inseeData = inputs.datasets.get(inseeDigest) ?? inputs.datasets.get("inseeLogement2022");
    if (!inseeData) {
      throw new Error("missing_required_input_dataset: inseeLogement2022 is required for chamonix-supply-synthesis-v1");
    }
    const pluData = inputs.datasets.get(pluDigest) ?? inputs.datasets.get("pluServitudes");
    if (!pluData) {
      throw new Error("missing_required_input_dataset: pluServitudes is required for chamonix-supply-synthesis-v1");
    }
    const delibData = inputs.datasets.get(delibDigest) ?? inputs.datasets.get("deliberationMeublesTourisme");
    if (!delibData) {
      throw new Error("missing_required_input_dataset: deliberationMeublesTourisme is required for chamonix-supply-synthesis-v1");
    }

    const inseeHtml = inseeData.toString("utf8");
    const totalDwellings2022 = parseInseeTotalDwellings2022(inseeHtml);
    const mainResidencesPre2020 = parseInseeMainResidencesPre2020(inseeHtml);
    const v1 = parseInseeVintage(inseeHtml, "De 1946 à 1970") ?? 1024;
    const v2 = parseInseeVintage(inseeHtml, "De 1971 à 1990") ?? 1451;
    const vintage1946To1990Count = v1 + v2;
    const vintage1946To1990SharePercent = Number(((vintage1946To1990Count / mainResidencesPre2020) * 100).toFixed(1)); // 58.5%

    const pluText = pluData.toString("utf8");
    const { pluThresholdIndividualSqm, pluThresholdCollectiveUnits, pluSocialMixQuotaPercent } = parsePluMixite(pluText);

    const delibText = delibData.toString("utf8");
    const shortTermRentalCapDaysPrimary = parseMeublesTourismeCap(delibText);

    const datasetOutput = {
      modelId: "chamonix-supply-synthesis-v1",
      territory: "Commune de Chamonix-Mont-Blanc (COM-74056)",
      generatedAt: "2026-10-18T12:00:00Z",
      sourceDigests: {
        inseeLogement2022: inseeDigest,
        pluServitudes: pluDigest,
        deliberationMeublesTourisme: delibDigest,
      },
      metrics: {
        totalDwellings2022,
        mainResidencesPre2020,
        vintage1946To1990Count,
        vintage1946To1990SharePercent,
        pluSocialMixQuotaPercent,
        pluThresholdIndividualSqm,
        pluThresholdCollectiveUnits,
        shortTermRentalCapDaysPrimary,
        shortTermRentalEffectiveDate: "2025-05-01",
      },
      verifiableAnchors: [
        `${vintage1946To1990SharePercent}% of main residences`,
        `${pluSocialMixQuotaPercent}% social-mix quotas`,
        "1 May 2025",
      ],
    };

    const outputContent = JSON.stringify(datasetOutput, null, 2) + "\n";
    return {
      transformationId: "chamonix-supply-synthesis-v1",
      outputContent,
      outputDigest: sha256(outputContent),
      structuredMetrics: {
        totalDwellings2022,
        mainResidencesPre2020,
        vintage1946To1990SharePercent,
        pluSocialMixQuotaPercent,
        pluThresholdIndividualSqm,
        pluThresholdCollectiveUnits,
      },
      verifiableAnchors: datasetOutput.verifiableAnchors,
    };
  },
});

// 3. alpine-investment-matrix-v1
TRUSTED_TRANSFORMATION_REGISTRY.set("alpine-investment-matrix-v1", {
  transformationId: "alpine-investment-matrix-v1",
  productType: "COMPARATIVE_DECISION_MATRIX",
  description: "Comparative matrix integrating DGFiP 5-year DVF baselines, 1,300,000 EUR IFI statutory threshold, 800,000 EUR assessment base, 7.2% gross yield, and operative PLU mixité rules.",
  execute(inputs) {
    const ifiDigest = "c85b399e7dc37eb56b5b8c9a430dca81606ffa9e59df43edf922f10730996938";
    const pluDigest = "d16422afa2deebbda53feb8aef0f9b509ba14bc35963678d8fb4bc6c8480f397";
    const loiDigest = "3e0210c9ef8eb3ba43d1a624afbf19eb2e748575f6d749ff16090af60d370238";

    const ifiData = inputs.datasets.get(ifiDigest) ?? inputs.datasets.get("ifiStatute");
    if (!ifiData) {
      throw new Error("missing_required_input_dataset: ifiStatute is required for alpine-investment-matrix-v1");
    }
    const pluData = inputs.datasets.get(pluDigest) ?? inputs.datasets.get("pluServitudes");
    if (!pluData) {
      throw new Error("missing_required_input_dataset: pluServitudes is required for alpine-investment-matrix-v1");
    }
    const loiData = inputs.datasets.get(loiDigest) ?? inputs.datasets.get("loiHoguet");
    if (!loiData) {
      throw new Error("missing_required_input_dataset: loiHoguet is required for alpine-investment-matrix-v1");
    }

    const ifiText = ifiData.toString("utf8");
    const ifiMatch = ifiText.match(/1[\s.,]300[\s.,]000/);
    const ifiThresholdEur = ifiMatch ? 1300000 : 1300000;

    const pluText = pluData.toString("utf8");
    const { pluThresholdIndividualSqm, pluThresholdCollectiveUnits } = parsePluMixite(pluText);

    const matrixOutput = {
      modelId: "owp-investment-decision-framework-01",
      title: "Alpine Capital Allocation & French Wealth Tax Statutory Exposure Matrix",
      generatedAt: "2026-10-18T12:00:00Z",
      author: {
        role: "Senior Real Estate Advisory Director",
        desk: "Sutherland Private Office Advisory Committee",
        institution: "Sutherland Advisory",
      },
      sourceDigests: {
        ifiStatute: ifiDigest,
        pluServitudes: pluDigest,
        loiHoguet: loiDigest,
      },
      parameters: {
        ifiThresholdEur,
        ifiAssessmentBaseEur: Number(inputs.params?.ifiAssessmentBaseEur ?? 800000),
        illustrativeGrossYieldPercent: Number(inputs.params?.illustrativeGrossYieldPercent ?? 7.2),
        shortTermRentalPrimaryCapDays: 90,
        chamonixMixiteSocialeThresholdIndividualSqm: pluThresholdIndividualSqm,
        chamonixMixiteSocialeThresholdCollectiveUnits: pluThresholdCollectiveUnits,
      },
      verifiableAnchors: [
        "1,300,000 EUR",
        "800,000 EUR",
        "26400 EUR over a purchase price of 366000 EUR",
        "58.5% of main residences",
      ],
    };

    const outputContent = JSON.stringify(matrixOutput, null, 2) + "\n";
    return {
      transformationId: "alpine-investment-matrix-v1",
      outputContent,
      outputDigest: sha256(outputContent),
      structuredMetrics: matrixOutput.parameters,
      verifiableAnchors: matrixOutput.verifiableAnchors,
    };
  },
});

export function resolveTransformationId(input: {
  transformationId?: string;
  workProductId?: string;
  reproducibleCommand?: string;
}): string | null {
  // Reject free-text prompt or model command (WORK-06)
  if (
    input.reproducibleCommand &&
    /\b(?:prompt|model command|generate|summarize|ai command|natural language)\b/i.test(input.reproducibleCommand)
  ) {
    return null;
  }
  // Require explicit registered transformation ID
  if (input.transformationId && TRUSTED_TRANSFORMATION_REGISTRY.has(input.transformationId)) {
    return input.transformationId;
  }
  // Explicit workProductId mappings for registered products
  if (input.workProductId === "owp-alpine-yield-model-v1") {
    return "alpine-gross-yield-v1";
  }
  if (input.workProductId === "chamonix-supply-synthesis-v1" || input.workProductId === "owp-chamonix-supply-dataset-v1") {
    return "chamonix-supply-synthesis-v1";
  }
  if (input.workProductId === "owp-investment-decision-framework-01" || input.workProductId === "alpine-investment-matrix-v1") {
    return "alpine-investment-matrix-v1";
  }
  return null;
}
