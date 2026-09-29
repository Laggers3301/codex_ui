import path from "node:path";

/** Disabled billing/execution accounts still own readable historical files.
 * Only trusted server configuration can extend this read-only allowlist. */
export function accountHistoryRoots(config: unknown): string[] {
  if (!config || typeof config !== "object") return [];
  const accounts = (config as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) return [];
  return accounts.flatMap(account => {
    if (!account || typeof account !== "object") return [];
    const home = (account as { codexHome?: unknown }).codexHome;
    return typeof home === "string" && path.isAbsolute(home) ? [path.join(home, "sessions")] : [];
  });
}
