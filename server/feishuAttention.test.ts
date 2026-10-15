import { describe, expect, it } from "vitest";
import { needsFeishuAuthorization } from "../src/useFeishuAttention";
describe("飞书右栏授权提示", () => {
  it("只识别飞书工具的明确个人授权需求", () => {
    expect(needsFeishuAuthorization({tool:"mcp__codex_feishu__feishu_office",error:"请先连接或重新授权自己的飞书账号。"})).toBe(true);
    expect(needsFeishuAuthorization({tool:"feishu_office",result:{needsAuthorization:true}})).toBe(true);
    expect(needsFeishuAuthorization({tool:"feishu_office",result:'{"needsAuthorization":true}'})).toBe(true);
    expect(needsFeishuAuthorization({tool:"feishu_office",result:{needsAuthorization:false}})).toBe(false);
    expect(needsFeishuAuthorization({tool:"another_service",error:"需要重新授权"})).toBe(false);
    expect(needsFeishuAuthorization({tool:"exec",command:"feishu_office 需要重新授权",aggregatedOutput:"feishu_office 需要重新授权"})).toBe(false);
    expect(needsFeishuAuthorization({tool:"feishu_office",input:{summary:"需要重新授权"}})).toBe(false);
    expect(needsFeishuAuthorization({tool:"feishu_office",error:"应用尚未启用机器人，个人重新授权不会自动开启机器人"})).toBe(false);
  });
});
