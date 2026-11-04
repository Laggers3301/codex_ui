import { describe, expect, it } from "vitest";
import { toolPresentation } from "./toolPresentation";

describe("tool presentation", () => {
  it("prefers an explicit description without modifying input", () => {
    const input = JSON.stringify({ cmd: "rg example", description: "查找配置" });
    expect(toolPresentation({ id: "1", type: "toolCall", tool: "exec", input })).toEqual({ description: "查找配置", icon: "terminal" });
    expect(JSON.parse(input).cmd).toBe("rg example");
  });
  it("labels known tools and does not invent command intent", () => {
    expect(toolPresentation({ id: "2", type: "toolCall", tool: "web_search" })).toEqual({ description: "联网查询", icon: "web" });
    expect(toolPresentation({ id: "3", type: "toolCall", tool: "exec", input: "rm file" })).toEqual({ description: undefined, icon: "terminal" });
    expect(toolPresentation({ id: "4", type: "toolCall", tool: "apply_patch" })).toEqual({ description: "文件变更", icon: "file" });
  });
  it("shows query and changed filename only when present in tool input", () => {
    expect(toolPresentation({ id: "5", type: "toolCall", tool: "web_search", input: { search_query: [{ q: "Codex app 更新" }] } }).description).toBe("搜索：Codex app 更新");
    expect(toolPresentation({ id: "6", type: "toolCall", tool: "apply_patch", input: "*** Begin Patch\n*** Update File: src/app.ts\n+x\n*** End Patch" }).description).toBe("修改 app.ts");
  });
  it('includes the concrete file and search term in shell summaries',()=>{
    expect(toolPresentation({id:'7',type:'toolCall',tool:'exec',input:`/bin/bash -lc "sed -n '1,20p' backend/server/auth.ts; rg example"`}).description).toBe('读取 auth.ts 等操作');
    expect(toolPresentation({id:'8',type:'toolCall',tool:'exec',input:`rg -n 'readHostResources' frontend/src/api.ts`}).description).toBe('搜索：readHostResources');
  });
  it('names the actual script instead of a generic isolated-task label',()=>{
    expect(toolPresentation({id:'9',type:'toolCall',tool:'exec',input:'systemd-run --user --scope node scripts/build.mjs'}).description).toBe('运行 build.mjs');
    expect(toolPresentation({id:'10',type:'toolCall',tool:'exec',input:'systemd-run --user --scope unknown-command'}).description).toBeUndefined();
  });
});
