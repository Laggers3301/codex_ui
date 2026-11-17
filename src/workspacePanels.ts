import { lazyNamed } from "./lazyPanel";

// Panels that are only needed once their right-workspace tab or dialog body is opened. Their CSS stays
// in the entry stylesheet (imported by App.tsx) so cascade order is unchanged; only the JS is deferred.
export const TerminalPanel = lazyNamed(() => import("./TerminalPanel"), "TerminalPanel");
export const BrowserPanel = lazyNamed(() => import("./BrowserPanel"), "BrowserPanel");
export const SubagentPanel = lazyNamed(() => import("./SubagentPanel"), "SubagentPanel");
export const FeishuOffice = lazyNamed(() => import("./FeishuOffice"), "FeishuOffice");
export const SessionCommunication = lazyNamed(() => import("./SessionCommunication"), "SessionCommunication");
export const HostResourcePanel = lazyNamed(() => import("./HostResourcePanel"), "HostResourcePanel");
export const LeaderboardPanel = lazyNamed(() => import("./LeaderboardPanel"), "LeaderboardPanel");

const panels: Record<string, { preload: () => void }> = {
  terminal: TerminalPanel, browser: BrowserPanel, agents: SubagentPanel, feishu: FeishuOffice,
  communication: SessionCommunication, resources: HostResourcePanel, leaderboard: LeaderboardPanel
};

/** Start fetching a panel chunk (hover/focus/touch on its entry). Unknown ids are ignored. */
export function warmWorkspacePanel(id: string | null | undefined) { if (id) panels[id]?.preload(); }

/** The light panels reachable from the right-workspace overview; the terminal (xterm) is warmed only on its own entry. */
export function warmWorkspacePanels() {
  for (const id of ["resources", "communication", "feishu", "browser", "agents"]) panels[id].preload();
}

const entryPanels: Record<string, string[]> = {
  "主机资源": ["resources"], "会话通信": ["communication"], "飞书办公": ["feishu"], "浏览器": ["browser"], "交互终端": ["terminal"],
  "工作区工具": ["terminal", "browser"], "设置与用量": ["leaderboard"], "用量排行": ["leaderboard"]
};

/**
 * One delegated listener warms the chunk for whatever entry the pointer/finger/focus reaches first: overview
 * entries, host-resource tiles, subagent cards, the leaderboard button, the right-panel toggles and the phone
 * "add" sheet items. Missing a match only costs the first open a short Suspense placeholder.
 */
export function installWorkspacePanelWarmup(): () => void {
  const warm = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest(".rightWorkspaceToggle")) { warmWorkspacePanels(); return; }
    if (target.closest(".leaderboardButton")) { warmWorkspacePanel("leaderboard"); return; }
    if (target.closest(".hostResourceTile, .hostNetworkButton")) { warmWorkspacePanel("resources"); return; }
    if (target.closest(".subagentRow, .subagentRecipient, .subagentToolCard")) { warmWorkspacePanel("agents"); return; }
    const entry = target.closest(".rightWorkspaceOverview .rightWorkspaceEntry, .mobileUiSheet button");
    if (!entry) return;
    if (entry.closest("section")?.querySelector("h3")?.textContent === "子代理") { warmWorkspacePanel("agents"); return; }
    const label = entry.querySelector("strong")?.textContent ?? entry.textContent ?? "";
    for (const id of entryPanels[label.replace(/[›\s]+$/, "").trim()] ?? []) warmWorkspacePanel(id);
  };
  const events = ["pointerover", "pointerdown", "focusin"] as const;
  for (const name of events) document.addEventListener(name, warm, { passive: true });
  return () => { for (const name of events) document.removeEventListener(name, warm); };
}
