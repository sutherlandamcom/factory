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
  alternateSourceUrls?: string[];
  canonicalDatasetId: string;
  datasetIdentity: {
    communeCode?: string;
    geoCode?: string;
    reportingPeriod?: number;
    tableId?: string;
    documentIdentifier: string;
    documentType: string;
  };
  trustedRedirects?: Array<{ from: string; to: string; status?: number }>;
}

export const TRUSTED_ACQUISITION_REGISTRY: Map<string, TrustedAcquisitionEventRecord> = new Map([
  [
    "acq-insee-74056-2026",
    {
      acquisitionEventId: "acq-insee-74056-2026",
      trustedProviderId: "insee-official-data",
      actualRequestedUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
      finalResponseUrl: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
      alternateSourceUrls: [
        "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
        "https://statistiques-locales.insee.fr/#c=indicator&i=rp.pop_1&s=2022&geo=COM-74056",
      ],
      trustedRedirects: [
        {
          from: "https://insee.fr/fr/statistiques/8581193?geo=COM-74056",
          to: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
          status: 301,
        },
        {
          from: "https://statistiques-locales.insee.fr/#c=indicator&i=rp.pop_1&s=2022&geo=COM-74056",
          to: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
          status: 301,
        },
      ],
      canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
      datasetIdentity: {
        geoCode: "74056",
        reportingPeriod: 2022,
        documentIdentifier: "INSEE-8581193-COM-74056",
        documentType: "census",
      },
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
      alternateSourceUrls: [
        "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
        "https://statistiques-locales.insee.fr/#c=indicator&i=rp.pop_1&s=2022&geo=COM-74056",
      ],
      trustedRedirects: [
        {
          from: "https://insee.fr/fr/statistiques/8581193?geo=COM-74056",
          to: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
          status: 301,
        },
        {
          from: "https://statistiques-locales.insee.fr/#c=indicator&i=rp.pop_1&s=2022&geo=COM-74056",
          to: "https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056",
          status: 301,
        },
      ],
      canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74056",
      datasetIdentity: {
        geoCode: "74056",
        reportingPeriod: 2022,
        documentIdentifier: "INSEE-8581193-COM-74056",
        documentType: "census",
      },
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
      alternateSourceUrls: ["https://www.insee.fr/fr/statistiques/8581193?geo=COM-74173"],
      canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74173",
      datasetIdentity: {
        geoCode: "74173",
        reportingPeriod: 2022,
        documentIdentifier: "INSEE-8581193-COM-74173",
        documentType: "census",
      },
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
      alternateSourceUrls: ["https://www.insee.fr/fr/statistiques/8581193?geo=COM-74173"],
      canonicalDatasetId: "INSEE-RP2022-LOGEMENT-COM-74173",
      datasetIdentity: {
        geoCode: "74173",
        reportingPeriod: 2022,
        documentIdentifier: "INSEE-8581193-COM-74173",
        documentType: "census",
      },
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
      alternateSourceUrls: [
        "https://www.chamonix.fr/urbanisme-plu",
        "https://www.chamonix.fr/demarches/urbanisme/documents-opposables/plu/",
        "https://www.chamonix.fr/demarches/urbanisme/documents-opposables/plu",
        "https://www.chamonix.fr/demarches/urbanisme/documents-opposables/plu/reglement-20260226.pdf",
      ],
      canonicalDatasetId: "CHAMONIX-PLU-REGLEMENT-20260226",
      datasetIdentity: {
        geoCode: "74056",
        reportingPeriod: 2026,
        documentIdentifier: "GPU-DU-74056-beaa82a7b5594b3913d5156928287d07",
        documentType: "regulatory_plu",
      },
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
      alternateSourceUrls: [
        "https://www.chamonix.fr/urbanisme-plu",
        "https://www.chamonix.fr/demarches/urbanisme/documents-opposables/plu/",
        "https://www.chamonix.fr/demarches/urbanisme/documents-opposables/plu",
        "https://www.chamonix.fr/demarches/urbanisme/documents-opposables/plu/reglement-20260226.pdf",
      ],
      canonicalDatasetId: "CHAMONIX-PLU-REGLEMENT-20260226",
      datasetIdentity: {
        geoCode: "74056",
        reportingPeriod: 2026,
        documentIdentifier: "GPU-DU-74056-beaa82a7b5594b3913d5156928287d07",
        documentType: "regulatory_plu",
      },
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
      alternateSourceUrls: [
        "https://www.chamonix.fr/urbanisme-plu",
        "https://www.chamonix.fr/demarches/urbanisme/documents-opposables/plu/",
        "https://www.chamonix.fr/demarches/urbanisme/documents-opposables/plu",
        "https://www.chamonix.fr/demarches/urbanisme/documents-opposables/plu/reglement-20260226.pdf",
      ],
      canonicalDatasetId: "CHAMONIX-PLU-REGLEMENT-20260226",
      datasetIdentity: {
        geoCode: "74056",
        reportingPeriod: 2026,
        documentIdentifier: "GPU-DU-74056-beaa82a7b5594b3913d5156928287d07",
        documentType: "regulatory_plu",
      },
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
      alternateSourceUrls: [
        "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000031000677",
      ],
      canonicalDatasetId: "LEGIFRANCE-CCH-L271-1",
      datasetIdentity: {
        documentIdentifier: "LEGIARTI000031000677",
        documentType: "statute",
      },
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
      alternateSourceUrls: [
        "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000043977341",
      ],
      canonicalDatasetId: "LEGIFRANCE-CCH-L126-28-1",
      datasetIdentity: {
        documentIdentifier: "LEGIARTI000043977341",
        documentType: "statute",
      },
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
      alternateSourceUrls: [
        "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006069577/LEGISCTA000036385038",
      ],
      canonicalDatasetId: "LEGIFRANCE-CGI-IFI",
      datasetIdentity: {
        documentIdentifier: "LEGISCTA000036385038",
        documentType: "statute",
      },
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
      alternateSourceUrls: [
        "https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000512228/",
      ],
      canonicalDatasetId: "LEGIFRANCE-LOI-HOGUET",
      datasetIdentity: {
        documentIdentifier: "JORFTEXT000000512228",
        documentType: "statute",
      },
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
      alternateSourceUrls: [
        "https://www.chamonix.fr/demarches/urbanisme/documents-opposables/plu/deliberation-meubles-2025.txt",
      ],
      canonicalDatasetId: "CHAMONIX-MEUBLES-TOURISME-2025",
      datasetIdentity: {
        geoCode: "74056",
        reportingPeriod: 2025,
        documentIdentifier: "DELIB-20231214-20240411",
        documentType: "municipal_deliberation",
      },
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
      alternateSourceUrls: [
        "https://www.georisques.gouv.fr/mes-risques/connaitre-les-risques-pres-de-chez-moi/commune/74056",
      ],
      canonicalDatasetId: "GEORISQUES-PPRN-74056",
      datasetIdentity: {
        geoCode: "74056",
        documentIdentifier: "PPRN-74056-2015",
        documentType: "risk_plan",
      },
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
      alternateSourceUrls: [
        "https://www.ccomptes.fr/fr/publications/les-stations-de-ski-face-au-changement-climatique/",
      ],
      canonicalDatasetId: "CCOMPTES-STATIONS-SKI-2024",
      datasetIdentity: {
        reportingPeriod: 2024,
        documentIdentifier: "CCOMPTES-202402",
        documentType: "audit_report",
      },
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
      alternateSourceUrls: ["https://app.dvf.etalab.gouv.fr", "https://files.data.gouv.fr/geo-dvf/"],
      canonicalDatasetId: "DGFIP-DVF-CONSOLIDATED",
      datasetIdentity: {
        documentIdentifier: "DVF-ETALAB-2026",
        documentType: "dvf",
      },
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

interface ManifestSnapshotEntry {
  file?: string;
  rawBytesLocation?: string;
  sha256: string;
  originalUrl?: string;
  canonicalDocumentUrl?: string;
  retrievedUrl?: string;
  geoCode?: string;
  reportingYear?: number;
}

const manifestCache = new Map<string, ManifestSnapshotEntry[]>();

function loadAuthenticatedManifestEntries(repoRoot: string): ManifestSnapshotEntry[] {
  const cached = manifestCache.get(repoRoot);
  if (cached) return cached;
  const entries: ManifestSnapshotEntry[] = [];
  const manifestPaths = [
    ["docs", "evidence", "sources", "insee-logement-2022", "manifest.json"],
    ["docs", "evidence", "sources", "legal-regulatory-2026", "manifest.json"],
  ];
  for (const relSegments of manifestPaths) {
    const full = path.join(repoRoot, ...relSegments);
    if (existsSync(full)) {
      try {
        const parsed = JSON.parse(readFileSync(full, "utf8")) as { snapshots?: ManifestSnapshotEntry[] };
        if (Array.isArray(parsed.snapshots)) {
          const dirPrefix = relSegments.slice(0, -1).join("/");
          for (const snap of parsed.snapshots) {
            entries.push({
              ...snap,
              rawBytesLocation: snap.rawBytesLocation ?? (snap.file ? `${dirPrefix}/${snap.file}` : undefined),
            });
          }
        }
      } catch {
        // Ignore malformed manifest; fail-closed downstream when entry is absent
      }
    }
  }
  manifestCache.set(repoRoot, entries);
  return entries;
}

function normalizeGeoCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().replace(/^COM-/i, "");
}

const MUNICIPALITY_MARKERS: Array<{ geoCode: string; pattern: RegExp }> = [
  { geoCode: "74056", pattern: /\b(?:74056|chamonix(?:-mont-blanc)?)\b/i },
  { geoCode: "74173", pattern: /\b(?:74173|meg[eè]ve)\b/i },
  { geoCode: "74010", pattern: /\b(?:74010|annecy)\b/i },
  { geoCode: "73257", pattern: /\b(?:73257|courchevel|saint-bon-tarentaise)\b/i },
  { geoCode: "73304", pattern: /\b(?:73304|val-d'is[eè]re)\b/i },
  { geoCode: "74191", pattern: /\b(?:74191|morzine)\b/i },
  { geoCode: "74256", pattern: /\b(?:74256|saint-gervais(?:-les-bains)?)\b/i },
];

const UNRELATED_INSEE_DOCUMENT_PATTERN =
  /\b(?:insee\s+premi[eè]re|insee\s+analyses|insee\s+focus|enqu[eê]te\s+nationale\s+logement|revenus\s+et\s+pauvret[eé]|filosofi|d[eé]mographie\s+des\s+entreprises|sirene|capacit[eé]\s+des\s+h[oô]tels|fr[eé]quentation\s+touristique|indice\s+de\s+r[eé]f[eé]rence\s+des\s+loyers|note\s+de\s+conjoncture|projections\s+de\s+population|bilan\s+d[eé]mographique|bilan\s+[eé]conomique|swiss\s+private\s+bank|luxury\s+property\s+index|knight\s+frank|savills)\b/i;

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
    acq.sourceOrigin === "SYNTHETIC_FIXTURE" ||
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
    // ACQ-19: Static capture registry is VERIFIED_ARCHIVED_EXTERNAL only — cannot be represented as live EXTERNAL_ACQUIRED
    if (
      registeredEvent.sourceOrigin === "VERIFIED_ARCHIVED_EXTERNAL" &&
      (sourceRef.evidenceOrigin === "EXTERNAL_ACQUIRED" || acq.sourceOrigin === "EXTERNAL_ACQUIRED")
    ) {
      problems.push(
        `acquisition_event_unverified: static capture registry entry "${acq.acquisitionEventId}" is an archival snapshot (VERIFIED_ARCHIVED_EXTERNAL) and cannot be represented as live external acquisition (EXTERNAL_ACQUIRED) without independent live capture evidence.`,
      );
    }

    // ACQ-19: Hardcoded receipt strings are not independent authentication; receipt must match registered event
    if (
      !acq.signatureOrReceipt ||
      (registeredEvent.signatureOrReceipt && acq.signatureOrReceipt !== registeredEvent.signatureOrReceipt)
    ) {
      problems.push(
        `acquisition_event_unverified: signatureOrReceipt "${acq.signatureOrReceipt ?? "<missing>"}" does not match authenticated capture receipt "${registeredEvent.signatureOrReceipt}".`,
      );
    }

    // ACQ-02: Declared provider does not match registered event
    if (acq.trustedProviderId !== registeredEvent.trustedProviderId) {
      problems.push(
        `acquisition_provider_mismatch: declared provider "${acq.trustedProviderId}" does not match registered acquisition event provider "${registeredEvent.trustedProviderId}".`,
      );
    }

    // Require sourceUrl on external acquisitions
    if (!sourceRef.sourceUrl || sourceRef.sourceUrl.trim().length === 0) {
      problems.push(
        `acquisition_source_url_missing: sourceRef "${sourceRef.ref}" omits required sourceUrl for external acquisition event "${acq.acquisitionEventId}".`,
      );
    }

    // Generic homepage rejection (ACQ-10)
    const isGenericHomepage = (urlStr: string) => {
      try {
        const u = new URL(urlStr);
        const host = u.hostname.toLowerCase();
        const pathNorm = u.pathname.replace(/\/+$/, "");
        const isTopPublisher = /^(?:www\.)?(?:insee\.fr|georisques\.gouv\.fr|chamonix\.fr|ccomptes\.fr|legifrance\.gouv\.fr|etalab\.gouv\.fr)$/.test(host);
        return isTopPublisher && (pathNorm === "" || pathNorm === "/fr") && !u.search;
      } catch {
        return false;
      }
    };

    if (sourceRef.sourceUrl && isGenericHomepage(sourceRef.sourceUrl)) {
      problems.push(
        `homepage_source_url_rejected: A generic publisher homepage ("${sourceRef.sourceUrl}") cannot establish the identity of a specific dataset or regulatory extract.`,
      );
    }

    // ACQ-01 / ACQ-09 / ACQ-13 / ACQ-14: Exact URL, query parameter, and trusted redirect verification
    if (sourceRef.sourceUrl && registeredEvent.actualRequestedUrl) {
      let srcParsed: URL | null = null;
      let regParsed: URL | null = null;
      try {
        srcParsed = new URL(sourceRef.sourceUrl);
      } catch {}
      try {
        regParsed = new URL(registeredEvent.actualRequestedUrl);
      } catch {}

      if (srcParsed && regParsed) {
        if (registeredEvent.trustedProviderId === "insee-official-data") {
          const materialParams = ["geo", "codeInsee", "commune", "table", "year", "period"];
          for (const p of materialParams) {
            const srcVal = srcParsed.searchParams.get(p);
            const regVal = regParsed.searchParams.get(p);
            if (regVal && srcVal && srcVal !== regVal) {
              problems.push(
                `material_query_parameter_mismatch: Query parameter "${p}" expected "${regVal}", got "${srcVal}".`,
              );
            } else if (regVal && !srcVal) {
              problems.push(
                `acquisition_parameter_missing: sourceRef is missing required query parameter "${p}=${regVal}" for dataset identity.`,
              );
            }
          }
        }
      }

      const allCandidateUrls = [
        registeredEvent.actualRequestedUrl,
        registeredEvent.finalResponseUrl,
        ...(registeredEvent.alternateSourceUrls ?? []),
      ].filter((u): u is string => typeof u === "string");

      const hasExactMatch = allCandidateUrls.some((cand) => {
        if (cand === sourceRef.sourceUrl) return true;
        if (!cand.includes("?") && !sourceRef.sourceUrl!.includes("?")) {
          return cand.replace(/\/+$/, "") === sourceRef.sourceUrl!.replace(/\/+$/, "");
        }
        return false;
      });

      const matchingRegisteredRedirect = (registeredEvent.trustedRedirects ?? []).find(
        (red) =>
          (red.from === sourceRef.sourceUrl || red.to === sourceRef.sourceUrl) &&
          (red.to === registeredEvent.finalResponseUrl || red.to === registeredEvent.actualRequestedUrl) &&
          (red.status === undefined || (red.status >= 300 && red.status < 400)),
      );

      // Verify any caller-supplied trustedRedirects against registeredEvent.trustedRedirects
      if (acq.trustedRedirects && acq.trustedRedirects.length > 0) {
        for (const suppliedRed of acq.trustedRedirects) {
          const fromUrl = suppliedRed.from ?? suppliedRed.fromUrl;
          const toUrl = suppliedRed.to ?? suppliedRed.toUrl;
          const status = suppliedRed.status ?? suppliedRed.statusCode;
          const verifiedRed = (registeredEvent.trustedRedirects ?? []).some(
            (regRed) =>
              regRed.from === fromUrl &&
              regRed.to === toUrl &&
              (status === undefined || regRed.status === undefined || regRed.status === status),
          );
          if (!verifiedRed) {
            problems.push(
              `untrusted_redirect_rejected: redirect from "${fromUrl ?? "<missing>"}" to "${toUrl ?? "<missing>"}" is not in registered trustedRedirects for "${acq.acquisitionEventId}".`,
            );
          }
        }
      }

      if (!hasExactMatch && !matchingRegisteredRedirect) {
        problems.push(
          `acquisition_source_url_mismatch: sourceRef.sourceUrl "${sourceRef.sourceUrl}" does not match registered event URL "${registeredEvent.actualRequestedUrl}".`,
        );
      }
    }

    // ACQ-15 / ACQ-12: Require canonicalDatasetId unconditionally when registeredEvent defines one
    if (registeredEvent.canonicalDatasetId) {
      if (!sourceRef.canonicalDatasetId || sourceRef.canonicalDatasetId.trim().length === 0) {
        problems.push(
          `canonical_dataset_id_missing: sourceRef "${sourceRef.ref}" omits required canonicalDatasetId "${registeredEvent.canonicalDatasetId}" for acquisition event "${acq.acquisitionEventId}".`,
        );
      } else if (sourceRef.canonicalDatasetId !== registeredEvent.canonicalDatasetId) {
        problems.push(
          `acquisition_canonical_dataset_mismatch: declared canonicalDatasetId "${sourceRef.canonicalDatasetId}" does not match registered event "${registeredEvent.canonicalDatasetId}".`,
        );
      }
      if (acq.canonicalDatasetId && acq.canonicalDatasetId !== registeredEvent.canonicalDatasetId) {
        problems.push(
          `acquisition_canonical_dataset_mismatch: provenance canonicalDatasetId "${acq.canonicalDatasetId}" does not match registered event "${registeredEvent.canonicalDatasetId}".`,
        );
      }
    }

    // ACQ-16 / ACQ-17 / ACQ-11: Geographical and reporting-period bindings must be present and match
    if (registeredEvent.datasetIdentity) {
      const regGeo = normalizeGeoCode(
        registeredEvent.datasetIdentity.geoCode ?? registeredEvent.datasetIdentity.communeCode,
      );
      const regPeriod = registeredEvent.datasetIdentity.reportingPeriod;
      const regDocId = registeredEvent.datasetIdentity.documentIdentifier;
      const regDocType = registeredEvent.datasetIdentity.documentType;

      if (regGeo) {
        const declaredRefGeo = normalizeGeoCode(
          sourceRef.datasetIdentity?.geoCode ?? sourceRef.datasetIdentity?.communeCode,
        );
        const declaredAcqGeo = normalizeGeoCode(
          acq.datasetIdentity?.geoCode ?? acq.datasetIdentity?.communeCode,
        );
        const bindingGeos = (sourceRef.evidenceBindings ?? []).map((b) => normalizeGeoCode(b.geoCode)).filter(Boolean) as string[];

        if (!declaredRefGeo && bindingGeos.length === 0) {
          problems.push(
            `dataset_identity_geocode_missing: sourceRef "${sourceRef.ref}" omits required geographical identity (geoCode "${regGeo}") for municipality-bound acquisition event "${acq.acquisitionEventId}".`,
          );
        }
        if (declaredRefGeo && declaredRefGeo !== regGeo) {
          problems.push(
            `acquisition_dataset_identity_mismatch: municipality_scope_mismatch — declared geoCode "${declaredRefGeo}" does not match registered event geoCode "${regGeo}".`,
          );
        }
        if (declaredAcqGeo && declaredAcqGeo !== regGeo) {
          problems.push(
            `acquisition_dataset_identity_mismatch: municipality_scope_mismatch — provenance geoCode "${declaredAcqGeo}" does not match registered event geoCode "${regGeo}".`,
          );
        }
        for (const bGeo of bindingGeos) {
          if (bGeo !== regGeo) {
            problems.push(
              `acquisition_dataset_identity_mismatch: municipality_scope_mismatch — evidence binding geoCode "${bGeo}" does not match registered event geoCode "${regGeo}".`,
            );
          }
        }

        // Check if sourceRef text or URL attributes the event to another municipality (ACQ-16)
        const refAndUrlText = `${sourceRef.ref} ${sourceRef.sourceUrl ?? ""} ${sourceRef.canonicalDatasetId ?? ""}`;
        for (const marker of MUNICIPALITY_MARKERS) {
          if (marker.geoCode !== regGeo && marker.pattern.test(refAndUrlText)) {
            problems.push(
              `acquisition_dataset_identity_mismatch: municipality_scope_mismatch — event "${acq.acquisitionEventId}" is bound to commune "${regGeo}" and cannot be used for municipality "${marker.geoCode}" in "${sourceRef.ref}".`,
            );
          }
        }
      }

      if (regPeriod !== undefined) {
        const declaredRefPeriod = sourceRef.datasetIdentity?.reportingPeriod;
        const declaredAcqPeriod = acq.datasetIdentity?.reportingPeriod;
        const bindingPeriods = (sourceRef.evidenceBindings ?? [])
          .map((b) => b.reportingYear)
          .filter((y): y is number => typeof y === "number");

        if (declaredRefPeriod === undefined && bindingPeriods.length === 0) {
          problems.push(
            `dataset_identity_reporting_period_missing: sourceRef "${sourceRef.ref}" omits required reportingPeriod (${regPeriod}) for acquisition event "${acq.acquisitionEventId}".`,
          );
        }
        if (declaredRefPeriod !== undefined && declaredRefPeriod !== regPeriod) {
          problems.push(
            `acquisition_reporting_period_mismatch: declared reportingPeriod "${declaredRefPeriod}" does not match registered event reportingPeriod "${regPeriod}".`,
          );
        }
        if (declaredAcqPeriod !== undefined && declaredAcqPeriod !== regPeriod) {
          problems.push(
            `acquisition_reporting_period_mismatch: provenance reportingPeriod "${declaredAcqPeriod}" does not match registered event reportingPeriod "${regPeriod}".`,
          );
        }
        for (const bPeriod of bindingPeriods) {
          if (bPeriod !== regPeriod) {
            problems.push(
              `acquisition_reporting_period_mismatch: evidence binding reportingYear "${bPeriod}" does not match registered event reportingPeriod "${regPeriod}".`,
            );
          }
        }

        // Check for conflicting census/reporting year in INSEE title, URL, or sourceDate (ACQ-17)
        if (registeredEvent.trustedProviderId === "insee-official-data") {
          const yearMatches = [
            ...`${sourceRef.ref} ${sourceRef.canonicalDatasetId ?? ""}`.matchAll(
              /\b(?:RP\s*|Logement\s+en\s+|recensement\s+|census\s+)(20\d{2})\b/gi,
            ),
          ];
          for (const m of yearMatches) {
            const mentionedYear = Number(m[1]);
            if (Number.isFinite(mentionedYear) && mentionedYear !== regPeriod) {
              problems.push(
                `acquisition_reporting_period_mismatch: source "${sourceRef.ref}" references reporting year ${mentionedYear}, which does not match registered event reportingPeriod ${regPeriod}.`,
              );
            }
          }
          const sourceDateYear = Number(sourceRef.sourceDate?.slice(0, 4));
          if (Number.isFinite(sourceDateYear) && sourceDateYear < regPeriod) {
            problems.push(
              `acquisition_reporting_period_mismatch: sourceDate "${sourceRef.sourceDate}" predates registered reportingPeriod ${regPeriod}.`,
            );
          }
        }
      }

      // ACQ-18: Document identity and document type must match; never derive authority from title keywords alone
      const declaredDocId =
        sourceRef.datasetIdentity?.documentIdentifier ?? acq.datasetIdentity?.documentIdentifier;
      if (declaredDocId && regDocId && declaredDocId !== regDocId) {
        problems.push(
          `acquisition_document_mismatch: declared documentIdentifier "${declaredDocId}" does not match registered documentIdentifier "${regDocId}".`,
        );
      }
      const declaredDocType =
        sourceRef.datasetIdentity?.documentType ?? acq.datasetIdentity?.documentType;
      if (declaredDocType && regDocType && declaredDocType !== regDocType) {
        problems.push(
          `acquisition_document_mismatch: declared documentType "${declaredDocType}" does not match registered documentType "${regDocType}".`,
        );
      }
      const declaredTableId = sourceRef.datasetIdentity?.tableId ?? acq.datasetIdentity?.tableId;
      if (
        declaredTableId &&
        registeredEvent.trustedProviderId === "insee-official-data" &&
        !/^LOG\s+T(?:1(?:bis)?|2|3|4|4bis|5|6)$/i.test(declaredTableId.trim())
      ) {
        problems.push(
          `acquisition_document_mismatch: declared tableId "${declaredTableId}" is not part of "${registeredEvent.canonicalDatasetId}".`,
        );
      }
    }

    // ACQ-06 / ACQ-18: Reject unrelated documents even when decorated with INSEE/RP2022/Logement title keywords
    if (UNRELATED_INSEE_DOCUMENT_PATTERN.test(`${sourceRef.ref} ${sourceRef.supportingExcerpt ?? ""}`)) {
      problems.push(
        `acquisition_document_mismatch: source "${sourceRef.ref}" refers to an unrelated publication or study and cannot reuse acquisition event "${acq.acquisitionEventId}" (${registeredEvent.canonicalDatasetId}).`,
      );
    } else if (
      registeredEvent.trustedProviderId === "insee-official-data" &&
      sourceRef.ref &&
      (!/insee/i.test(sourceRef.ref) || !/logement|rp\s*2022|8581193/i.test(sourceRef.ref))
    ) {
      problems.push(
        `acquisition_document_mismatch: acquisitionEventId "${acq.acquisitionEventId}" is bound to "${registeredEvent.canonicalDatasetId}", which cannot be reused for unrelated source "${sourceRef.ref}".`,
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

    // If caller supplies a different sourceFileRef than the registered event, reject
    if (acq.sourceFileRef && acq.sourceFileRef !== registeredEvent.sourceFileRef) {
      problems.push(
        `acquisition_event_unverified: declared sourceFileRef "${acq.sourceFileRef}" does not match registered event sourceFileRef "${registeredEvent.sourceFileRef}".`,
      );
    }

    // ACQ-03 / ACQ-19 / ACQ-20: Stored source bytes AND independent manifest verification on disk
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
        } else {
          // ACQ-19: Verify that the physical file and its digest are independently corroborated by the on-disk archival manifest
          const manifestEntries = loadAuthenticatedManifestEntries(root);
          const normRel = registeredEvent.sourceFileRef.replace(/\\/g, "/");
          const matchingManifestEntry = manifestEntries.find(
            (entry) =>
              entry.sha256 === diskDigest &&
              (entry.rawBytesLocation === normRel ||
                (entry.file && normRel.endsWith(`/${entry.file}`))),
          );
          if (!matchingManifestEntry) {
            problems.push(
              `acquisition_event_unverified: physical source file "${registeredEvent.sourceFileRef}" is present on disk, but its claimed acquisition event "${acq.acquisitionEventId}" is not independently verifiable in the authoritative source manifest.`,
            );
          } else if (registeredEvent.trustedProviderId === "insee-official-data") {
            // Verify internal HTML content markers for the bound commune and dataset
            const htmlPreview = diskBytes.toString("utf8");
            const expectedGeo = registeredEvent.datasetIdentity.geoCode;
            if (
              !htmlPreview.includes("LOG T1") ||
              (expectedGeo && !htmlPreview.includes(`(${expectedGeo})`))
            ) {
              problems.push(
                `acquisition_event_unverified: physical source file "${registeredEvent.sourceFileRef}" lacks authentic INSEE RP2022 commune (${expectedGeo ?? "unknown"}) table markers.`,
              );
            }
          }
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

