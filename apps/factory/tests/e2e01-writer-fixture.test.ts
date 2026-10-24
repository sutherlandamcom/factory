import test from "node:test";
import assert from "node:assert/strict";
import { FixtureWriterProvider } from "../src/writer/fixture-writer.js";
test("E2E-01 Russian writer fixture preserves bounded CTA and fixture-only neutral prose", () => {
  const proposal = FixtureWriterProvider.deterministicProposal({ snapshotId: "fixture", snapshotVersion: 1, snapshotDigest: "a".repeat(64), title: "Модернизация производства", slug: "home", language: "ru-RU", ctaText: "Обсудить производственную задачу" } as Parameters<typeof FixtureWriterProvider.deterministicProposal>[0]);
  assert.equal(proposal.cta, "Обсудить производственную задачу");
  assert.match(proposal.introduction, /тестовый/);
  assert.ok(!JSON.stringify(proposal).includes("RusSilica"));
});
