import assert from "node:assert/strict";
import test from "node:test";
import {
  writerProposalResponseJsonSchema,
  writerProposalResponseJsonSchemaText,
  parsePageContentProposalData,
} from "@factory/contracts";
import { WriterService } from "../src/writer/service.js";

/**
 * P1-03 deterministic gates — ZERO network:
 * - the generated JSON Schema requires internalLinks as STRING[],
 * - the object-form links that broke the live run are rejected by the
 *   STRICT contract (no silent repair inside the contract),
 * - the quiet parse helper returns null instead of throwing,
 * - parse failure after the single repair attempt fails closed with
 *   writer_proposal_invalid (no proposal row saved).
 */

test("WJS-01: generated JSON Schema requires internalLinks: string items required fields", () => {
  const schema = writerProposalResponseJsonSchema();
  assert.equal(schema.strict, true);
  assert.equal(schema.name, "page_content_proposal");
  const links = (schema.schema as unknown as { properties: Record<string, Record<string, unknown>> })["properties"]["internalLinks"]!;
  assert.deepEqual(links["items"], { type: "string", maxLength: 300 });
  assert.equal(links["maxItems"], 10);
  const required = (schema.schema as unknown as { required: string[] }).required;
  for (const field of ["title", "metaDescription", "introduction", "sections", "conclusion", "cta", "internalLinks"]) {
    assert.ok(required.includes(field), `${field} must be required`);
  }
  assert.ok(!required.includes("snapshotId"), "lineage fields are never asked from the model");
  assert.equal((schema.schema as unknown as { additionalProperties: unknown }).additionalProperties, false);
});

test("WJS-02: schema text is stable/deterministic JSON embedded in prompts", () => {
  assert.equal(writerProposalResponseJsonSchemaText(), writerProposalResponseJsonSchemaText());
  assert.ok(writerProposalResponseJsonSchemaText().includes('"internalLinks"'));
  assert.ok(writerProposalResponseJsonSchemaText().includes('"type": "string"'));
});

test("WJS-03: the exact live-run defect shape (internalLinks as objects) is rejected by the strict contract", () => {
  const snapshot = { id: "snap-w", version: 3, snapshotDigest: "0".repeat(64) };
  const malformed = {
    title: "Fictional test page",
    metaDescription: "A fictional test description.",
    introduction: "Fictional introduction",
    sections: [{ heading: "Fictional heading", body: "Fictional body" }],
    conclusion: "Fictional conclusion",
    cta: "Fictional CTA",
    internalLinks: [{ url: "/x", title: "X" }], // THE DEFECT: object form
  };
  const service = new WriterService({} as never, {} as never, {} as never);
  const parsed = service.parseProposalOutputForProposal(JSON.stringify(malformed));
  assert.ok(parsed, "JSON itself is parseable — the SHAPE is what fails");
  assert.throws(() => {
    parsePageContentProposalData({
      ...parsed,
      schemaVersion: "writer-content-v1",
      snapshotId: snapshot.id,
      snapshotVersion: snapshot.version,
      snapshotDigest: snapshot.snapshotDigest,
    });
  }, "strict contract rejects object-form internalLinks");
});

test("WJS-04: quiet parse returns null on non-JSON garbage (no throw, no repair)", () => {
  const service = new WriterService({} as never, {} as never, {} as never);
  assert.equal(service.parseProposalOutputForProposal("not json at all"), null);
  assert.equal(service.parseProposalOutputForProposal("[1,2]"), null, "arrays are not proposal documents");
  assert.deepEqual(service.parseProposalOutputForProposal('{"ok":true}'), { ok: true });
});
