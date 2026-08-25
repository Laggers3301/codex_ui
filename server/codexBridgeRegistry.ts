import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { CodexBridge, type CodexBridgeLaunchOptions } from "./codexBridge.js";

/**
 * A bridge target is selected by the already-authenticated application user.
 * Targets must be installed by an administrator; browser supplied values must
 * never be passed to this registry.
 */
export type CodexBridgeTarget = LocalCodexBridgeTarget | SshCodexBridgeTarget;

export interface LocalCodexBridgeTarget {
  kind: "local";
}

export interface SshCodexBridgeTarget {
  kind: "ssh";
  host: string;
  sshUser: string;
  /** Absolute working directory on the dedicated remote service. */
  workspacePath: string;
  port?: number;
  identityFile?: string;
  knownHostsFile?: string;
  codexBin?: string;
  connectTimeoutSeconds?: number;
}

export type UserCodexBridgeTargets = Readonly<Record<string, CodexBridgeTarget>>;

type NormalizedSshCodexBridgeTarget = Required<Omit<SshCodexBridgeTarget, "identityFile" | "knownHostsFile">> & Pick<SshCodexBridgeTarget, "identityFile" | "knownHostsFile">;
type NormalizedCodexBridgeTarget = LocalCodexBridgeTarget | NormalizedSshCodexBridgeTarget;

const DEFAULT_SSH_PORT = 22;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

function configurationError(field: string): Error {
  // Do not include configured values in errors.  These errors can be logged by
  // a process manager and a target may contain infrastructure details.
  return new Error(`Invalid Codex bridge configuration: ${field}.`);
}

function normalizeUserKey(value: string): string {
  const userKey = value.trim();
  if (!userKey || userKey.length > 256 || /[\u0000-\u001f\u007f]/.test(userKey)) {
    throw configurationError("user key");
  }
  return userKey;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw configurationError(field);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw configurationError(field);
  }
  return trimmed;
}

function normalizeHost(value: unknown): string {
  const host = requireString(value, "SSH host");
  if (isIP(host) !== 0) {
    return host;
  }

  const labels = host.split(".");
  if (
    host.length > 253
    || labels.length === 0
    || labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  ) {
    throw configurationError("SSH host");
  }
  return host.toLowerCase();
}

function normalizeSshUser(value: unknown): string {
  const user = requireString(value, "SSH user");
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(user)) {
    throw configurationError("SSH user");
  }
  return user;
}

function normalizePort(value: unknown, field: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw configurationError(field);
  }
  return value;
}

function normalizeTimeout(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_CONNECT_TIMEOUT_SECONDS;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 60) {
    throw configurationError("SSH connect timeout");
  }
  return value;
}

function normalizeAbsolutePath(value: unknown, field: string): string {
  const filePath = requireString(value, field);
  if (!path.isAbsolute(filePath) || !/^[A-Za-z0-9_./+-]+$/.test(filePath)) {
    throw configurationError(field);
  }
  const normalized = path.resolve(filePath);
  if (normalized.split(path.sep).includes("..")) {
    throw configurationError(field);
  }
  return normalized;
}

function normalizeRemoteExecutable(value: unknown): string {
  if (value === undefined) {
    return "codex";
  }
  const executable = requireString(value, "remote Codex executable");
  if (!/^[A-Za-z0-9_./+-]+$/.test(executable) || executable.split("/").includes("..")) {
    throw configurationError("remote Codex executable");
  }
  return executable;
}

