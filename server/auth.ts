import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { serverConfig } from "./config.js";

export const sessionCookieName = "codex_remote_session";
// Browser implementations may cap very long cookies, so we use a long-lived
// persistent cookie and refresh it on every authenticated request.
export const sessionMaxAgeSeconds = Number(process.env.CODEX_WEB_SESSION_MAX_AGE_SECONDS ?? 400 * 24 * 60 * 60);

type HeaderValue = string | string[] | undefined;
type HeadersLike = { cookie?: HeaderValue; authorization?: HeaderValue };

type StoredUser = {
  salt: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
};

type UserDb = {
  users: Record<string, StoredUser>;
};

function firstHeader(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function usersFilePath(): string {
  return path.resolve(serverConfig.authUsersFile || path.join(serverConfig.dataDir, "auth-users.json"));
}

function authDir(): string {
  return path.dirname(usersFilePath());
}

function ensureAuthDir(): void {
  fs.mkdirSync(authDir(), { recursive: true, mode: 0o700 });
}

function sessionSecret(): string {
  if (process.env.CODEX_WEB_SESSION_SECRET) {
    return process.env.CODEX_WEB_SESSION_SECRET;
  }
  ensureAuthDir();
  const filePath = path.join(authDir(), "session-secret");
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  }
  return fs.readFileSync(filePath, "utf8").trim();
}

function loadUsers(): UserDb {
  const filePath = usersFilePath();
  if (!fs.existsSync(filePath)) {
    return { users: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as UserDb;
    return { users: parsed.users && typeof parsed.users === "object" ? parsed.users : {} };
  } catch {
    return { users: {} };
  }
}

function saveUsers(db: UserDb): void {
  ensureAuthDir();
  fs.writeFileSync(usersFilePath(), `${JSON.stringify(db, null, 2)}\n`, { mode: 0o600 });
}

function passwordHash(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function verifyStoredPassword(user: StoredUser, password: string): boolean {
  return safeEqual(user.hash, passwordHash(password, user.salt));
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) {
    return result;
  }
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

function cookieAttributes(maxAgeSeconds: number): string {
  return `HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function authEnabled(): boolean {
  return serverConfig.authMode !== "off";
}

export function verifyCredentials(username: string, password: string): boolean {
  const cleanUsername = username.trim();
  if (!cleanUsername || !password) {
    return false;
  }

  const db = loadUsers();
  const stored = db.users[cleanUsername];
  if (stored) {
    return verifyStoredPassword(stored, password);
  }

  // Optional administrator fallback, if configured.
  if (serverConfig.authUser && serverConfig.authPassword && safeEqual(cleanUsername, serverConfig.authUser)) {
    return safeEqual(password, serverConfig.authPassword);
  }

  // In member mode, only explicitly provisioned users may log in.
  if (serverConfig.authMode === "member") {
    return false;
  }

  // Bootstrap mode permits a new account only when an operator deliberately
  // supplied a non-empty bootstrap password. Unknown modes fail closed.
  return serverConfig.authMode === "bootstrap"
    && Boolean(serverConfig.defaultAuthPassword)
    && safeEqual(password, serverConfig.defaultAuthPassword);
}

export function createSessionCookie(username: string): string {
  const expiresAt = Date.now() + sessionMaxAgeSeconds * 1000;
  const payload = base64UrlEncode(JSON.stringify({ u: username.trim(), exp: expiresAt }));
  const token = `${payload}.${sign(payload)}`;
  return `${sessionCookieName}=${token}; ${cookieAttributes(sessionMaxAgeSeconds)}`;
}

export function clearSessionCookie(): string {
  return `${sessionCookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

export function authenticatedUserFromHeaders(headers: HeadersLike): string | null {
  if (!authEnabled()) {
    return "auth-disabled";
  }
  const cookies = parseCookies(firstHeader(headers.cookie));
  const token = cookies[sessionCookieName];
  if (!token) {
    return null;
  }
  const dot = token.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, sign(payload))) {
    return null;
  }
  try {
    const data = JSON.parse(base64UrlDecode(payload)) as { u?: unknown; exp?: unknown };
    if (typeof data.u !== "string" || typeof data.exp !== "number") {
      return null;
    }
    if (Date.now() > data.exp) {
      return null;
    }
    return data.u;
  } catch {
    return null;
  }
}

export function isRequestAuthorized(headers: HeadersLike): boolean {
  return !authEnabled() || authenticatedUserFromHeaders(headers) !== null;
}

export function changeUserPassword(username: string, currentPassword: string, nextPassword: string): void {
  const cleanUsername = username.trim();
  if (!cleanUsername) {
    throw new Error("用户名不能为空。");
  }
  if (!verifyCredentials(cleanUsername, currentPassword)) {
    throw new Error("当前密码不正确。");
  }
  if (nextPassword.length < 2) {
    throw new Error("新密码太短。");
  }
  if (serverConfig.defaultAuthPassword && nextPassword === serverConfig.defaultAuthPassword) {
    throw new Error("新密码不能继续使用初始密码。");
  }

  const db = loadUsers();
  const now = new Date().toISOString();
  const salt = randomBytes(16).toString("hex");
  db.users[cleanUsername] = {
    salt,
    hash: passwordHash(nextPassword, salt),
    createdAt: db.users[cleanUsername]?.createdAt ?? now,
    updatedAt: now
  };
  saveUsers(db);
}
