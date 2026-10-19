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
      actualRequestedUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
      finalResponseUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
      acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150",
      signatureOrReceipt: "INSEE-HTTP-200-ETAG-8581193-74056",
      sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
      description: "Official INSEE RP2022 Housing Census download for Chamonix-Mont-Blanc (COM-74056)",
      sourceFileRef: "docs/evidence/sources/insee-logement-2022/COM-74056.html",
    },
  ],
  [
    "acq-insee-rp2022-74056",
    {
      acquisitionEventId: "acq-insee-rp2022-74056",
      trustedProviderId: "insee-official-data",
      actualRequestedUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
      finalResponseUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
      acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150",
      signatureOrReceipt: "INSEE-HTTP-200-ETAG-8581193-74056",
      sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
      description: "Official INSEE RP2022 Housing Census download for Chamonix-Mont-Blanc (COM-74056)",
      sourceFileRef: "docs/evidence/sources/insee-logement-2022/COM-74056.html",
    },
  ],
  [
    "acq-insee-74173-2026",
    {
      acquisitionEventId: "acq-insee-74173-2026",
      trustedProviderId: "insee-official-data",
      actualRequestedUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74173",
      finalResponseUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74173",
      acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "929215205222683cff2563d2063692b8c87b33e5fffbb72940f84a64765015a4",
      signatureOrReceipt: "INSEE-HTTP-200-ETAG-8581193-74173",
      sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
      description: "Official INSEE RP2022 Housing Census download for Megève (COM-74173)",
      sourceFileRef: "docs/evidence/sources/insee-logement-2022/COM-74173.html",
    },
  ],
  [
    "acq-insee-rp2022-74173",
    {
      acquisitionEventId: "acq-insee-rp2022-74173",
      trustedProviderId: "insee-official-data",
      actualRequestedUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74173",
      finalResponseUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74173",
      acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "929215205222683cff2563d2063692b8c87b33e5fffbb72940f84a64765015a4",
      signatureOrReceipt: "INSEE-HTTP-200-ETAG-8581193-74173",
      sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
      description: "Official INSEE RP2022 Housing Census download for Megève (COM-74173)",
      sourceFileRef: "docs/evidence/sources/insee-logement-2022/COM-74173.html",
    },
  ],
  [
    "acq-plu-chamonix-2026-reglement-raw",
    {
      acquisitionEventId: "acq-plu-chamonix-2026-reglement-raw",
      trustedProviderId: "chamonix-municipal-urbanisme",
      actualRequestedUrl: "https://www.geoportail-urbanisme.gouv.fr/document/by-id/beaa82a7b5594b3913d5156928287d07",
      finalResponseUrl: "https://data.geopf.fr/annexes/gpu/documents/DU_74056/beaa82a7b5594b3913d5156928287d07/74056_reglement_20260226.pdf",
      acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
      retrievedAt: "2026-10-18T21:11:38Z",
      contentDigest: "25425f385c72a88d3607a0314db9166efe9add139ca45314e124d3eb9bac707f",
      signatureOrReceipt: "GPU-HTTP-200-ETAG-e860875a86a1b39f07934fb3e098fc9d-1",
      sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
      description: "Plan Local d'Urbanisme de Chamonix-Mont-Blanc - Règlement officiel approuvé le 26 février 2026 (74056_reglement_20260226.pdf)",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/74056_reglement_20260226.pdf",
    },
  ],
  [
    "acq-plu-chamonix-2026-extract",
    {
      acquisitionEventId: "acq-plu-chamonix-2026-extract",
      trustedProviderId: "chamonix-municipal-urbanisme",
      actualRequestedUrl: "https://www.geoportail-urbanisme.gouv.fr/document/by-id/beaa82a7b5594b3913d5156928287d07",
      finalResponseUrl: "https://data.geopf.fr/annexes/gpu/documents/DU_74056/beaa82a7b5594b3913d5156928287d07/74056_reglement_20260226.pdf",
      acquisitionMethod: "VERIFIED_ARCHIVAL_FETCH",
      retrievedAt: "2026-10-18T21:11:38Z",
      contentDigest: "d16422afa2deebbda53feb8aef0f9b509ba14bc35963678d8fb4bc6c8480f397",
      signatureOrReceipt: "CHAMONIX-PLU-VERBATIM-EXTRACT-20260226",
      sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
      description: "Chamonix PLU 2026 verbatim regulatory extracts (UA3, Art 1 Note 1, Art 6.6-6.7, Art 10-11, UT3)",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/chamonix-plu-servitudes-mixite.txt",
    },
  ],
  [
    "acq-plu-chamonix-2026",
    {
      acquisitionEventId: "acq-plu-chamonix-2026",
      trustedProviderId: "chamonix-municipal-urbanisme",
      actualRequestedUrl: "https://www.geoportail-urbanisme.gouv.fr/document/by-id/beaa82a7b5594b3913d5156928287d07",
      finalResponseUrl: "https://data.geopf.fr/annexes/gpu/documents/DU_74056/beaa82a7b5594b3913d5156928287d07/74056_reglement_20260226.pdf",
      acquisitionMethod: "VERIFIED_ARCHIVAL_FETCH",
      retrievedAt: "2026-10-18T21:11:38Z",
      contentDigest: "d16422afa2deebbda53feb8aef0f9b509ba14bc35963678d8fb4bc6c8480f397",
      signatureOrReceipt: "CHAMONIX-PLU-VERBATIM-EXTRACT-20260226",
      sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
      description: "Chamonix PLU 2026 verbatim regulatory extracts (UA3, Art 1 Note 1, Art 6.6-6.7, Art 10-11, UT3)",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/chamonix-plu-servitudes-mixite.txt",
    },
  ],
  [
    "acq-legifrance-cch-l271-1",
    {
      acquisitionEventId: "acq-legifrance-cch-l271-1",
      trustedProviderId: "legifrance-official-gazette",
      actualRequestedUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000031000677/",
      finalResponseUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000031000677/",
      acquisitionMethod: "VERIFIED_ARCHIVAL_FETCH",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "45a3511a6498f2453c37589ad55dd96c6861f09bfcff41c21248a8d416dfa688",
      signatureOrReceipt: "LEGIFRANCE-API-JO-CCH-L271-1",
      sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
      description: "Code de la construction et de l'habitation Article L271-1 authentic legal provision",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/legifrance-cch-l271-1.txt",
    },
  ],
  [
    "acq-legifrance-cch-l126-28-1-dpe",
    {
      acquisitionEventId: "acq-legifrance-cch-l126-28-1-dpe",
      trustedProviderId: "legifrance-official-gazette",
      actualRequestedUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000043977341/",
      finalResponseUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000043977341/",
      acquisitionMethod: "VERIFIED_ARCHIVAL_FETCH",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "1383ee24eca8314e6ed34068db892a3873db1aeda890688864a68a905c3bdddf",
      signatureOrReceipt: "LEGIFRANCE-API-JO-CCH-L126-28-1",
      sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
      description: "Code de la construction et de l'habitation Article L126-28-1 energy audit timetable",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/legifrance-cch-l126-28-1-dpe.txt",
    },
  ],
  [
    "acq-legifrance-cgi-ifi",
    {
      acquisitionEventId: "acq-legifrance-cgi-ifi",
      trustedProviderId: "legifrance-official-gazette",
      actualRequestedUrl: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006069577/LEGISCTA000036385038/",
      finalResponseUrl: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006069577/LEGISCTA000036385038/",
      acquisitionMethod: "VERIFIED_ARCHIVAL_FETCH",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "c85b399e7dc37eb56b5b8c9a430dca81606ffa9e59df43edf922f10730996938",
      signatureOrReceipt: "LEGIFRANCE-API-JO-CGI-964-965",
      sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
      description: "Code général des impôts Articles 964, 965 et 977 (IFI wealth tax)",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/legifrance-cgi-964-965-ifi.txt",
    },
  ],
  [
    "acq-loi-hoguet",
    {
      acquisitionEventId: "acq-loi-hoguet",
      trustedProviderId: "legifrance-official-gazette",
      actualRequestedUrl: "https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000512228",
      finalResponseUrl: "https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000512228",
      acquisitionMethod: "VERIFIED_ARCHIVAL_FETCH",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "3e0210c9ef8eb3ba43d1a624afbf19eb2e748575f6d749ff16090af60d370238",
      signatureOrReceipt: "LEGIFRANCE-API-JO-LOI-70-9",
      sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
      description: "Loi n° 70-9 du 2 janvier 1970 réglementant les activités immobilières (Loi Hoguet)",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/legifrance-loi-hoguet-1970.txt",
    },
  ],
  [
    "acq-chamonix-meubles-2025",
    {
      acquisitionEventId: "acq-chamonix-meubles-2025",
      trustedProviderId: "chamonix-municipal-urbanisme",
      actualRequestedUrl: "https://www.chamonix.fr/meubles-de-tourisme-reglementation",
      finalResponseUrl: "https://www.chamonix.fr/meubles-de-tourisme-reglementation",
      acquisitionMethod: "VERIFIED_ARCHIVAL_FETCH",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "9465ed55d509560ec7803b37dd718824f85723708ddfd88bddeb9f7d9a32bf36",
      signatureOrReceipt: "CHAMONIX-DELIB-MEUBLES-20250501",
      sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
      description: "Délibérations du conseil municipal de Chamonix sur les meublés de tourisme",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/chamonix-deliberation-meubles-tourisme-2025.txt",
    },
  ],
  [
    "acq-georisques-pprn",
    {
      acquisitionEventId: "acq-georisques-pprn",
      trustedProviderId: "georisques-natural-hazards",
      actualRequestedUrl: "https://www.georisques.gouv.fr/mes-risques/connaitre-les-risques-pres-de-chez-moi/rapport2?form-adresse=true&isCadastre=false&city=Chamonix-Mont-Blanc&type=commune&codeInsee=74056",
      finalResponseUrl: "https://www.georisques.gouv.fr/mes-risques/connaitre-les-risques-pres-de-chez-moi/rapport2?form-adresse=true&isCadastre=false&city=Chamonix-Mont-Blanc&type=commune&codeInsee=74056",
      acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "e4511b9dba7e019e05bad31f33cb1f7889b18874ce0a664ac99172ea9eef7b23",
      signatureOrReceipt: "GEORISQUES-HTTP-200-PPRN-74056",
      sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
      description: "Plan de Prévention des Risques Naturels (PPRN) Chamonix-Mont-Blanc",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/georisques-chamonix-pprn.txt",
    },
  ],
  [
    "acq-cour-des-comptes-2024",
    {
      acquisitionEventId: "acq-cour-des-comptes-2024",
      trustedProviderId: "cour-des-comptes-publications",
      actualRequestedUrl: "https://www.ccomptes.fr/fr/publications/les-stations-de-ski-face-au-changement-climatique",
      finalResponseUrl: "https://www.ccomptes.fr/fr/publications/les-stations-de-ski-face-au-changement-climatique",
      acquisitionMethod: "VERIFIED_ARCHIVAL_FETCH",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "06916fb9b7209134f833b9a65c7c92bed38131bc884ea595f4c699af38fd0764",
      signatureOrReceipt: "CCOMPTES-RAPPORT-PUBLIC-202402",
      sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
      description: "Rapport Cour des comptes : Les stations de ski face au changement climatique",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/ccomptes-stations-ski-2024.txt",
    },
  ],
  [
    "acq-dgfip-dvf-open-data",
    {
      acquisitionEventId: "acq-dgfip-dvf-open-data",
      trustedProviderId: "dgfip-dvf-portal",
      actualRequestedUrl: "https://app.dvf.etalab.gouv.fr/",
      finalResponseUrl: "https://app.dvf.etalab.gouv.fr/",
      acquisitionMethod: "OFFICIAL_PORTAL_DOWNLOAD",
      retrievedAt: "2026-10-18T10:00:00Z",
      contentDigest: "b524d384c84614ff3bc260102a4be90feb05807bc3b0840419c80cd91420f77e",
      signatureOrReceipt: "DGFIP-OPEN-DATA-ETALAB-DVF-2025",
      sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL",
      description: "Base Demandes de Valeurs Foncières (DVF) open data consolidée",
      sourceFileRef: "docs/evidence/sources/legal-regulatory-2026/dgfip-dvf-open-data.txt",
    },
  ],
]);


