import { randomBytes } from "node:crypto";
import type { WranglerOperations } from "./service.js";
import type { UploadedVersion } from "./wrangler.js";

/**
 * Deterministic simulated Wrangler operations for E2E tests and local dev
 * when real Cloudflare credentials are not configured or fixture mode is enabled.
 */
export class SimulatedWrangler implements WranglerOperations {
  readonly isSimulated: boolean = true;
  promoted: string[] = [];
  rolledBack: string[] = [];
  current: string | null = null;

  constructor(initialCurrent: string | null = null) {
    this.current = initialCurrent;
  }

  async assertTargetExists(_workerName: string): Promise<void> {}

  async upload(workerName: string): Promise<UploadedVersion> {
    const versionId = `v-sim-${randomBytes(6).toString("hex")}`;
    return {
      versionId,
      previewUrl: `https://${versionId}.${workerName}.workers.dev`,
      workerName,
    };
  }

  async currentProductionVersion(_workerName: string): Promise<string | null> {
    return this.current;
  }

  async promote(_workerName: string, versionId: string): Promise<void> {
    this.promoted.push(versionId);
    this.current = versionId;
  }

  async rollback(_workerName: string, versionId: string): Promise<void> {
    this.rolledBack.push(versionId);
    this.current = versionId;
  }
}
