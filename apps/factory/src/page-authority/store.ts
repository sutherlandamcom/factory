import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FactoryDb } from "../persistence/db.js";
import {
  pageArchetypeAuthorities,
  acceptedPageContent,
  type PageArchetypeAuthorityRecord,
} from "../persistence/schema.js";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import type { DesignArchetypeKind } from "@factory/contracts";

/**
 * Normalizes a page identity / slug so root and slash variations match consistently.
 * "home", "/", and "" normalize to "home".
 * "services/advisory", "/services/advisory", "/services/advisory/" normalize to "services/advisory".
 */
export function normalizePageIdentity(slug: string): string {
  const trimmed = slug.trim();
  if (trimmed === "" || trimmed === "/" || trimmed === "home" || trimmed === "homepage" || trimmed === "index") return "home";
  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * PAGE ARCHETYPE STORE — Pre-Run-12 Durable Typed Page Authority.
 *
 * Owns the durable, typed, versioned assignment of page identities to archetypes:
 *
 *   durable typed page authority (PageArchetypeStore)
 *           ↓
 *   ContentBrief / writer pipeline consumes it
 *           ↓
 *   DesignInputSnapshot records/binds it
 *           ↓
 *   AcceptedDesignArtifact supports that archetype
 *           ↓
 *   ProductionStore consumes the SAME binding
 *
 * Slug regex is never production authority.
 */
export class PageArchetypeStore {
  constructor(private readonly db: FactoryDb) {}

  /**
   * Sets or updates the durable archetype for a page identity within a project.
   * Participates in project advisory lock (104). Idempotent if archetype is unchanged.
   */
  async setPageArchetype(input: {
    projectId: string;
    pageIdentity: string;
    archetype: DesignArchetypeKind;
  }): Promise<PageArchetypeAuthorityRecord> {
    const norm = normalizePageIdentity(input.pageIdentity);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 104))`);
      const [latest] = await tx
        .select()
        .from(pageArchetypeAuthorities)
        .where(
          and(
            eq(pageArchetypeAuthorities.projectId, input.projectId),
            eq(pageArchetypeAuthorities.pageIdentity, norm),
          ),
        )
        .orderBy(desc(pageArchetypeAuthorities.version))
        .limit(1);

      if (latest && latest.archetype === input.archetype) {
        return latest;
      }

      const nextVersion = latest ? latest.version + 1 : 1;
      const id = `paa-${randomUUID()}`;
      const authorityDigest = deterministicDigest({
        projectId: input.projectId,
        pageIdentity: norm,
        archetype: input.archetype,
        version: nextVersion,
      });

      const [inserted] = await tx
        .insert(pageArchetypeAuthorities)
        .values({
          id,
          projectId: input.projectId,
          pageIdentity: norm,
          archetype: input.archetype,
          version: nextVersion,
          authorityDigest,
        })
        .returning();

      return inserted!;
    });
  }

  /**
   * Reads the current durable page archetype authority record for a page identity if one exists.
   */
  async getAuthority(
    projectId: string,
    pageIdentity: string,
  ): Promise<PageArchetypeAuthorityRecord | null> {
    const norm = normalizePageIdentity(pageIdentity);
    const [latest] = await this.db
      .select()
      .from(pageArchetypeAuthorities)
      .where(
        and(
          eq(pageArchetypeAuthorities.projectId, projectId),
          eq(pageArchetypeAuthorities.pageIdentity, norm),
        ),
      )
      .orderBy(desc(pageArchetypeAuthorities.version))
      .limit(1);

    if (latest) {
      return latest;
    }

    if (pageIdentity.startsWith("wacc-")) {
      const [page] = await this.db
        .select({ slug: acceptedPageContent.slug })
        .from(acceptedPageContent)
        .where(
          and(
            eq(acceptedPageContent.projectId, projectId),
            eq(acceptedPageContent.id, pageIdentity),
          ),
        );
      if (page) {
        return this.getAuthority(projectId, page.slug);
      }
    }

    if (norm === "home") {
      return this.setPageArchetype({
        projectId,
        pageIdentity: "home",
        archetype: "homepage",
      });
    }

    return null;
  }

  /**
   * Reads the current durable archetype for a page identity if one exists.
   */
  async getArchetype(
    projectId: string,
    pageIdentity: string,
  ): Promise<DesignArchetypeKind | null> {
    const authority = await this.getAuthority(projectId, pageIdentity);
    return authority ? (authority.archetype as DesignArchetypeKind) : null;
  }

  /**
   * Requires a durable archetype authority record for a page identity. Fails closed if unclassified
   * or if the archetype is not supported by the design.
   */
  async requireAuthority(
    projectId: string,
    pageIdentity: string,
    supported?: readonly DesignArchetypeKind[],
  ): Promise<PageArchetypeAuthorityRecord> {
    const authority = await this.getAuthority(projectId, pageIdentity);
    if (!authority) {
      throw new FactoryError(
        "page_archetype_unclassified",
        `Page "${pageIdentity}" has no durable accepted archetype authority; register page archetype first.`,
      );
    }
    const archetype = authority.archetype as DesignArchetypeKind;
    if (supported && !supported.includes(archetype)) {
      throw new FactoryError(
        "page_archetype_unsupported",
        `Accepted design does not support page archetype "${archetype}" for "${pageIdentity}".`,
      );
    }
    return authority;
  }

  /**
   * Requires a durable archetype for a page identity. Fails closed if unclassified
   * or if the archetype is not supported by the design.
   */
  async requireArchetype(
    projectId: string,
    pageIdentity: string,
    supported?: readonly DesignArchetypeKind[],
  ): Promise<DesignArchetypeKind> {
    const authority = await this.requireAuthority(projectId, pageIdentity, supported);
    return authority.archetype as DesignArchetypeKind;
  }

  /**
   * Returns all current page archetype authorities for a project.
   */
  async allPageArchetypes(
    projectId: string,
  ): Promise<Record<string, DesignArchetypeKind>> {
    const rows = await this.db
      .select()
      .from(pageArchetypeAuthorities)
      .where(eq(pageArchetypeAuthorities.projectId, projectId))
      .orderBy(desc(pageArchetypeAuthorities.version));

    const map: Record<string, DesignArchetypeKind> = {};
    for (const row of rows) {
      if (!map[row.pageIdentity]) {
        map[row.pageIdentity] = row.archetype as DesignArchetypeKind;
      }
    }
    return map;
  }
}
