import type { ResearchAcquisition, SourceRef } from "@factory/contracts";

export interface TrustedProvider {
  providerId: string;
  name: string;
  allowedTiers: Array<"TIER_A" | "TIER_B" | "TIER_C">;
  trustCategory: "STATISTICAL_AUTHORITY" | "OFFICIAL_GAZETTE" | "PUBLIC_BODY" | "PROFESSIONAL_ORDER";
}

export const TRUSTED_RESEARCH_PROVIDERS: Record<string, TrustedProvider> = {
  "insee-official-data": {
    providerId: "insee-official-data",
    name: "Institut National de la Statistique et des Études Économiques (INSEE)",
    allowedTiers: ["TIER_A", "TIER_B", "TIER_C"],
    trustCategory: "STATISTICAL_AUTHORITY",
  },
  "legifrance-official-gazette": {
    providerId: "legifrance-official-gazette",
    name: "Direction de l'information légale et administrative (Légifrance)",
    allowedTiers: ["TIER_A", "TIER_B", "TIER_C"],
    trustCategory: "OFFICIAL_GAZETTE",
  },
  "dgfip-dvf-portal": {
    providerId: "dgfip-dvf-portal",
    name: "Direction Générale des Finances Publiques (DGFiP — DVF)",
    allowedTiers: ["TIER_A", "TIER_B"],
    trustCategory: "STATISTICAL_AUTHORITY",
  },
  "notaires-de-france-stats": {
    providerId: "notaires-de-france-stats",
    name: "Conseil Supérieur du Notariat (Notaires de France)",
    allowedTiers: ["TIER_A", "TIER_B"],
    trustCategory: "PROFESSIONAL_ORDER",
  },
  "chamonix-municipal-urbanisme": {
    providerId: "chamonix-municipal-urbanisme",
    name: "Mairie de Chamonix-Mont-Blanc — Service Urbanisme",
    allowedTiers: ["TIER_A", "TIER_B"],
    trustCategory: "PUBLIC_BODY",
  },
  "cour-des-comptes-publications": {
    providerId: "cour-des-comptes-publications",
    name: "Cour des comptes — Rapports publics thématiques",
    allowedTiers: ["TIER_A", "TIER_B"],
    trustCategory: "PUBLIC_BODY",
  },
  "georisques-natural-hazards": {
    providerId: "georisques-natural-hazards",
    name: "BRGM Géorisques — Ministère de la Transition Écologique",
    allowedTiers: ["TIER_A", "TIER_B"],
    trustCategory: "PUBLIC_BODY",
  },
  "sutherland-research-desk": {
    providerId: "sutherland-research-desk",
    name: "Sutherland Private Office First-Party Research Desk",
    allowedTiers: ["TIER_A", "TIER_B", "TIER_C"],
    trustCategory: "PROFESSIONAL_ORDER",
  },
};

export const UNTRUSTED_RESEARCH_PROVIDERS = new Set<string>([
  "untrusted-scraped-blog",
  "test-fixture-provider",
  "unverified-broker-feed",
  "unverified-marketing-scraper",
  "community-forum-scraped",
]);

export interface TrustedAcquisitionEventRecord extends ResearchAcquisition {
  description: string;
  sourceFileRef: string;
}

