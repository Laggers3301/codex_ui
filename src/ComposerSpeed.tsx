import { Zap } from "lucide-react";
import type { ModelProfile } from "./types";

export type ComposerSpeed = "standard" | "fast" | "ultrafast";
export function readComposerSpeed(value: string | null): ComposerSpeed {
  return value === "ultrafast" ? "ultrafast" : value === "fast" || value === "true" ? "fast" : "standard";
}
export function canUseUltrafast(profile: ModelProfile, accountId?: string | null): boolean {
  return Boolean(profile.ultrafastAccounts?.length && (!accountId || profile.ultrafastAccounts.includes(accountId)));
}
export function effectiveComposerSpeed(speed: ComposerSpeed, profile: ModelProfile, accountId?: string | null): ComposerSpeed {
  return speed === "ultrafast" && !canUseUltrafast(profile, accountId) ? "standard" : speed;
}

const boltPath = "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z";
/** The speed button's glyph tells the tier at a glance: outline bolt = standard, solid bolt = fast, two solid bolts = ultra fast. */
export function ComposerSpeedIcon({ speed, size = 15 }: { speed: ComposerSpeed; size?: number }) {
  if (speed === "standard") return <Zap size={size} aria-hidden="true" />;
  if (speed === "fast") return <Zap size={size} fill="currentColor" aria-hidden="true" />;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true" data-speed="ultrafast">
    <path d={boltPath} transform="translate(-3.2 5) scale(.72)" /><path d={boltPath} transform="translate(6.8 -1) scale(.72)" />
  </svg>;
}

export const composerSpeedTitle = "Fast 使用更多额度；6.2 Ultra Fast 按标准模式的 6 倍计入套餐用量。";
/** Options for the desktop pull-up menu (the shared PolishedSelect); the phone sheet keeps its native picker. */
export function composerSpeedOptions(ultrafast: boolean): { value: ComposerSpeed; label: string; detail: string }[] {
  return [
    { value: "standard", label: "标准", detail: "默认速度" },
    { value: "fast", label: "快速", detail: "更快，使用更多额度" },
    ...(ultrafast ? [{ value: "ultrafast" as const, label: "超快", detail: "最快响应，按标准的 6 倍计入用量" }] : [])
  ];
}

export function ComposerSpeedSelect({ value, ultrafast, mobile, onChange }: {
  value: ComposerSpeed; ultrafast: boolean; mobile: boolean; onChange: (speed: ComposerSpeed) => void;
}) {
  return <label className={mobile ? "mobileSettingRow" : "iconTextButton v2FastModeButton"}
    title={composerSpeedTitle}>
    {mobile ? <span>速度</span> : null}
    <select aria-label="速度" value={value} onChange={event => onChange(readComposerSpeed(event.target.value))}
      style={mobile ? undefined : { background: "transparent", color: "inherit", border: 0, font: "inherit", cursor: "pointer", maxWidth: 150 }}>
      <option value="standard">标准</option><option value="fast">快速</option>
      {ultrafast ? <option value="ultrafast">超快</option> : null}
    </select>
  </label>;
}