function normalizeRemoteWorkspacePath(value: unknown): string {
  const workspacePath = requireString(value, "remote Codex workspace path");
  // This path is sent as JSON-RPC data (never interpolated into a shell), but
  // keeping it to a conservative absolute POSIX path avoids accidental use of
  // a local gateway path on the remote service.
  if (!path.posix.isAbsolute(workspacePath) || !/^[A-Za-z0-9_./+\-]+$/.test(workspacePath) || workspacePath.split("/").includes("..")) {
    throw configurationError("remote Codex workspace path");
  }
  return path.posix.normalize(workspacePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTarget(target: unknown): NormalizedCodexBridgeTarget {
  if (!isRecord(target) || target.kind === "local") {
    if (isRecord(target) && target.kind === "local") {
      return { kind: "local" };
    }
    throw configurationError("target kind");
  }
  if (target.kind !== "ssh") {
    throw configurationError("target kind");
  }

  return {
    kind: "ssh",
    host: normalizeHost(target.host),
    sshUser: normalizeSshUser(target.sshUser),
    workspacePath: normalizeRemoteWorkspacePath(target.workspacePath),
    port: normalizePort(target.port, "SSH port", DEFAULT_SSH_PORT),
    identityFile: target.identityFile === undefined ? undefined : normalizeAbsolutePath(target.identityFile, "SSH identity file"),
    knownHostsFile: target.knownHostsFile === undefined ? undefined : normalizeAbsolutePath(target.knownHostsFile, "SSH known-hosts file"),
    codexBin: normalizeRemoteExecutable(target.codexBin),
    connectTimeoutSeconds: normalizeTimeout(target.connectTimeoutSeconds)
  };
}

/**
 * Construct an SSH stdio transport for a remote `codex app-server`.
 *
 * There is intentionally no shell command or local fallback.  The target is
 * validated before it becomes SSH arguments, password prompting is disabled,
 * and SSH configuration files are ignored so an alias cannot silently route a
 * user's request elsewhere.
 */
export function createSshCodexBridgeLaunch(target: SshCodexBridgeTarget): CodexBridgeLaunchOptions {
  const normalized = normalizeTarget(target);
  if (normalized.kind !== "ssh") {
    throw configurationError("SSH target");
  }

  const args = [
    "-F", "/dev/null",
    "-T",
    "-o", "BatchMode=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "ChallengeResponseAuthentication=no",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", "PreferredAuthentications=publickey",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "UpdateHostKeys=no",
    "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "PermitLocalCommand=no",
    "-o", `ConnectTimeout=${normalized.connectTimeoutSeconds}`,
    "-p", String(normalized.port)
  ];

  if (normalized.identityFile) {
    args.push("-i", normalized.identityFile, "-o", "IdentitiesOnly=yes");
  }
  if (normalized.knownHostsFile) {
    args.push("-o", `UserKnownHostsFile=${normalized.knownHostsFile}`, "-o", "GlobalKnownHostsFile=/dev/null");
  }

  args.push(
    `${normalized.sshUser}@${normalized.host}`,
    normalized.codexBin,
    "app-server",
    "--listen",
    "stdio://"
  );

  return {
    command: "ssh",
    args
  };
}

/**
 * Makes one bridge per authenticated user.  An unknown user is an error:
 * callers cannot silently fall back to the local account/service.
 */
export class CodexBridgeRegistry {
  private readonly targets = new Map<string, NormalizedCodexBridgeTarget>();
  private readonly bridges = new Map<string, CodexBridge>();

  constructor(targets: UserCodexBridgeTargets = {}) {
    for (const [userKey, target] of Object.entries(targets)) {
      const normalizedUserKey = normalizeUserKey(userKey);
      if (this.targets.has(normalizedUserKey)) {
        throw configurationError("duplicate user key");
      }
      this.targets.set(normalizedUserKey, normalizeTarget(target));
    }
  }

  static fromFile(filePath: string): CodexBridgeRegistry {
    const safePath = normalizeAbsolutePath(filePath, "bridge targets file");
    const stat = fs.statSync(safePath);
    if (!stat.isFile() || stat.size > MAX_CONFIG_FILE_BYTES) {
      throw configurationError("bridge targets file");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(safePath, "utf8"));
    } catch {
      throw configurationError("bridge targets file");
    }
    if (!isRecord(parsed) || !isRecord(parsed.users)) {
      throw configurationError("bridge targets file");
    }

    const targets = Object.create(null) as Record<string, CodexBridgeTarget>;
    for (const [userKey, value] of Object.entries(parsed.users)) {
      if (!isRecord(value)) {
        throw configurationError("user target");
      }
      targets[userKey] = value as unknown as CodexBridgeTarget;
    }
    return new CodexBridgeRegistry(targets);
  }

  hasTargetForUser(userId: string): boolean {
    return this.targets.has(normalizeUserKey(userId));
  }

  getTargetKindForUser(userId: string): CodexBridgeTarget["kind"] | undefined {
    return this.targets.get(normalizeUserKey(userId))?.kind;
  }

  /**
   * Returns the execution-side cwd for a configured user.  SSH targets must
   * declare their remote workspace explicitly; using the gateway project path
   * here would make a remote service fail unpredictably or touch the wrong
   * filesystem.
   */
  getWorkingDirectoryForUser(userId: string, localFallback: string): string {
    const target = this.targets.get(normalizeUserKey(userId));
    return target?.kind === "ssh" ? target.workspacePath : localFallback;
  }

  getBridgeForUser(userId: string): CodexBridge {
    const userKey = normalizeUserKey(userId);
    const existing = this.bridges.get(userKey);
    if (existing) {
      return existing;
    }

    const target = this.targets.get(userKey);
    if (!target) {
      // Deliberately do not create a local bridge here.  A missing mapping must
      // be fixed by configuration, otherwise the request would spend another
      // user's/local service quota.
      throw new Error("No dedicated Codex service is configured for this user.");
    }

    const bridge = target.kind === "local"
      ? new CodexBridge()
      : new CodexBridge(createSshCodexBridgeLaunch(target));
    this.bridges.set(userKey, bridge);
    return bridge;
  }

  stopBridgeForUser(userId: string): void {
    const userKey = normalizeUserKey(userId);
    const bridge = this.bridges.get(userKey);
    if (!bridge) {
      return;
    }
    bridge.stop();
    this.bridges.delete(userKey);
  }

  stopAll(): void {
    for (const bridge of this.bridges.values()) {
      bridge.stop();
    }
    this.bridges.clear();
  }
}

/**
 * Optional convenience for a process-level registry.  The file is opt-in;
 * when no file is configured, all per-user lookups fail closed rather than
 * using the process-local Codex bridge.
 *
 * File format:
 * {
 *   "users": {
 *     "member-a": { "kind": "ssh", "host": "host.example", "sshUser": "remoteuser", "workspacePath": "/home/remoteuser", "identityFile": "/secure/key", "knownHostsFile": "/secure/known_hosts" },
 *     "member-b": { "kind": "local" }
 *   }
 * }
 */
export function loadCodexBridgeRegistryFromEnvironment(environment: NodeJS.ProcessEnv = process.env): CodexBridgeRegistry {
  const configuredPath = environment.CODEX_WEB_BRIDGE_TARGETS_FILE;
  return configuredPath ? CodexBridgeRegistry.fromFile(configuredPath) : new CodexBridgeRegistry();
}
