import type { Conversion, ProductionConversionAuthority } from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";

export function verifiedConversionHref(conversion: Conversion): string {
  const reject = (): never => { throw new FactoryError("production_authority_stale", "Required CTA destination must be explicitly verified and use a supported safe destination type."); };
  if (conversion.verificationState !== "VERIFIED") return reject();
  if (/[\u0000-\u0020\u007f]/u.test(conversion.ctaDestination)) return reject();
  const raw = conversion.ctaDestination;
  if (!raw || /[\u0000-\u0020\u007f]/u.test(raw)) return reject();
  if (conversion.ctaDestinationType === "email") {
    const address = raw.replace(/^mailto:/i, "");
    return /^[A-Za-z0-9.!#$%&'*+\-/=^_`{|}~]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(address) ? `mailto:${address}` : reject();
  }
  if (conversion.ctaDestinationType === "phone") {
    const phone = raw.replace(/^tel:/i, "");
    return /^\+[1-9][0-9]{6,14}$/.test(phone) ? `tel:${phone}` : reject();
  }
  if (conversion.ctaDestinationType === "url" || conversion.ctaDestinationType === "form") {
    if (/^\/(?:[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)(?:\/[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)*$/.test(raw) || raw === "/") return raw;
    if (conversion.ctaDestinationType === "form") return reject();
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" && !url.username && !url.password && !raw.includes("\\")) return raw;
    } catch { /* fail closed */ }
  }
  return reject();
}

export function deriveConversionAuthority(input: {
  projectId: string;
  snapshot: { id: string; version: number; digest: string };
  conversion: Conversion;
  acceptedContentDigest: string;
  ctaText: string;
  informationalApproval?: { acceptedInputDigest: string; reason: string };
}): ProductionConversionAuthority {
  const informational = input.informationalApproval?.acceptedInputDigest === input.snapshot.digest;
  if (!informational && !input.ctaText.trim()) throw new FactoryError("production_authority_stale", "Required conversion has no accepted CTA copy.");
  return {
    projectId: input.projectId,
    acceptedInput: { id: input.snapshot.id, version: input.snapshot.version, digest: input.snapshot.digest },
    acceptedContentDigest: input.acceptedContentDigest,
    mode: informational ? "informational" : "action",
    href: informational ? null : verifiedConversionHref(input.conversion),
  };
}
