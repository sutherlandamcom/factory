import type { SerpSnapshotData, SearchUsage } from "@factory/contracts";

/**
 * StructuredSerpProvider — the exact-measurement boundary.
 *
 * WHAT THE SEARCH ENGINE RETURNED. Implementations acquire real SERP
 * evidence for a normalized query and return provider-native data in a
 * bounded, auditable form. Implementations must:
 * - never fabricate absent capabilities (UNKNOWN is represented by absent
 *   optional fields);
 * - never include credentials in results or errors;
 * - expose truthful usage/cost telemetry when the provider reports it
 *   (null/UNKNOWN otherwise).
 */
export interface SerpAcquisitionRequest {
  query: string;
  location: string | null;
  language: string | null;
  device: "desktop" | "mobile" | "tablet";
}

export interface SerpAcquisitionResult {
  data: SerpSnapshotData;
  rawPayload: unknown;
  providerRequestId: string | null;
  observedAt: Date;
  usage: SearchUsage | null;
}

export interface SerpProviderConfigured {
  configured: true;
}

export interface SerpProviderNotConfigured {
  configured: false;
  /** Human-readable reason for Dashboard readiness display (no secrets). */
  reason: string;
}

export type SerpProviderReadiness = SerpProviderConfigured | SerpProviderNotConfigured;

export interface StructuredSerpProvider {
  readonly id: string;
  readiness(): Promise<SerpProviderReadiness> | SerpProviderReadiness;
  acquire(request: SerpAcquisitionRequest): Promise<SerpAcquisitionResult>;
}
