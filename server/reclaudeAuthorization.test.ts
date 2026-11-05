import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeBindings, type ClaudeIntegrationConfig } from "./claudeBindings.js";
import { ReclaudeLifecycle } from "./reclaudeLifecycle.js";
import { ReclaudeAuthorization } from "./reclaudeAuthorization.js";

const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup();vi.restoreAllMocks();});
function fixture() {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"reclaude-auth-test-"));
  cleanups.push(()=>fs.rmSync(home,{recursive:true,force:true}));
  for(const user of ["admin","bob"])fs.mkdirSync(path.join(home,"users",user),{recursive:true});
  const client=path.join(home,"fake-reclaude");
  fs.writeFileSync(client,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),home=process.env.HOME,args=process.argv.slice(2);
fs.appendFileSync(path.join(home,'calls'),JSON.stringify(args)+'\\n');
if(args[0]==='logout'){fs.rmSync(path.join(home,'.rec/claude/accounts/11/device.json'),{force:true});process.exit(0);}
console.log('secret-fixture-never-expose');console.log('https://reclaude.ai/cli/auth?state=manager-fixture');
const timer=setInterval(()=>{if(!fs.existsSync(path.join(home,'approve')))return;
const root=path.join(home,'.rec/claude/accounts/22');fs.mkdirSync(path.join(root,'config'),{recursive:true});
fs.writeFileSync(path.join(root,'device.json'),JSON.stringify({sk:'fixture-only',org_id:1,org_name:'shared-name'}));
fs.writeFileSync(path.join(root,'config/.claude.json'),JSON.stringify({oauthAccount:{accountUuid:'new-account'}}));
clearInterval(timer);process.exit(0);},20);
`,{mode:0o700});
  const base=path.join(home,".rec/claude/accounts/11");fs.mkdirSync(path.join(base,"config"),{recursive:true});
  fs.writeFileSync(path.join(base,"device.json"),JSON.stringify({sk:"fixture-only",org_id:1,org_name:"shared-name"}));
  fs.writeFileSync(path.join(base,"config/.claude.json"),JSON.stringify({oauthAccount:{accountUuid:"old-account"}}));
  const config:ClaudeIntegrationConfig={home,executable:"/bin/true",reclaudeExecutable:client,storageDirectory:path.join(home,"state"),sharedUsers:{workspaceDirectory:path.join(home,"users"),orgIds:["1"]}};
  fs.mkdirSync(config.storageDirectory);
  const bindings=new ClaudeBindings(config);
  vi.spyOn(bindings,"refreshOrganization").mockImplementation(async(user,org)=>bindings.list(user).find(binding=>binding.orgId===org)!);
  vi.spyOn(bindings,"refreshModels").mockResolvedValue(undefined);
  const lifecycle=new ReclaudeLifecycle(home),snapshot=vi.fn();
  const manager=new ReclaudeAuthorization(config,bindings,lifecycle,snapshot);
  cleanups.push(()=>manager.close());
  const ready=async()=>vi.waitFor(()=>expect(manager.status("admin").operation?.authorizationUrl).toBeTruthy());
  return{home,config,bindings,lifecycle,snapshot,manager,ready};
}
describe("shared ReClaude browser authorization",()=>{
  it("runs one scoped operation, restricts the approval URL to its initiator, and verifies the new binding",async()=>{
    const f=fixture(),id=randomUUID(),old=f.bindings.list("admin")[0].accountKey;
    f.manager.start("admin","1",id);await f.ready();
    expect(f.snapshot).toHaveBeenCalledWith("1");
    expect(f.manager.start("admin","1",id).operation?.id).toBe(id);
    expect(f.manager.start("admin","1",randomUUID()).operation?.id).toBe(id);
    expect(f.manager.status("bob").operation).toMatchObject({owned:false,phase:"waiting_authorization"});
    expect(f.manager.status("bob").operation?.authorizationUrl).toBeUndefined();
    expect(()=>f.manager.cancel("bob",id)).toThrow("不属于当前用户");
    expect(()=>f.manager.start("bob","1",randomUUID())).toThrow("认证正在进行");
    expect(()=>f.lifecycle.acquireRun()).toThrow("正在重新认证");
    fs.writeFileSync(path.join(f.home,"approve"),"1");
    await vi.waitFor(()=>expect(f.manager.status("admin").operation?.phase).toBe("completed"));
    expect(f.bindings.list("admin")[0].accountKey).not.toBe(old);
    expect(f.manager.status("admin").operation?.authorizationUrl).toBeUndefined();
    expect(JSON.stringify(f.manager.status("admin"))).not.toContain("secret-fixture");
    expect(fs.readFileSync(path.join(f.config.storageDirectory,"authorization.json"),"utf8")).not.toContain("manager-fixture");
    const calls=fs.readFileSync(path.join(f.home,"calls"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(calls).toEqual([["logout","--org","1"],["login","--org","1"]]);
    f.lifecycle.acquireRun()();
  });
  it("refuses logout while a cooperating backend has a live Claude operation",()=>{
    const f=fixture(),release=f.lifecycle.acquireRun();
    expect(()=>f.manager.start("admin","1",randomUUID())).toThrow("正在执行");
    expect(f.snapshot).not.toHaveBeenCalled();expect(fs.existsSync(path.join(f.home,"calls"))).toBe(false);release();
  });
  it("keeps the login lease until cancellation reaps the client process group",async()=>{
    const f=fixture(),id=randomUUID();f.manager.start("admin","1",id);await f.ready();
    f.manager.cancel("admin",id);
    await vi.waitFor(()=>expect(f.manager.status("admin").operation?.phase).toBe("cancelled"));
    expect(f.manager.status("admin").operation?.authorizationUrl).toBeUndefined();f.lifecycle.acquireRun()();
  });
  it("does not log out when preserving original history fails",()=>{
    const f=fixture();f.snapshot.mockImplementation(()=>{throw new Error("history snapshot failed");});
    expect(()=>f.manager.start("admin","1",randomUUID())).toThrow("history snapshot failed");
    expect(fs.existsSync(path.join(f.home,"calls"))).toBe(false);f.lifecycle.acquireRun()();
  });
  it("does not authorize an organization outside the shared pool",()=>{
    const f=fixture();expect(()=>f.manager.start("admin","2",randomUUID())).toThrow("无法重新认证");
    expect(fs.existsSync(path.join(f.home,"calls"))).toBe(false);
  });
});
