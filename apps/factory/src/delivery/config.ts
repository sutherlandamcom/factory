import { FactoryError } from "../executor/errors.js";

const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateWorkerName(value: string): string {
  const worker = value.trim();
  if (!WORKER_NAME.test(worker)) {
    throw new FactoryError(
      "delivery_configuration_invalid",
      "Cloudflare Worker name must contain only lowercase letters, digits, and internal hyphens (max 63 characters).",
    );
  }
  return worker;
}

export function validateProductionUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FactoryError("delivery_configuration_invalid", "Production URL must be an absolute HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new FactoryError(
      "delivery_configuration_invalid",
      "Production URL must be a credential-free HTTPS origin without a path, query, or fragment.",
    );
  }
  return url.origin;
}

export function requireDeliveryTarget(input: {
  cloudflareWorkerName: string | null;
  productionUrl: string | null;
}): { workerName: string; productionUrl: string } {
  if (!input.cloudflareWorkerName || !input.productionUrl) {
    throw new FactoryError(
      "deployment_target_unconfigured",
      "Site delivery target is not configured. Run 'pnpm factory site delivery set <siteKey> --worker <name> --production-url <https://origin>'.",
    );
  }
  return {
    workerName: validateWorkerName(input.cloudflareWorkerName),
    productionUrl: validateProductionUrl(input.productionUrl),
  };
}
