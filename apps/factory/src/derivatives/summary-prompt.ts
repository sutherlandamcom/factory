import type {
  EffectiveSummarySettings,
  SummaryPromptSnapshotData,
} from "@factory/contracts";
import { deterministicDigest } from "../intelligence/digest.js";

/**
 * SUMMARY PROMPT COMPILER — Run 10.
 *
 * Compiles the exact prompt packet sent to the page_summarizer. The prompt
 * is deterministic given its inputs (content digest, settings, language,
 * provider identity): identical inputs always produce an identical compiled
 * prompt and digest. The summarizer receives ONLY the exact accepted page
 * content — never mutable/unaccepted material.
 */

export const SUMMARY_POLICY_VERSION = "summary-instructions-v1";

/** Bounded output ceiling for one summary invocation (tokens). */
export const SUMMARY_MAX_OUTPUT_TOKENS = 2_000;

export const SUMMARY_SYSTEM_PROMPT = [
  "You are the Factory page_summarizer. You summarize accepted website page content for visitors.",
  "Rules (all mandatory):",
  "1. Summarize ONLY the supplied page content. Never add outside facts, evidence, or claims.",
  "2. Preserve factual meaning exactly. Never strengthen, weaken, or reinterpret a claim.",
  "3. Preserve every number, percentage, price, and quantity exactly as written.",
  "4. Preserve named entities exactly (people, companies, places, products).",
  "5. Preserve important qualifications and uncertainty (estimates stay estimates).",
  "6. Never invent evidence, statistics, credentials, reviews, or sources.",
  "7. Never add recommendations, advice, or next-step suggestions.",
  "8. Never add a call to action or contact prompt.",
  "9. Never add SEO keywords or optimize for search; this summary is for readers, not rankings.",
  "10. Never claim information absent from the source.",
  "11. Write in plain, neutral prose. No headings, no bullet lists, no markdown.",
  "12. Answer with ONLY the summary text.",
].join(" ");

export function compileSummaryPrompt(input: {
  projectId: string;
  pageIdentity: string;
  intentSnapshot: { id: string; digest: string };
  acceptedContent: { id: string; version: number; digest: string };
  content: { title: string; introduction: string; sections: Array<{ heading: string; body: string }>; conclusion: string };
  effectiveSummary: EffectiveSummarySettings;
  provider: string;
  model: string;
}): { data: SummaryPromptSnapshotData; promptDigest: string } {
  const sourceText = [
    `TITLE: ${input.content.title}`,
    `INTRODUCTION: ${input.content.introduction}`,
    ...input.content.sections.map((s) => `SECTION: ${s.heading}\n${s.body}`),
    `CONCLUSION: ${input.content.conclusion}`,
  ].join("\n\n");

  const userPrompt = [
    `Summarize the following accepted page content in ${input.effectiveSummary.language}.`,
    `Write ${120} to ${400} words of flowing prose. Preserve all qualifications.`,
    "The summary is shown to visitors under an \"AI-generated summary\" disclosure.",
    "",
    "ACCEPTED PAGE CONTENT FOLLOWS:",
    sourceText,
  ].join("\n");

  const data: SummaryPromptSnapshotData = {
    schemaVersion: "derivatives-v1",
    projectId: input.projectId,
    pageIdentity: input.pageIdentity,
    intentSnapshot: input.intentSnapshot,
    acceptedContent: input.acceptedContent,
    summaryPolicyVersion: SUMMARY_POLICY_VERSION,
    language: input.effectiveSummary.language,
    provider: input.provider,
    model: input.model,
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    userPrompt,
    maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
  };

  const promptDigest = deterministicDigest({
    schemaVersion: data.schemaVersion,
    projectId: data.projectId,
    pageIdentity: data.pageIdentity,
    intentSnapshot: data.intentSnapshot,
    acceptedContent: data.acceptedContent,
    summaryPolicyVersion: data.summaryPolicyVersion,
    language: data.language,
    provider: data.provider,
    model: data.model,
    systemPrompt: data.systemPrompt,
    userPrompt: data.userPrompt,
    maxOutputTokens: data.maxOutputTokens,
  });

  return { data, promptDigest };
}
