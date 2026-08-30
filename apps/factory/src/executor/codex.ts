import { randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FactoryError } from "./errors.js";
import {
  CODEX_VERSION,
  CODEX_WORKER_IMAGE,
  assertStrongExecutionIsolationAvailable,
  dockerClientEnv,
  STRONG_EXECUTION_ISOLATION_UNAVAILABLE,
} from "./isolation.js";
import { runProcess } from "./process.js";

export { STRONG_EXECUTION_ISOLATION_UNAVAILABLE } from "./isolation.js";

export interface CodexRunRequest {
  worktreePath: string;
  prompt: string;
  /** Run artifact directory; raw JSONL/stdout/stderr land here. */
  runDir: string;
  timeoutMs: number;
  /** Exact logical write authority derived from the validated SiteTask. */
  writablePaths: readonly string[];
}

export interface CodexRunResult {
  exitCode: number | null;
  timedOut: boolean;
  /** Codex CLI version string, e.g. "codex-cli 0.150.1"; null if unavailable. */
  version: string | null;
  /** Raw stdout (JSONL events when --json is active). */
  stdout: string;
  stderr: string;
}

export type CodexRunner = (request: CodexRunRequest) => Promise<CodexRunResult>;

export interface CodexRunnerOptions {
  repoRoot: string;
}

function safeContainerName(runDir: string): string {
  const base = path.basename(path.dirname(runDir)).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 38);
  return `factory-codex-${base}-${randomBytes(4).toString("hex")}`;
}

function authSourcePath(parent: NodeJS.ProcessEnv = process.env): string {
  const home = parent.CODEX_HOME ?? path.join(parent.HOME ?? os.homedir(), ".codex");
  return path.join(home, "auth.json");
}

async function prepareMinimalAuth(destinationDir: string): Promise<void> {
  const source = authSourcePath();
  let stat;
  try {
    stat = await lstat(source);
  } catch (error) {
    throw new FactoryError(
      "codex_auth_unavailable",
      `Codex auth.json is unavailable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new FactoryError("codex_auth_unavailable", "Codex auth.json must be a regular file");
  }
  await mkdir(destinationDir, { recursive: true });
  const destination = path.join(destinationDir, "auth.json");
  await copyFile(source, destination);
  await chmod(destination, 0o600);
}

export function buildCodexContainerArgs(
  request: CodexRunRequest,
  containerName: string,
  runtimeDir: string,
): string[] {
  const writableParents = [...new Set(request.writablePaths.map((relativePath) => path.dirname(relativePath)))];
  const containerUid = process.getuid?.() ?? 1000;
  const containerGid = process.getgid?.() ?? 1000;
  const args = [
    "run",
    "--rm",
    "--interactive",
    "--name",
    containerName,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    // Docker's default seccomp profile blocks the unprivileged user namespace
    // that Codex's inner bubblewrap sandbox requires. The dedicated VM remains
    // the outer syscall/host boundary; all Linux capabilities stay dropped.
    "--security-opt=seccomp=unconfined",
    "--security-opt=apparmor=unconfined",
    "--pids-limit=256",
    "--memory=2g",
    "--cpus=2",
    "--network=bridge",
    "--user",
    `${containerUid}:${containerGid}`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
    "--tmpfs",
    `/workspace/.agents:rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=${containerUid},gid=${containerGid}`,
    "--tmpfs",
    `/workspace/.codex:rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=${containerUid},gid=${containerGid}`,
    "--env",
    "HOME=/tmp/home",
    "--env",
    "TMPDIR=/tmp",
    "--env",
    "CODEX_HOME=/tmp/home/.codex",
    "--mount",
    `type=bind,src=${request.worktreePath},dst=/workspace,readonly`,
  ];
  for (const relativeParent of writableParents) {
    args.push(
      "--mount",
      `type=bind,src=${path.join(request.worktreePath, relativeParent)},dst=${path.posix.join("/workspace", relativeParent)}`,
    );
  }
  args.push(
    "--mount",
    `type=bind,src=${path.join(runtimeDir, "auth")},dst=/codex-auth,readonly`,
    "--mount",
    `type=bind,src=${path.join(runtimeDir, "output")},dst=/output`,
    "--workdir",
    "/workspace",
    CODEX_WORKER_IMAGE,
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--strict-config",
    "--json",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
    "--config",
    'approval_policy="never"',
    "--config",
    "sandbox_workspace_write.network_access=false",
    "--config",
    "tools.web_search=false",
    "--cd",
    "/workspace",
    "--output-last-message",
    "/output/codex-last-message.txt",
    "-",
  );
  return args;
}

/** Strong production runner: Colima VM → hardened Docker worker → inner Codex sandbox. */
export function createCodexRunner(opts: CodexRunnerOptions): CodexRunner {
  let isolationReady: Promise<void> | undefined;
  return async (request) => {
    isolationReady ??= assertStrongExecutionIsolationAvailable(opts.repoRoot);
    await isolationReady;
    const runtimeRoot = path.join(opts.repoRoot, ".factory", "codex-runtime");
    const containerName = safeContainerName(request.runDir);
    const runtimeDir = path.join(runtimeRoot, containerName);
    const outputDir = path.join(runtimeDir, "output");

    // Docker cannot create a nested tmpfs mountpoint beneath the read-only
    // worktree bind. This empty Factory-owned directory is never represented by
    // Git and is covered by container-local tmpfs for the lifetime of the run.
    await Promise.all(
      [".agents", ".codex"].map((entry) => mkdir(path.join(request.worktreePath, entry), { recursive: true })),
    );

    for (const relativePath of request.writablePaths) {
      const absolute = path.resolve(request.worktreePath, relativePath);
      const relative = path.relative(request.worktreePath, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new FactoryError("scope_violation", `${relativePath}: writable path escapes worktree`);
      }
      await mkdir(path.dirname(absolute), { recursive: true });
    }

    try {
      await mkdir(outputDir, { recursive: true });
      await prepareMinimalAuth(path.join(runtimeDir, "auth"));
      const args = buildCodexContainerArgs(request, containerName, runtimeDir);
      const result = await runProcess("docker", args, {
        cwd: opts.repoRoot,
        env: dockerClientEnv(opts.repoRoot),
        timeoutMs: request.timeoutMs,
        input: request.prompt,
      });
      const lastMessage = await readFile(path.join(outputDir, "codex-last-message.txt"), "utf8").catch(() => "");
      await writeFile(path.join(request.runDir, "codex-last-message.txt"), lastMessage, "utf8");
      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        version: `codex-cli ${CODEX_VERSION}`,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } finally {
      await runProcess("docker", ["rm", "--force", containerName], {
        cwd: opts.repoRoot,
        env: dockerClientEnv(opts.repoRoot),
        timeoutMs: 30_000,
      }).catch(() => undefined);
      await rm(runtimeDir, { recursive: true, force: true });
    }
  };
}
