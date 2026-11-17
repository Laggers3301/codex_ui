import type { ModelProfile, ReasoningEffort } from "./types";
import { modelIsAvailable } from "../shared/agentRuntime";
import { runtimeModelLabel } from "./runtimeModelLabel";

const effortNames: Record<ReasoningEffort, string> = {
  low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高", ultra: "Ultra",
};
const effortOrder: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

export function MobileModelFields({ value, profiles, disabled, onChange, onOpen }: {
  value: string; profiles: ModelProfile[]; disabled: boolean;
  onChange: (profileId: string) => void; onOpen: () => void;
}) {
  const selected = profiles.find(profile => profile.id === value) ?? profiles[0];
  if (!selected) return null;
  const models = [...new Set(profiles.map(profile => profile.model))];
  const levels = profiles.filter(profile => profile.model === selected.model);
  return <>
    <label className="mobileSettingRow"><span>模型</span>
      <select aria-label="模型" value={selected.model} disabled={disabled} onFocus={onOpen} onChange={event => {
        // Keep the same effort where supported; otherwise use the nearest real
        // available profile. Never invent an unsupported model/effort pairing.
        const choices = profiles.filter(profile => profile.model === event.target.value && modelIsAvailable(profile));
        const next = choices.find(profile => profile.effort === selected.effort) ?? choices.sort((a, b) =>
          Math.abs(effortOrder.indexOf(a.effort) - effortOrder.indexOf(selected.effort)) -
          Math.abs(effortOrder.indexOf(b.effort) - effortOrder.indexOf(selected.effort)))[0];
        if (next) onChange(next.id);
      }}>
        {models.map(model => {
          const options = profiles.filter(profile => profile.model === model);
          const profile = options[0];
          const name = runtimeModelLabel(profile).replace(/\s+(?:low|medium|high|xhigh|max|ultra)$/i, "");
          const available = options.some(modelIsAvailable);
          return <option key={model} value={model} disabled={!available}>{name}{!available ? " · 不可用" : ""}</option>;
        })}
      </select>
    </label>
    <label className="mobileSettingRow"><span>智能</span>
      <select aria-label="推理强度" value={selected.id} disabled={disabled || levels.filter(modelIsAvailable).length < 2}
        onChange={event => onChange(event.target.value)}>
        {levels.map(profile => <option key={profile.id} value={profile.id} disabled={!modelIsAvailable(profile)}>{effortNames[profile.effort]}</option>)}
      </select>
    </label>
  </>;
}
