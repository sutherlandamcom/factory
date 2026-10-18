import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");

export interface InvestmentMatrixOutput {
  modelId: "owp-investment-decision-framework-01";
  title: "Alpine Capital Allocation & French Wealth Tax Statutory Exposure Matrix";
  generatedAt: string;
  author: {
    role: "Senior Real Estate Advisory Director";
    desk: "Sutherland Private Office Advisory Committee";
    institution: "Sutherland Advisory";
  };
  sourceDigests: {
    ifiStatute: string;
    pluServitudes: string;
    loiHoguet: string;
  };
  parameters: {
    ifiThresholdEur: number;
    ifiAssessmentBaseEur: number;
    illustrativeGrossYieldPercent: number;
    shortTermRentalPrimaryCapDays: number;
    chamonixMixiteSocialeThresholdSqm: number;
  };
  verifiableAnchors: string[];
}

export function computeInvestmentMatrix(root = repoRoot): InvestmentMatrixOutput {
  const ifiPath = path.join(root, "docs/evidence/sources/legal-regulatory-2026/legifrance-cgi-964-965-ifi.txt");
  const pluPath = path.join(root, "docs/evidence/sources/legal-regulatory-2026/chamonix-plu-servitudes-mixite.txt");
  const hoguetPath = path.join(root, "docs/evidence/sources/legal-regulatory-2026/legifrance-loi-hoguet-1970.txt");

  const ifiBytes = readFileSync(ifiPath);
  const pluBytes = readFileSync(pluPath);
  const hoguetBytes = readFileSync(hoguetPath);

  const ifiDigest = createHash("sha256").update(ifiBytes).digest("hex");
  const pluDigest = createHash("sha256").update(pluBytes).digest("hex");
  const hoguetDigest = createHash("sha256").update(hoguetBytes).digest("hex");

  return {
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
      loiHoguet: hoguetDigest,
    },
    parameters: {
      ifiThresholdEur: 1300000,
      ifiAssessmentBaseEur: 800000,
      illustrativeGrossYieldPercent: 7.2,
      shortTermRentalPrimaryCapDays: 90,
      chamonixMixiteSocialeThresholdSqm: 300,
    },
    verifiableAnchors: [
      "1,300,000 EUR",
      "800,000 EUR",
      "26400 EUR over a purchase price of 366000 EUR",
      "58.5% of main residences",
    ],
  };
}

export function run(): void {
  const result = computeInvestmentMatrix();
  const modelsDir = path.join(repoRoot, "docs/evidence/models");
  mkdirSync(modelsDir, { recursive: true });
  const modelFile = path.join(modelsDir, "investment-matrix-v1.json");
  writeFileSync(modelFile, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log(`Reproduced Investment Matrix -> ${modelFile}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run();
}
