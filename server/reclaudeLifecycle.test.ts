import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReclaudeLifecycle } from "./reclaudeLifecycle.js";
import { reclaudeAuthorizationUrl } from "../shared/reclaudeAuthorization.js";
const directories:string[]=[];
afterEach(()=>{for(const root of directories.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),"reclaude-leases-"));directories.push(root);return new ReclaudeLifecycle(root);}
describe("ReClaude login lifecycle",()=>{
  it("coordinates auth and active work across instances",()=>{
    const first=fixture(),second=new ReclaudeLifecycle(path.dirname(path.dirname(first.directory)));
    const run=first.acquireRun();expect(()=>second.acquireAuthorization()).toThrow("正在执行");run();
    const auth=second.acquireAuthorization();expect(()=>first.acquireRun()).toThrow("正在重新认证");expect(()=>first.acquireAuthorization()).toThrow();auth();
    first.acquireRun()();
  });
  it("recovers a dead process lease without clearing a live one",()=>{
    const lease=fixture();fs.writeFileSync(path.join(lease.directory,"authorization.json"),JSON.stringify({pid:1073741823,start:"",nonce:"dead"}));
    const release=lease.acquireAuthorization();expect(()=>lease.acquireRun()).toThrow();release();
    lease.acquireRun()();
  });
  it("does not expose credential-bearing or foreign browser URLs",()=>{
    expect(reclaudeAuthorizationUrl("https://reclaude.ai/cli/auth?state=fixture")).toBeTruthy();
    for(const url of ["https://reclaude.ai:444/cli/auth?state=x","https://reclaude.ai/cli/auth?state=x&device_code=private","http://reclaude.ai/cli/auth?state=x","https://other.test/cli/auth?state=x"])expect(reclaudeAuthorizationUrl(url)).toBeNull();
  });
});
