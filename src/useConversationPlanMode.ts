import { useCallback, useState, type SetStateAction } from "react";

function preferenceKey(userId: string, conversationId: string): string {
  return `codex-web-plan-mode:${encodeURIComponent(userId)}:${encodeURIComponent(conversationId)}`;
}

function storedMode(key: string): boolean | undefined {
  try {
    const value = window.localStorage.getItem(key);
    return value === "plan" ? true : value === "default" ? false : undefined;
  } catch { return undefined; }
}

/** A choice applies to the next turn, and stays with its user and conversation. */
export function useConversationPlanMode(userId: string, conversationId: string, nativeMode?: "plan" | "default") {
  const key = preferenceKey(userId, conversationId);
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const planMode = choices[key] ?? storedMode(key) ?? nativeMode === "plan";
  const setPlanMode = useCallback((next: SetStateAction<boolean>) => {
    const value = typeof next === "function" ? next(planMode) : next;
    try { window.localStorage.setItem(key, value ? "plan" : "default"); } catch { /* Keep the current tab usable without storage. */ }
    setChoices(current => ({ ...current, [key]: value }));
  }, [key, planMode]);
  return [planMode, setPlanMode] as const;
}
