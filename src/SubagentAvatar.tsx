import { CircleFiveLine, Diamonds, GeometricFlowers, Planet, Robot, StarOne, SunOne } from "@icon-park/svg";
import "./subagentPanel.css";

const glyphs = [SunOne, GeometricFlowers, CircleFiveLine, Planet, Diamonds, StarOne];

// Identity depends on the canonical name, never list order, execution state,
// theme, or the currently loaded history window.
export function subagentAvatarIdentity(name: string): { glyph: number; color: number } {
  // The root is a role, not another hashed child identity. Reserve a unique
  // IconPark glyph so equal decorative child icons never imply equal recipients.
  if (name === "/root") return { glyph: glyphs.length, color: 3 };
  let hash = 2166136261;
  for (const char of name.replace(/^\/root\//, "")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return { glyph: hash % glyphs.length, color: Math.floor(hash / glyphs.length) % 6 };
}

export function SubagentAvatar({ name }: { name: string }) {
  const identity = subagentAvatarIdentity(name);
  // IconPark is already the application's Apache-licensed icon library. The
  // public OpenAI illustration assets don't declare a reuse license.
  const svg = (identity.glyph === glyphs.length ? Robot : glyphs[identity.glyph])({ theme: "multi-color", size: 16, strokeWidth: 3,
    fill: ["var(--agent-ink)", "var(--agent-fill)", "var(--agent-ink)", "var(--agent-fill)"] }).replace(/^<\?xml[^>]*>/, "");
  return <span className={`subagentAvatar agentColor${identity.color}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}
