import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunProcessOptions {
  cwd: string;
  /** Explicit child environment — never defaults to the parent env. */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Optional stdin content; stdin is closed immediately when omitted. */
  input?: string;
}

const OUTPUT_CAP_BYTES = 16 * 1024 * 1024;

/**
 * Spawn a child process with a hard timeout. On timeout the whole process
 * group is killed (the child is spawned detached, so pnpm/codex subprocess
 * trees die together) and the result reports `timedOut: true`.
 */
export function runProcess(
  command: string,
  args: string[],
  opts: RunProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid);
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP_BYTES) stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    // Negative pid kills the whole detached process group.
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead — nothing to do.
    }
  }
}
