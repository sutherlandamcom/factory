import { createHash } from "node:crypto";
import * as dnsPromisesModule from "node:dns/promises";
import { MAX_PAGE_RAW_BYTES } from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { validateUrlResolved } from "./ssrf-guard.js";

/**
 * CompetitorPageProvider — narrow page acquisition boundary (Macro Run 3).
 *
 * v0 primary: direct public HTTP(S) acquisition. NO crawler platform, NO
 * CAPTCHA solving, NO anti-bot circumvention, NO login automation. A page
 * that intentionally blocks us is recorded BLOCKED, not bypassed.
 *
 * Input URLs come ONLY from trusted persisted SerpSnapshot evidence; the
 * browser can never supply fetch URLs.
 *
 * Bounded by: explicit timeout, hard response-size cap (streamed, abort
 * beyond the cap), redirect limit with per-hop SSRF revalidation,
 * content-type validation, final-URL capture.
 */

export const ACQUISITION_METHOD_VERSION = "direct-http-v1";
export const SAFE_USER_AGENT =
  "FactoryCompetitorBot/1.0 (+https://factory.example/bot; research evidence acquisition; respects robots and blocks)";

export const PAGE_FETCH_TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 5;

/** Typed acquisition outcome; failures never abort a whole run. */
export type PageAcquisitionOutcome =
  | {
      status: "SUCCESS";
      finalUrl: string;
      httpStatus: number;
      contentType: string;
      /** Raw body bytes actually read (bounded). */
      rawBytes: Buffer;
      /** SHA-256 of the full body actually read (even if truncated). */
      rawDigest: string;
      /** True when the body exceeded the hard cap and was cut. */
      truncated: boolean;
      observedAt: Date;
    }
  | {
      status: "BLOCKED" | "NON_HTML" | "UNSUPPORTED" | "FAILED";
      httpStatus: number | null;
      contentType: string | null;
      finalUrl: string | null;
      observedAt: Date;
      /** Sanitized categorical reason; never a provider error dump. */
      reason: string;
    };

export interface PageAcquisitionRequest {
  url: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface CompetitorPageProviderDeps {
  fetchImpl?: FetchLike;
  lookupFn?: typeof import("node:dns/promises").lookup;
  now?: () => Date;
}

export interface CompetitorPageProvider {
  readonly id: string;
  acquire(request: PageAcquisitionRequest): Promise<PageAcquisitionOutcome>;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function outcomeFailure(
  status: "BLOCKED" | "NON_HTML" | "UNSUPPORTED" | "FAILED",
  httpStatus: number | null,
  contentType: string | null,
  finalUrl: string | null,
  reason: string,
  now: () => Date,
): PageAcquisitionOutcome {
  return { status, httpStatus, contentType, finalUrl, observedAt: now(), reason };
}

export class DirectHttpPageProvider implements CompetitorPageProvider {
  readonly id = "direct_http";
  private readonly fetchImpl: FetchLike;
  private readonly lookupFn: typeof import("node:dns/promises").lookup;
  private readonly now: () => Date;

  constructor(deps: CompetitorPageProviderDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
    if (deps.lookupFn) {
      this.lookupFn = deps.lookupFn;
    } else {
      // Lazy local resolution keeps construction sync (no top-level await).
      let cached: typeof import("node:dns/promises").lookup | null = null;
      this.lookupFn = ((...args: Parameters<typeof import("node:dns/promises").lookup>) => {
        cached ??= (dnsPromisesModule as typeof import("node:dns/promises")).lookup;
        return cached(...args);
      }) as typeof import("node:dns/promises").lookup;
    }
  }

  async acquire(request: PageAcquisitionRequest): Promise<PageAcquisitionOutcome> {
    const timeoutMs = request.timeoutMs ?? PAGE_FETCH_TIMEOUT_MS;
    const maxBytes = request.maxBytes ?? MAX_PAGE_RAW_BYTES;
    const observedAt = this.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let currentUrl = request.url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        // Per-hop SSRF revalidation (fail closed before every fetch).
        const check = await validateUrlResolved(currentUrl, this.lookupFn);
        if (!check.ok) {
          return outcomeFailure("FAILED", null, null, hop === 0 ? null : currentUrl, check.reason ?? "URL rejected by safety policy.", this.now);
        }

        let response: Response;
        try {
          response = await this.fetchImpl(currentUrl, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              "User-Agent": SAFE_USER_AGENT,
              Accept: "text/html,application/xhtml+xml",
              "Accept-Language": "*",
            },
          });
        } catch (error) {
          const aborted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
          return outcomeFailure(
            "FAILED",
            null,
            null,
            hop === 0 ? null : currentUrl,
            aborted ? "Acquisition timed out." : "Network request failed.",
            this.now,
          );
        }

