import assert from "node:assert/strict";
import test from "node:test";
import type { ContentBriefData, PageContentProposalData } from "@factory/contracts";
import { runSearchQa } from "../src/writer/qa.js";

const cases = [
  ["проектирование химических производств", "Проектирование химических производств", "PASS"],
  ["проектирование химических производств", "Roof replacement and roofing services", "REVIEW"],
  ["chemical plant modernization", "Chemical plant modernization", "PASS"],
  ["chemical plant modernization", "Residential roofing services", "REVIEW"],
  ["", "Any content", "REVIEW"],
  ["!!!", "Any content", "REVIEW"],
  ["plant модернизация", "Plant модернизация", "PASS"],
] as const;
for (const [intent, text, expected] of cases) {
  test(`E2E-P1-02: ${JSON.stringify(intent)} against ${text} yields ${expected}`, () => {
    const brief = { lineage: { gapSnapshotId: "gap" }, searchSemantics: { primaryIntent: intent, semanticCoverageRequirements: [], userNeeds: [] } } as unknown as ContentBriefData;
    const proposal = { title: text, introduction: text, sections: [], conclusion: text } as unknown as PageContentProposalData;
    assert.equal(runSearchQa(proposal, brief).find(c => c.checkId === "search.primary_intent")?.verdict, expected);
  });
}