import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

function findRepoRoot(startDir: string): string {
  let cur = startDir;
  while (cur !== path.dirname(cur)) {
    if (existsSync(path.join(cur, "package.json")) && existsSync(path.join(cur, "pnpm-workspace.yaml"))) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  return process.cwd();
}

export function verifyResearchAcquisition(
  sourceRef: SourceRef,
  storedDigest?: string,
  options?: { evaluationTimestamp?: string; repoRoot?: string; checkDisk?: boolean },
): { valid: boolean; problems: string[] } {
  const problems: string[] = [];
  const acq = sourceRef.acquisitionProvenance;

  // RESEARCH-A / ACQ-05: Research claim without an acquisition event
  if (!acq || !acq.acquisitionEventId) {
    problems.push(
      `research_acquisition_event_missing: source ref "${sourceRef.ref}" lacks structured acquisitionProvenance binding to an authenticated acquisition event.`,
    );
    return { valid: false, problems };
  }

  // ACQ-07: Synthetic test fixture claimed as real external research
  if (
    sourceRef.evidenceOrigin === "SYNTHETIC_FIXTURE" ||
    /\b(?:synthetic[_\s-]*fixture|fixture[_\s-]*provider|mock[_\s-]*serp|synthetic[_\s-]*serp|synthetic[_\s-]*competitor)\b/i.test(sourceRef.ref) ||
    /\b(?:synthetic[_\s-]*fixture|fixture[_\s-]*provider|mock[_\s-]*serp|synthetic[_\s-]*serp|synthetic[_\s-]*competitor)\b/i.test(sourceRef.sourceUrl ?? "")
  ) {
    problems.push(
      "synthetic_fixture_research_rejected: Synthetic competitor/SERP fixtures cannot be promoted to authenticated external research evidence.",
    );
  }

  // Reject simulated publisher signatures (SIG-...-OFFICIAL)
  if (
    acq.signatureOrReceipt &&
    (/\bSIG-.*-OFFICIAL\b/i.test(acq.signatureOrReceipt) ||
      /\b(?:official_signature|publisher_signature|simulated_signature)\b/i.test(acq.signatureOrReceipt))
  ) {
    problems.push(
      "fake_publisher_signature_rejected: Simulated publisher signatures like SIG-...-OFFICIAL are prohibited; official documents without cryptographic signatures must use verifiable archival receipts or HTTP response metadata.",
    );
  }

  // RESEARCH-F: Untrusted provider check
  if (UNTRUSTED_RESEARCH_PROVIDERS.has(acq.trustedProviderId)) {
    problems.push(
      `untrusted_provider_rejected: provider "${acq.trustedProviderId}" is on the untrusted research provider deny-list.`,
    );
  }

  // RESEARCH-B / ACQ-04: Acquisition event not found in trusted registry
  const registeredEvent = TRUSTED_ACQUISITION_REGISTRY.get(acq.acquisitionEventId);
  if (!registeredEvent) {
    problems.push(
      `acquisition_event_not_found: acquisitionEventId "${acq.acquisitionEventId}" is not found in trusted acquisition registry.`,
    );
  } else {
    // ACQ-02: Declared provider does not match registered event
    if (acq.trustedProviderId !== registeredEvent.trustedProviderId) {
      problems.push(
        `acquisition_provider_mismatch: declared provider "${acq.trustedProviderId}" does not match registered acquisition event provider "${registeredEvent.trustedProviderId}".`,
      );
    }

    // ACQ-01: SourceRef URL does not match registered event URL
    if (sourceRef.sourceUrl && registeredEvent.actualRequestedUrl) {
      const srcUrlNorm = (sourceRef.sourceUrl.split("?")[0] ?? "").replace(/\/+$/, "");
      const reqUrlNorm = (registeredEvent.actualRequestedUrl.split("?")[0] ?? "").replace(/\/+$/, "");
      const finalUrl = registeredEvent.finalResponseUrl ?? registeredEvent.actualRequestedUrl;
      const resUrlNorm = (finalUrl.split("?")[0] ?? "").replace(/\/+$/, "");
      if (srcUrlNorm !== reqUrlNorm && srcUrlNorm !== resUrlNorm) {
        problems.push(
          `acquisition_source_url_mismatch: sourceRef.sourceUrl "${sourceRef.sourceUrl}" does not match registered event URL "${registeredEvent.actualRequestedUrl}".`,
        );
      }
    }

    // ACQ-06: Legitimate event ID reused for a different research document
    if (
      registeredEvent.trustedProviderId === "insee-official-data" &&
      !/insee|census|rp2022|logement/i.test(sourceRef.ref)
    ) {
      problems.push(
        `acquisition_document_mismatch: acquisitionEventId "${acq.acquisitionEventId}" is an INSEE housing census event, which cannot be reused for unrelated source "${sourceRef.ref}".`,
      );
    } else if (
      /competitor|luxury|swiss|private\s+bank/i.test(sourceRef.ref) &&
      !/competitor|luxury|swiss|private\s+bank/i.test(registeredEvent.description)
    ) {
      problems.push(
        `acquisition_document_mismatch: acquisitionEventId "${acq.acquisitionEventId}" is bound to "${registeredEvent.description}", which cannot be reused for "${sourceRef.ref}".`,
      );
    }

    // RESEARCH-C: Declared provenance digest vs registered event digest
    if (acq.contentDigest !== registeredEvent.contentDigest) {
      problems.push(
        `acquisition_content_digest_mismatch: declared provenance contentDigest ${acq.contentDigest.slice(0, 12)}… does not match registered event digest ${registeredEvent.contentDigest.slice(0, 12)}…`,
      );
    }

    // ACQ-03: Stored source bytes verification on disk
    if (options?.checkDisk !== false && registeredEvent.sourceFileRef) {
      const root = options?.repoRoot ?? findRepoRoot(process.cwd());
      const diskPath = path.resolve(root, registeredEvent.sourceFileRef);
      if (!existsSync(diskPath)) {
        problems.push(
          `stored_source_file_missing: physical source file "${registeredEvent.sourceFileRef}" is missing from disk.`,
        );
      } else {
        const diskBytes = readFileSync(diskPath);
        const diskDigest = createHash("sha256").update(diskBytes).digest("hex");
        if (diskDigest !== registeredEvent.contentDigest) {
          problems.push(
            `stored_source_bytes_digest_mismatch: physical source file "${registeredEvent.sourceFileRef}" on disk has digest ${diskDigest.slice(0, 12)}…, which does not match trusted acquisition event digest ${registeredEvent.contentDigest.slice(0, 12)}….`,
          );
        }
      }
    }

    // Digest comparison against supplied storedDigest
    if (storedDigest && storedDigest !== registeredEvent.contentDigest) {
      problems.push(
        `acquisition_content_digest_mismatch: stored source digest ${storedDigest.slice(0, 12)}… does not match acquisition event digest ${registeredEvent.contentDigest.slice(0, 12)}…`,
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
