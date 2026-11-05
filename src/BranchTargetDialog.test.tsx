import {renderToStaticMarkup} from "react-dom/server";
import {expect,it} from "vitest";
import {BranchTargetDialog} from "./BranchTargetDialog";
import type {CodexAccountPool,ModelProfile} from "./types";

it("offers GPT account targets and connected ReClaude while preserving automatic routing",()=>{
  const pool={accounts:[{id:"a",label:"Account A",kind:"codex-account"},{id:"provider",label:"Hidden API",kind:"api-provider"}]} as CodexAccountPool;
  const profiles=[{model:"gpt-fixture",id:"g",label:"GPT",effort:"medium"},{model:"reclaude-sonnet@1",id:"c",label:"Claude Sonnet",effort:"medium",availability:"ready"}] as ModelProfile[];
  const html=renderToStaticMarkup(<BranchTargetDialog sourceModel="gpt-fixture" pool={pool} profiles={profiles} onClose={()=>{}} onConfirm={async()=>true}/>);
  expect(html).toContain("自动选择（保留原模型）");expect(html).toContain("推理级别");expect(html).toContain('aria-haspopup="listbox"');expect(html).not.toContain("<select");expect(html).not.toContain("Hidden API");
  expect(html).toContain('aria-modal="true"');expect(html).toContain("原会话不变");
});
