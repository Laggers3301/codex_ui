import {expect,it} from "vitest";
import {effortDescending,profilesByDescendingEffort} from "./effortOrder";
import type {ModelProfile} from "./types";

it("shows higher effort first without changing model groups, ids, or the input",()=>{
  const profiles=["opus","sonnet"].flatMap(model=>["low","medium","high","xhigh","max"].map(effort=>({id:`${model}:${effort}`,model,effort}) as ModelProfile));
  const ordered=profilesByDescendingEffort(profiles);
  expect(ordered.map(p=>p.id)).toEqual(["opus:max","opus:xhigh","opus:high","opus:medium","opus:low","sonnet:max","sonnet:xhigh","sonnet:high","sonnet:medium","sonnet:low"]);
  expect(ordered[0]).toBe(profiles[4]);expect(profiles[0].effort).toBe("low");
  expect(["medium","low","max","high"].sort(effortDescending)).toEqual(["max","high","medium","low"]);
});
