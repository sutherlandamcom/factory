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
    language?: string;
    ctaText?: string;
  }): PageContentProposalData {
    const slugKey = input.slug.trim().replace(/^\/+/, "").replace(/\/+$/, "") || "home";
    const label = input.title || slugKey.replace(/[-_/]/g, " ");
    if (input.language?.toLowerCase().startsWith("ru")) return {
      schemaVersion: "writer-content-v1", snapshotId: input.snapshotId, snapshotVersion: input.snapshotVersion, snapshotDigest: input.snapshotDigest,
      title: input.title,
      metaDescription: `Изолированный тестовый материал: ${label}. Синтетический пример без производственных полномочий.`,
      introduction: `Это тестовый материал о теме «${label}». Он не подтверждает факты о предприятии или его сотрудниках.`,
      sections: [{ heading: `${label}: задача`, body: "Тестовый пример структуры для обсуждения производственной задачи." }, { heading: `${label}: порядок обсуждения`, body: "Описание задачи требует проверки оператором и подтверждённых источников." }],
      conclusion: "Тестовый пример не является подтверждением производственных показателей.",
      cta: input.ctaText ?? "Обсудить производственную задачу", internalLinks: [],
    };
    return {
      schemaVersion: "writer-content-v1",
      snapshotId: input.snapshotId,
      snapshotVersion: input.snapshotVersion,
      snapshotDigest: input.snapshotDigest,
      title: input.title,
      metaDescription: `Comprehensive proposal for ${label}: verified content and structured metadata.`,
      introduction:
        `This introduction presents the ${label} objective and audience from the accepted brief without adding unverified claims.`,
      sections: [
        { heading: `${label} Overview`, body: `Detailed section covering the ${label} brief objective.` },
        { heading: `${label} Details`, body: `Operational section covering the ${label} key points.` },
      ],
      conclusion: `Concluding summary covering the ${label} brief objective.`,
      cta: `Contact our team for ${label}.`,
      internalLinks: [],
    };
  }
}