        // Manual redirect handling: revalidate every hop against the SSRF guard.
        if (response.status >= 300 && response.status < 400) {
          await this.drain(response);
          const location = response.headers.get("location");
          if (!location) {
            return outcomeFailure("FAILED", response.status, response.headers.get("content-type"), currentUrl, "Redirect without Location header.", this.now);
          }
          let nextUrl: string;
          try {
            nextUrl = new URL(location, currentUrl).toString();
          } catch {
            return outcomeFailure("FAILED", response.status, null, currentUrl, "Redirect Location is not a valid URL.", this.now);
          }
          if (hop === MAX_REDIRECTS) {
            return outcomeFailure("FAILED", response.status, null, currentUrl, "Redirect chain exceeded the limit.", this.now);
          }
          currentUrl = nextUrl;
          continue;
        }

        const contentType = response.headers.get("content-type") ?? "";
        const mime = contentType.split(";")[0]!.trim().toLowerCase();

        if (response.status === 401 || response.status === 403 || response.status === 429) {
          await this.drain(response);
          return outcomeFailure("BLOCKED", response.status, contentType, currentUrl, `Page blocked the acquisition (HTTP ${response.status}).`, this.now);
        }
        if (response.status >= 400) {
          await this.drain(response);
          return outcomeFailure("FAILED", response.status, contentType, currentUrl, `Page acquisition failed (HTTP ${response.status}).`, this.now);
        }

        // Content-type validation: HTML only. PDFs/JSON/images are NON_HTML
        // (acquired but unsupported for structural extraction).
        const isHtml = mime === "text/html" || mime === "application/xhtml+xml";
        if (!isHtml) {
          const isAcquirableBinary = mime !== "" && mime !== "application/octet-stream";
          await this.drain(response);
          return outcomeFailure(
            isAcquirableBinary ? "NON_HTML" : "UNSUPPORTED",
            response.status,
            contentType,
            currentUrl,
            `Content type ${mime || "unknown"} is not HTML.`,
            this.now,
          );
        }

        // Streamed bounded read: abort as soon as the hard cap is exceeded or timeout occurs.
        const reader = response.body?.getReader();
        if (!reader) {
          return outcomeFailure("FAILED", response.status, contentType, currentUrl, "Response had no readable body.", this.now);
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;

        const onAbort = () => {
          reader.cancel().catch(() => {});
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });

        try {
          for (;;) {
            if (controller.signal.aborted) {
              throw new Error("AbortError");
            }
            const { done, value } = await reader.read();
            if (controller.signal.aborted) {
              throw new Error("AbortError");
            }
            if (done) break;
            if (value) {
              total += value.byteLength;
              if (total > maxBytes) {
                truncated = true;
                const remaining = Math.max(0, maxBytes - (total - value.byteLength));
                if (remaining > 0) chunks.push(Buffer.from(value.slice(0, remaining)));
                break;
              }
              chunks.push(Buffer.from(value));
            }
          }
        } catch (error) {
          const isAbort =
            controller.signal.aborted ||
            (error instanceof Error && (error.name === "AbortError" || error.message === "AbortError"));
          if (isAbort) {
            return outcomeFailure("FAILED", null, null, currentUrl, "Acquisition timed out.", this.now);
          }
          return outcomeFailure("FAILED", response.status, contentType, currentUrl, "Response stream failed before completion.", this.now);
        } finally {
          controller.signal.removeEventListener("abort", onAbort);
          reader.releaseLock?.();
          await this.drain(response);
        }

        if (truncated) {
          // Explicit unsupported state — never silently read unbounded pages.
          return outcomeFailure("UNSUPPORTED", response.status, contentType, currentUrl, `Page exceeded the hard acquisition limit (${maxBytes} bytes).`, this.now);
        }

        const rawBytes = Buffer.concat(chunks);
        return {
          status: "SUCCESS",
          finalUrl: currentUrl,
          httpStatus: response.status,
          contentType,
          rawBytes,
          rawDigest: sha256(rawBytes),
          truncated: false,
          observedAt,
        };
      }
      // Unreachable: loop returns on every path (hop <= MAX_REDIRECTS inclusive).
      return outcomeFailure("FAILED", null, null, null, "Redirect handling exhausted.", this.now);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Bounded drain: cancel body stream immediately so hostile/unbounded bodies are never buffered. */
  private async drain(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // ignore drain failures
    }
  }
}

/** Guard against accidental direct construction with wrong error domain. */
export function isPageAcquisitionError(error: unknown): error is FactoryError {
  return error instanceof FactoryError;
}
