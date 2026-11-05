import {isReclaudeModel} from "../shared/agentRuntime";
import type {ModelProfile} from "./types";

export function runtimeModelLabel(profile: ModelProfile): string {
  if(!isReclaudeModel(profile.model))return profile.model.endsWith("-ark-api")?profile.label.replace(" · Ark API 按量",""):profile.label;
  const names=[profile.displayName,profile.label].filter((name):name is string=>Boolean(name?.trim())).map(name=>name.split(" · ")[0]);
  const versioned=names.find(name=>/\d/.test(name.split(" · ")[0]));
  if(versioned)return versioned;
  const native=profile.nativeModelId?.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i);
  const name=names[0]??"Claude";
  if(!native)return name;
  const family=native[1][0].toUpperCase()+native[1].slice(1),version=native[2]+(native[3]?`.${native[3]}`:"");
  const suffix=name.includes(" · ")?name.slice(name.indexOf(" · ")):"";
  return `Claude ${family} ${version}${suffix}`;
}

/** Keep the version visible before account labels on narrow mobile controls. */
export function runtimeModelTriggerLabel(profile: ModelProfile, mobile: boolean): string {
  const label=runtimeModelLabel(profile)+(isReclaudeModel(profile.model)&&profile.supportedEffortLevels?.length?` ${profile.effort}`:"");
  return mobile&&isReclaudeModel(profile.model)?label.split(" · ")[0].replace(/^Claude\s+/i,""):label;
}
