import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { prepareClaudeForkHistory } from "./claudeForkHistory.js";

const cleanups:string[]=[];
afterEach(()=>{for(const root of cleanups.splice(0))fs.rmSync(root,{recursive:true,force:true});});
const stamp="2026-01-01T00:00:00.000Z";
function row(type:string,content:any,timestamp=stamp){return{type,uuid:randomUUID(),timestamp,sessionId:randomUUID(),message:{role:type,content}};}
function fixture(rows:any[]){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"claude-archive-"));cleanups.push(root);
  const original=path.join(root,"original.jsonl"),file=path.join(root,"staging.jsonl");
  fs.writeFileSync(original,rows.map(value=>typeof value==="string"?value:JSON.stringify(value)).join("\n")+"\n");fs.copyFileSync(original,file);
  return{root,file,original,options:{threadId:randomUUID(),directory:path.join(root,"archive"),targetBytes:80*1024}};
}
describe("native Claude fork tool-result archives",()=>{
  it("archives only older tool results and keeps the last two complete turns, prose and opaque data",async()=>{
    const older=row("user",[{type:"tool_result",tool_use_id:"old-tool",content:"FULL-OLDER-RESULT"+"x".repeat(180000)},{type:"text",text:"保留用户正文"},{type:"unknown",encrypted_content:"opaque-preserved"}]);
    const recent=[row("user",[{type:"text",text:"最近第二轮用户问题"}]),row("assistant",[{type:"text",text:"最近第二轮回答"}]),
      row("user",[{type:"tool_result",content:"keep-recent-"+"a".repeat(12000)}]),row("user",[{type:"text",text:"最近一轮用户问题"}]),row("assistant",[{type:"text",text:"最近一轮回答"}])];
    const rows=[row("user",[{type:"text",text:"原始用户问题"}]),older,row("assistant",[{type:"text",text:"保留全部助手正文"}]),...recent],f=fixture(rows),original=fs.readFileSync(f.original);
    const archive=await prepareClaudeForkHistory(f.file,f.options);
    expect(archive?.summary.archivedRecords).toBe(1);expect(fs.statSync(f.file).size).toBeLessThan(f.options.targetBytes);
    expect(fs.readFileSync(f.original)).toEqual(original);
    const actual=fs.readFileSync(f.file,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(actual.slice(-recent.length)).toEqual(recent);expect(actual[0]).toEqual(rows[0]);expect(actual[2]).toEqual(rows[2]);
    expect(actual[1].message.content.slice(1)).toEqual(older.message.content.slice(1));
    expect(gunzipSync(fs.readFileSync(archive!.path)).toString()).toContain(JSON.stringify(older));
  });
  it("requires verified import provenance before compacting quoted tool output",async()=>{
    const imported=row("user",[{type:"text",text:"[历史工具结果，仅供参考]\n"+"x".repeat(90000)}]);
    const realUser=row("user",[{type:"text",text:"[历史工具结果，仅供参考]\n"+"USER-PROSE".repeat(1200)}],"2026-02-01T00:00:00.000Z");
    const recent=[row("user","question 1"),row("assistant","answer 1"),row("user","question 2"),row("assistant","answer 2")];
    const f=fixture([imported,realUser,...recent]);
    await expect(prepareClaudeForkHistory(f.file,{...f.options,targetBytes:30000})).rejects.toMatchObject({code:"claude_history_too_large"});
    expect(fs.readFileSync(f.file)).toEqual(fs.readFileSync(f.original));
    const archive=await prepareClaudeForkHistory(f.file,{...f.options,targetBytes:30000,imported:{timestamp:stamp}});
    expect(archive?.summary.archivedRecords).toBe(1);
    const actual=fs.readFileSync(f.file,"utf8").trim().split("\n").map(line=>JSON.parse(line));expect(actual[1]).toEqual(realUser);expect(actual.slice(-recent.length)).toEqual(recent);
  });
  it("preserves all user and assistant text if tool-only compaction cannot meet the budget",async()=>{
    const f=fixture([row("user","genuine-user-text".repeat(10000)),row("assistant","answer"),row("user","second"),row("assistant","answer")]);
    await expect(prepareClaudeForkHistory(f.file,f.options)).rejects.toMatchObject({code:"claude_history_too_large"});
    expect(fs.readFileSync(f.file)).toEqual(fs.readFileSync(f.original));expect(fs.existsSync(path.join(f.options.directory,"tool-results.jsonl.gz"))).toBe(false);
  });
  it("retains earlier full archives when another organization switch needs more compaction",async()=>{
    const old=row("user",[{type:"tool_result",content:"first-original"+"x".repeat(120000)}]);
    const rows=[row("user","first"),old,row("user","second"),row("assistant","answer"),row("user","third"),row("assistant","answer")];
    const f=fixture(rows),previous=await prepareClaudeForkHistory(f.file,f.options);const oldBytes=fs.readFileSync(previous!.path);
    const next=fixture([rows[0],row("user",[{type:"tool_result",content:"second-original"+"z".repeat(120000)}]),...rows.slice(2)]);
    const archive=await prepareClaudeForkHistory(next.file,{...next.options,previous});
    const full=gunzipSync(fs.readFileSync(archive!.path)).toString();expect(full).toContain("first-original");expect(full).toContain("second-original");
    expect(archive?.summary.archivedRecords).toBe(2);expect(fs.readFileSync(previous!.path)).toEqual(oldBytes);
  });
});
