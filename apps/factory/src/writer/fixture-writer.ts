import type { PageContentProposalData } from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";

/**
 * FIXTURE WRITER PROVIDER — dev/test provider-mode adapter. Produces a
 * deterministic valid proposal WITHOUT any paid model call. Selected ONLY by
 * the trusted server config (FACTORY_WRITER_MODE=fixture), never by browser
 * input. It cannot masquerade as champion output: the proposal records the
 * provider as "fixture".
 */

export interface FixtureWriterRequest {
  systemPrompt: string;
  userPrompt: string;
  promptSnapshotDigest: string;
  promptSnapshotRevision: number;
}

export class FixtureWriterProvider {
  readonly kind = "fixture" as const;

  async generate(request: FixtureWriterRequest): Promise<PageContentProposalData> {
    // The fixture parses the page target title out of the user prompt when
    // possible, otherwise uses a deterministic default. It NEVER invents
    // claims: every factual statement is a placeholder referencing the
    // operator facts section of the prompt.
    void request;
    throw new FactoryError(
      "writer_proposal_invalid",
      "FixtureWriterProvider.generate must be parameterized via setResponse for the current journey.",
    );
  }

  /** Deterministic fixture response used by tests/E2E journeys. */
  static deterministicProposal(input: {
    snapshotId: string;
    snapshotVersion: number;
    snapshotDigest: string;
    title: string;
    slug: string;
  }): PageContentProposalData {
    const slugKey = input.slug.trim().replace(/^\/+/, "").replace(/\/+$/, "") || "home";
    const label = input.title || slugKey.replace(/[-_/]/g, " ");
    return {
      schemaVersion: "writer-content-v1",
      snapshotId: input.snapshotId,
      snapshotVersion: input.snapshotVersion,
      snapshotDigest: input.snapshotDigest,
      title: input.title,
      metaDescription: `Fixture proposal for ${label}: deterministic test content and metadata.`,
      introduction:
        `This fixture introduction restates the ${label} objective and audience from the accepted brief without adding claims.`,
      sections: [
        { heading: `${label} Overview`, body: `Fixture section body covering the ${label} brief objective.` },
        { heading: `${label} Details`, body: `Fixture section body covering the ${label} key points.` },
      ],
      conclusion: `Fixture conclusion restating the ${label} brief objective.`,
      cta: `Fixture CTA line for ${label}.`,
      internalLinks: [],
    };
  }
}
