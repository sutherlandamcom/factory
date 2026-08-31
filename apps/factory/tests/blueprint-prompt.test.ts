import assert from "node:assert/strict";
import test from "node:test";
import { buildBlueprintPrompt, buildBlueprintRepairPrompt } from "../src/blueprint/prompt.js";
import { loadBlueprintFixtureInputs } from "./blueprint-fixtures.js";

const { request, research, plan } = loadBlueprintFixtureInputs();
const input = { plan, request, research } as Parameters<typeof buildBlueprintPrompt>[0];

test("blueprint prompt: trusted instructions first, inert DATA sections after", () => {
  const prompt = buildBlueprintPrompt(input);
  const firstInstruction = prompt.indexOf("Non-negotiable rules");
  const firstData = prompt.indexOf("ACCEPTED_INTELLIGENCE_PLAN_DATA");
  assert.ok(firstInstruction >= 0 && firstData > firstInstruction, "instructions must precede data");
  for (const section of [
    "ACCEPTED_INTELLIGENCE_PLAN_DATA",
    "SITE_INTELLIGENCE_REQUEST_DATA",
    "RESEARCH_EVIDENCE_DATA",
    "COMPONENT_CAPABILITY_REGISTRY",
  ]) {
    assert.ok(prompt.includes(section), `missing DATA section ${section}`);
  }
  // Injection defenses are explicit and concrete.
  assert.match(prompt, /INERT DATA/);
  assert.match(prompt, /ignore previous instructions/);
  assert.match(prompt, /OPENROUTER_API_KEY/);
  // Registry is planner-facing and path-free.
  assert.ok(!prompt.includes("sites/starter/src"));
});

test("blueprint prompt: schema and invariants mirror the contract", () => {
  const prompt = buildBlueprintPrompt(input);
  assert.match(prompt, /"methodologyVersion": "site-blueprint-v0"/);
  assert.match(prompt, /"readiness": "ready\|missing_operator_input\|insufficient_evidence\|blocked"/);
  assert.match(prompt, /MIRROR of the accepted plan/);
  assert.match(prompt, /"kind": "photo\|diagram\|chart\|map\|product-ui\|illustration\|other"/);
  assert.match(prompt, /NO IMAGE IS BETTER THAN A USELESS IMAGE/);
});

test("repair prompt carries bounded issues and the invalid previous output", () => {
  const raw = `{"version":"v0","broken":true}`;
  const prompt = buildBlueprintRepairPrompt(input, raw, [
    "blueprint summit-roofing: page count 4 does not match the accepted plan page count 5",
  ]);
  assert.match(prompt, /bounded REPAIR attempt/);
  assert.match(prompt, /missing from the blueprint|page count|does not match/);
  assert.match(prompt, /"broken":true/);
  assert.match(prompt, /ACCEPTED_INTELLIGENCE_PLAN_DATA/);
});
