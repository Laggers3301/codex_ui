import {describe,it,expect} from "vitest";
import {runtimeModelLabel,runtimeModelTriggerLabel} from "./runtimeModelLabel";
import type {ModelProfile} from "./types";

describe("Claude model version labels",()=>{
  const model:ModelProfile={id:"opus",model:"reclaude-opus@42",label:"Claude Opus · account42",effort:"medium",nativeModelId:"claude-opus-5-5"};
  it("shows the native version even when cached labels contain only a family and numbered account",()=>{
    expect(runtimeModelLabel(model)).toBe("Claude Opus 5.5");
    expect(runtimeModelTriggerLabel(model,true)).toBe("Opus 5.5");
    expect(runtimeModelTriggerLabel(model,false)).toBe("Claude Opus 5.5");
  });
  it("keeps supplied version names and does not guess a version for unconnected previews",()=>{
    expect(runtimeModelLabel({...model,displayName:"Claude Opus 4.6 · account42",nativeModelId:"claude-opus-4-6"})).toBe("Claude Opus 4.6");
    expect(runtimeModelLabel({...model,nativeModelId:undefined})).toBe("Claude Opus");
    expect(runtimeModelLabel({...model,nativeModelId:"claude-haiku-4-5-20251001",label:"Claude Haiku"})).toBe("Claude Haiku 4.5");
  });
  it("shows effort on the compact trigger only when the native catalogue advertises it",()=>{
    expect(runtimeModelTriggerLabel({...model,effort:"max",supportedEffortLevels:["medium","max"]},false)).toBe("Claude Opus 5.5 max");
    expect(runtimeModelTriggerLabel({...model,effort:"max",supportedEffortLevels:["medium","max"]},true)).toBe("Opus 5.5 max");
  });
});
