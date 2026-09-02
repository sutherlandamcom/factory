import assert from "node:assert/strict";
import test from "node:test";
import type { SiteTask } from "@factory/contracts";
import { deriveTaskWritePolicy } from "../src/executor/module-policy.js";
import {
  buildReviewerSettingsJson,
  buildSeniorReviewPrompt,
  parseSeniorReviewOutput,
} from "../src/executor/review.js";

const TASK: SiteTask = {
  type: "create_page",
  siteId: "demo",
  page: {
    type: "service",
    slug: "/services/roof-repair",
    title: "Roof Repair",
    description: "Professional roof repair services",
    sections: ["hero", "benefits", "faq", "cta"],
  },
};

test("review prompt freezes inputs, forbids mutation, and demands JSON-only output", () => {
  const prompt = buildSeniorReviewPrompt({
    task: TASK,
    writePolicy: deriveTaskWritePolicy(TASK),
    qaEvidence: "scope: PASS; integrity: PASS; foundation_qa: PASS",
  });
  assert.match(prompt, /STRICTLY READ-ONLY/);
  assert.match(prompt, /MUST NOT modify any file/);
  assert.match(prompt, /Roof Repair/);
  assert.match(prompt, /services\/roof-repair\.astro/);
  assert.match(prompt, /scope: PASS/);
  assert.match(prompt, /"verdict": "no_issues" \| "findings"/);
  assert.match(prompt, /"severity": "P0" \| "P1" \| "P2"/);
});

test("review output parser extracts fenced or bare JSON and normalizes severities", () => {
  const fenced = parseSeniorReviewOutput('intro\n```json\n{"verdict":"findings","findings":[{"severity":"P0","summary":"credential exposure","evidence":"patch hunk 2"},{"severity":"P9","summary":"weird"}]}\n```\n');
  assert.equal(fenced?.verdict, "findings");
  assert.equal(fenced?.findings.length, 2);
  assert.equal(fenced?.findings[0]!.severity, "P0");
  // Unknown severities degrade to P2, never crash.
  assert.equal(fenced?.findings[1]!.severity, "P2");

  const bare = parseSeniorReviewOutput('{"verdict":"no_issues","findings":[]}');
  assert.equal(bare?.verdict, "no_issues");
  assert.equal(bare?.findings.length, 0);

  assert.equal(parseSeniorReviewOutput("no json at all"), null);
  assert.equal(parseSeniorReviewOutput("{ broken"), null);
});

test("reviewer settings deny every mutation and web tool", () => {
  const settings = JSON.parse(buildReviewerSettingsJson()) as {
    permissions: { defaultMode: string; deny: string[] };
  };
  assert.equal(settings.permissions.defaultMode, "plan");
  for (const denied of ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent"]) {
    assert.ok(settings.permissions.deny.includes(denied), `${denied} must be denied`);
  }
});
