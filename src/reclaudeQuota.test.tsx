import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ReclaudeQuotaDetails, reclaudeRemainingLabel } from "./reclaudeQuota";
import type { ReclaudeAccountUsage } from "../shared/reclaudeUsage";

const now=Date.UTC(2026,10,4,10);
const account:ReclaudeAccountUsage={orgId:"1",label:"组织名",state:"available",message:"额度随 ReClaude 更新。",retryAfterSeconds:null,windows:[
  {kind:"five_hour",percent:19,resetsAt:now+3600000,observedAt:now-10000,source:"response"},
  {kind:"seven_day",percent:41,resetsAt:now+604800000,observedAt:now-10000,source:"response"}
]};
it("keeps creation limits in quota details and distinguishes them from token windows",()=>{
  const creations={limit:5,used:1,remaining:4,windowSeconds:3600,retryAt:null,retryAfterSeconds:0};
  const html=renderToStaticMarkup(<ReclaudeQuotaDetails account={account} creations={creations} now={now}/>);
  expect(html).toContain('>新建</span>');expect(html).toContain('本小时剩余 4/5 次');
  expect(html).toContain('不影响已有会话继续回答');expect(html).not.toContain('全部 Claude 账号共用每小时');
  expect(renderToStaticMarkup(<ReclaudeQuotaDetails account={account} creations={{...creations,remaining:0,retryAfterSeconds:60}} now={now}/>)).toContain('后可重试');
});
it("shows both account windows and their reset times from the existing observation",()=>{
  const html=renderToStaticMarkup(<ReclaudeQuotaDetails account={account} now={now}/>);
  expect(html).toContain("ReClaude 额度");expect(html).not.toContain(account.label);expect(html).toContain("5 小时");expect(html).toContain("周限");
  for(const value of ["剩余 81%","已用 19%","剩余 59%","已用 41%","数据时间","重置"])expect(html).toContain(value);
  expect(reclaudeRemainingLabel(account,now)).toBe("59%");
  expect(html).not.toContain(account.message);
});
it("does not treat unknown or elapsed windows as zero usage or full remaining quota",()=>{
  expect(reclaudeRemainingLabel({...account,windows:[]},now)).toBe("--");
  const expired={...account,windows:account.windows.map(window=>({...window,resetsAt:now}))};
  const html=renderToStaticMarkup(<ReclaudeQuotaDetails account={expired} now={now}/>);
  expect(html).toContain("已到重置时间，待更新");expect(html).not.toContain("剩余 100%");
  expect(reclaudeRemainingLabel(expired,now)).toBe("--");
});
it("displays the actual stop type, including weekly and scoped weekly 99%",()=>{
  for(const [code,text,label] of [["claude_weekly_limit","周用量达到 99%","已停用"],["claude_five_hour_limit","5 小时额度已达上限","5h 已满"]] as const){
    const disabled={...account,state:"disabled" as const,limitCode:code};
    expect(renderToStaticMarkup(<ReclaudeQuotaDetails account={disabled} now={now}/>)).toContain(text);
    expect(reclaudeRemainingLabel(disabled,now)).toBe(label);
  }
});
