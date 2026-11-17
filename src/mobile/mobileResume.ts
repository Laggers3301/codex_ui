type MobileResume = { projectId: string; threadId: string };
const key = (userId: string) => `codex-mobile-resume:${userId}`;

// Tab-local display state only. Access is still checked by the thread API;
// restoring a view never submits or resumes a model turn.
export function readMobileResume(storage: Storage, userId: string): MobileResume | null {
  try {
    const value = JSON.parse(storage.getItem(key(userId)) ?? "null");
    return value && typeof value.projectId === "string" && value.projectId
      && typeof value.threadId === "string" && value.threadId
      ? { projectId: value.projectId, threadId: value.threadId } : null;
  } catch { return null; }
}

export function writeMobileResume(storage: Storage, userId: string, value: MobileResume | null) {
  try {
    if (value) storage.setItem(key(userId), JSON.stringify(value));
    else storage.removeItem(key(userId));
  } catch { /* Private browsing may disable storage. */ }
}
