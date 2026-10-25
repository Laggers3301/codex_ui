import {expect,it} from "vitest";
import {mergeTimelineItems,mergeSteerTimelineItems,latestUserTimelineIndex,type SteerTimelineBoundary} from "./conversationTimeline";
import type {ThreadItem} from "./types";
const old: ThreadItem[]=[{id:"first-user",type:"userMessage",text:"继续",timelineAt:"2026-10-25T00:00:00Z"},{id:"old-call",callId:"call-1",type:"toolCall",timelineAt:"2026-10-25T00:00:01Z"}];
const boundary:SteerTimelineBoundary={id:"steer-user",text:"继续",timelineAt:"2026-10-25T00:01:00Z",beforeItemIds:["first-user","old-call","call-1"]};
it("inserts a steer inside its running turn immediately, without moving previous output",()=>{
  const items=mergeSteerTimelineItems(old,[boundary]);expect(items.map(i=>i.id)).toEqual(["first-user","old-call","steer-user"]);expect(latestUserTimelineIndex(items)).toBe(2);
});
it("puts new reasoning, tools and answers after the steer despite a backward server clock",()=>{
  const newer:ThreadItem[]=[{id:"new-reason",type:"reasoning",summary:["新的思考"],timelineAt:"2026-10-25T00:00:02Z",timelineLive:true},{id:"new-call",type:"toolCall",timelineAt:"2026-10-25T00:00:03Z",timelineLive:true},{id:"new-answer",type:"agentMessage",text:"新的回答",timelineAt:"2026-10-25T00:00:04Z",timelineLive:true}];
  const result=mergeSteerTimelineItems(mergeTimelineItems(old,newer),[boundary]);expect(result.map(i=>i.id)).toEqual(["first-user","call-1","steer-user","new-reason","new-call","new-answer"]);
});
it("does not move an existing tool when its delayed output completes",()=>{
  const result=mergeSteerTimelineItems([{...old[0]},{...old[1],id:"call-1",sourceItemId:"old-call",timelineLive:true,completed:true,timelineAt:"2026-10-25T00:02:00Z"}],[boundary]);expect(result.map(i=>i.id)).toEqual(["first-user","call-1","steer-user"]);
});
it("deduplicates the new persisted user without swallowing repeated prompt text",()=>{
  const native:ThreadItem={id:"native-steer",type:"userMessage",text:"继续",timelineAt:boundary.timelineAt};
  const result=mergeSteerTimelineItems([...old,native,{id:"answer",type:"agentMessage",timelineLive:true}],[boundary]);expect(result.map(i=>i.id)).toEqual(["first-user","old-call","native-steer","answer"]);
});
it("keeps successive steers ordered and lets old-history pagination remain before them",()=>{
  const next={...boundary,id:"steer-2",text:"再补充",timelineAt:"2026-10-25T00:02:00Z",beforeItemIds:[...boundary.beforeItemIds,boundary.id,"answer-1"]};
  const result=mergeSteerTimelineItems([...old,{id:"answer-1",type:"agentMessage",timelineLive:true},{id:"answer-2",type:"agentMessage",timelineLive:true}],[boundary,next]);
  expect(result.map(i=>i.id)).toEqual(["first-user","old-call","steer-user","answer-1","steer-2","answer-2"]);
  expect(mergeSteerTimelineItems([{id:"older",type:"agentMessage"},...result],[boundary,next]).map(i=>i.id)).toEqual(["older","first-user","old-call","steer-user","answer-1","steer-2","answer-2"]);
});
it("leaves normal queueing and historical turns untouched without a steer boundary",()=>{
  expect(mergeSteerTimelineItems(old,[])).toBe(old);
});