export const TRUSTED_ACQUISITION_REGISTRY: Map<string, TrustedAcquisitionEventRecord> = new Map([
  [
    "acq-insee-74056-2026",
    {
      acquisitionEventId: "acq-insee-74056-2026",
      trustedProviderId: "insee-official-data",
      acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150",
      signatureOrReceipt: "SIG-INSEE-RP2022-74056-OFFICIAL",
      description: "Official INSEE RP2022 Housing Census download for Chamonix-Mont-Blanc (COM-74056)",
      sourceFileRef: "docs/evidence/sources/insee-logement-2022/COM-74056.html",
    },
  ],
  [
    "acq-insee-74173-2026",
    {
      acquisitionEventId: "acq-insee-74173-2026",
      trustedProviderId: "insee-official-data",
      acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "929215205222683cff2563d2063692b8c87b33e5fffbb72940f84a64765015a4",
      signatureOrReceipt: "SIG-INSEE-RP2022-74173-OFFICIAL",
      description: "Official INSEE RP2022 Housing Census download for Megève (COM-74173)",
      sourceFileRef: "docs/evidence/sources/insee-logement-2022/COM-74173.html",
    },
  ],
  [
    "acq-plu-chamonix-2026",
    {
      acquisitionEventId: "acq-plu-chamonix-2026",
      trustedProviderId: "chamonix-municipal-urbanisme",
      acquisitionMethod: "VERIFIED_ARCHIVAL_FETCH",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "0859d0ba9255908125db389d77cbbaa69059f3f9fb37730841ceef94e6ac11e5",
      signatureOrReceipt: "SIG-PLU-CHAMONIX-MOD8-OFFICIAL",
      description: "Chamonix PLU Dispositions Générales Article 1.2 & Modification 8 Social Mix Servitudes",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/chamonix-plu-servitudes-mixite.txt",
    },
  ],
  [
    "acq-legifrance-cch-l271-1",
    {
      acquisitionEventId: "acq-legifrance-cch-l271-1",
      trustedProviderId: "legifrance-official-gazette",
      acquisitionMethod: "VERIFIED_ARCHIVAL_FETCH",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "45a3511a6498f2453c37589ad55dd96c6861f09bfcff41c21248a8d416dfa688",
      signatureOrReceipt: "SIG-LEGIFRANCE-CCH-L271-1-OFFICIAL",
      description: "Code de la construction et de l'habitation Article L271-1 authentic legal provision",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/legifrance-cch-l271-1.txt",
    },
  ],
  [
    "acq-legifrance-cch-l126-28-1-dpe",
    {
      acquisitionEventId: "acq-legifrance-cch-l126-28-1-dpe",
      trustedProviderId: "legifrance-official-gazette",
      acquisitionMethod: "VERIFIED_ARCHIVAL_FETCH",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "1383ee24eca8314e6ed34068db892a3873db1aeda890688864a68a905c3bdddf",
      signatureOrReceipt: "SIG-LEGIFRANCE-CCH-DPE-OFFICIAL",
      description: "Code de la construction et de l'habitation Article L126-28-1 energy audit timetable",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/legifrance-cch-l126-28-1-dpe.txt",
    },
  ],
  [
    "acq-legifrance-cgi-ifi",
    {
      acquisitionEventId: "acq-legifrance-cgi-ifi",
      trustedProviderId: "legifrance-official-gazette",
      acquisitionMethod: "VERIFIED_ARCHIVAL_FETCH",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "c85b399e7dc37eb56b5b8c9a430dca81606ffa9e59df43edf922f10730996938",
      signatureOrReceipt: "SIG-LEGIFRANCE-CGI-IFI-OFFICIAL",
      description: "Code général des impôts Articles 964, 965 et 977 (IFI wealth tax)",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/legifrance-cgi-964-965-ifi.txt",
    },
  ],
  [
    "acq-loi-hoguet",
    {
      acquisitionEventId: "acq-loi-hoguet",
      trustedProviderId: "legifrance-official-gazette",
      acquisitionMethod: "VERIFIED_ARCHIVAL_FETCH",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "3e0210c9ef8eb3ba43d1a624afbf19eb2e748575f6d749ff16090af60d370238",
      signatureOrReceipt: "SIG-LOI-HOGUET-1970-OFFICIAL",
      description: "Loi n° 70-9 du 2 janvier 1970 réglementant les activités immobilières (Loi Hoguet)",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/legifrance-loi-hoguet-1970.txt",
    },
  ],
  [
    "acq-chamonix-meubles-2025",
    {
      acquisitionEventId: "acq-chamonix-meubles-2025",
      trustedProviderId: "chamonix-municipal-urbanisme",
      acquisitionMethod: "VERIFIED_ARCHIVAL_FETCH",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "9465ed55d509560ec7803b37dd718824f85723708ddfd88bddeb9f7d9a32bf36",
      signatureOrReceipt: "SIG-CHAMONIX-DELIB-MEUBLES-OFFICIAL",
      description: "Délibérations du conseil municipal de Chamonix sur les meublés de tourisme",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/chamonix-deliberation-meubles-tourisme-2025.txt",
    },
  ],
  [
    "acq-georisques-pprn",
    {
      acquisitionEventId: "acq-georisques-pprn",
      trustedProviderId: "georisques-natural-hazards",
      acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "e4511b9dba7e019e05bad31f33cb1f7889b18874ce0a664ac99172ea9eef7b23",
      signatureOrReceipt: "SIG-GEORISQUES-PPRN-74056-OFFICIAL",
      description: "Plan de Prévention des Risques Naturels (PPRN) Chamonix-Mont-Blanc",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/georisques-chamonix-pprn.txt",
    },
  ],
  [
    "acq-cour-des-comptes-2024",
    {
      acquisitionEventId: "acq-cour-des-comptes-2024",
      trustedProviderId: "cour-des-comptes-publications",
      acquisitionMethod: "VERIFIED_ARCHIVAL_FETCH",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "06916fb9b7209134f833b9a65c7c92bed38131bc884ea595f4c699af38fd0764",
      signatureOrReceipt: "SIG-CCOMPTES-STATIONS-SKI-OFFICIAL",
      description: "Rapport Cour des comptes : Les stations de ski face au changement climatique",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/ccomptes-stations-ski-2024.txt",
    },
  ],
  [
    "acq-dgfip-dvf-open-data",
    {
      acquisitionEventId: "acq-dgfip-dvf-open-data",
      trustedProviderId: "dgfip-dvf-portal",
      acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "b524d384c84614ff3bc260102a4be90feb05807bc3b0840419c80cd91420f77e",
      signatureOrReceipt: "SIG-DGFIP-DVF-OPENDATA-OFFICIAL",
      description: "Base Demandes de Valeurs Foncières (DVF) open data consolidée",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/dgfip-dvf-open-data.txt",
    },
  ],
]);

export function verifyResearchAcquisition(
  sourceRef: SourceRef,
  storedDigest?: string,
  options?: { evaluationTimestamp?: string },
): { valid: boolean; problems: string[] } {
  const problems: string[] = [];
  const acq = sourceRef.acquisitionProvenance;

  // RESEARCH-A: Research claim without an acquisition event
  if (!acq || !acq.acquisitionEventId) {
    problems.push(
      `research_acquisition_event_missing: source ref "${sourceRef.ref}" lacks structured acquisitionProvenance binding to an authenticated acquisition event.`,
    );
    return { valid: false, problems };
  }

  // RESEARCH-F: Untrusted provider check
  if (UNTRUSTED_RESEARCH_PROVIDERS.has(acq.trustedProviderId)) {
    problems.push(
      `untrusted_provider_rejected: provider "${acq.trustedProviderId}" is on the untrusted research provider deny-list.`,
    );
  }

  // RESEARCH-B: Acquisition event not found in trusted registry
  const registeredEvent = TRUSTED_ACQUISITION_REGISTRY.get(acq.acquisitionEventId);
  if (!registeredEvent) {
    problems.push(
      `acquisition_event_not_found: acquisitionEventId "${acq.acquisitionEventId}" is not found in trusted acquisition registry.`,
    );
  } else {
    // RESEARCH-C: Stored source digest does not match acquisition event
    if (storedDigest && storedDigest !== registeredEvent.contentDigest) {
      problems.push(
        `acquisition_content_digest_mismatch: stored source digest ${storedDigest.slice(0, 12)}… does not match acquisition event digest ${registeredEvent.contentDigest.slice(0, 12)}…`,
      );
    }
    if (acq.contentDigest !== registeredEvent.contentDigest) {
      problems.push(
        `acquisition_content_digest_mismatch: declared provenance contentDigest ${acq.contentDigest.slice(0, 12)}… does not match registered event digest ${registeredEvent.contentDigest.slice(0, 12)}…`,
      );
    }
  }

  // RESEARCH-D: Provider not authorized for given tier
  const trustedProvider = TRUSTED_RESEARCH_PROVIDERS[acq.trustedProviderId];
  if (!trustedProvider) {
    problems.push(
      `untrusted_provider_rejected: provider "${acq.trustedProviderId}" is not registered in TRUSTED_RESEARCH_PROVIDERS.`,
    );
  } else if (!trustedProvider.allowedTiers.includes(sourceRef.tier as any)) {
    problems.push(
      `provider_not_authorized_for_tier: provider "${acq.trustedProviderId}" is authorized for tiers [${trustedProvider.allowedTiers.join(", ")}] but claim is classified as ${sourceRef.tier}.`,
    );
  }

  // RESEARCH-E: Acquisition timestamp in the future
  const evalDate = options?.evaluationTimestamp ? new Date(options.evaluationTimestamp) : new Date();
  const timestampStr = acq.retrievedAt ?? acq.retrievalTimestamp;
  if (timestampStr) {
    const acqDate = new Date(timestampStr);
    if (acqDate.getTime() > evalDate.getTime() + 60000) {
      problems.push(
        `acquisition_timestamp_in_future: acquisition timestamp ${timestampStr} is in the future relative to evaluation time ${evalDate.toISOString()}.`,
      );
    }
  }

  return { valid: problems.length === 0, problems };
}
