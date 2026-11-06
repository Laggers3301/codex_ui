import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {describe,it,expect} from "vitest";
import {ClaudeBindings,claudeModelEntries} from "./claudeBindings.js";

describe("native Claude model catalogue",()=>{
  it("redirects legacy organization model ids for all shared users and rejects invalid mappings",()=>{
    const home=fs.mkdtempSync(path.join(os.tmpdir(),"claude-org-switch-"));
    try{
      const users=path.join(home,"users");for(const user of ["alice","bob"])fs.mkdirSync(path.join(users,user),{recursive:true});
      const root=path.join(home,".rec/claude/accounts/22/config");fs.mkdirSync(root,{recursive:true});
      fs.writeFileSync(path.join(path.dirname(root),"device.json"),JSON.stringify({sk:"fixture",org_id:2}));
      fs.writeFileSync(path.join(root,".claude.json"),JSON.stringify({oauthAccount:{accountUuid:"new-shared-account"}}));
      const bindings=new ClaudeBindings({home,executable:"/bin/true",storageDirectory:path.join(home,"state"),sharedUsers:{workspaceDirectory:users,orgIds:["1","2"]},organizationRedirects:{"1":"2"}});
      for(const user of ["alice","bob"]){
        expect(bindings.effectiveModel(user,"reclaude-sonnet@1")).toBe("reclaude-sonnet@2");
        expect(bindings.resolve(user,"reclaude-sonnet@1")).toMatchObject({orgId:"2",userId:user,workspaceRoot:path.join(users,user)});
        expect(bindings.profiles(user).every(profile=>profile.model.endsWith("@2"))).toBe(true);
      }
      bindings.config.organizationRedirects={"1":"3"};expect(()=>bindings.resolve("alice","reclaude-sonnet@1")).toThrow(/目标组织/);
      bindings.config.organizationRedirects={"1":"2","2":"1"};expect(()=>bindings.resolve("alice","reclaude-sonnet@1")).toThrow(/映射无效/);
      expect(()=>bindings.resolve("missing","reclaude-sonnet@1")).toThrow();
    }finally{fs.rmSync(home,{recursive:true,force:true});}
  });
  it("bootstraps native identity in a new device root using auth status before resolving a model",async()=>{
    const home=fs.mkdtempSync(path.join(os.tmpdir(),"claude-new-device-"));
    try {
      const workspace=path.join(home,"users","alice"),root=path.join(home,".rec/claude/accounts/42/config");
      fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(root,{recursive:true});
      fs.writeFileSync(path.join(path.dirname(root),"device.json"),JSON.stringify({sk:"fixture",org_id:1}));
      const wrapper=path.join(home,"auth-wrapper");
      fs.writeFileSync(wrapper,`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['auth','status']))process.exit(1);const root=path.join(process.env.HOME,'.rec/claude/accounts/42/config');fs.writeFileSync(path.join(root,'.claude.json'),JSON.stringify({oauthAccount:{accountUuid:'fresh-account'}}));console.log(JSON.stringify({loggedIn:true,configDirectory:root}));\n`,{mode:0o700});
      const bindings=new ClaudeBindings({home,executable:wrapper,storageDirectory:path.join(home,"state"),sharedUsers:{workspaceDirectory:path.join(home,"users"),orgIds:["1"]}});
      expect(bindings.list("alice")).toEqual([]);
      expect(await bindings.refreshOrganization("alice","1")).toMatchObject({userId:"alice",orgId:"1",configRoot:root});
      expect(bindings.profiles("alice")).toHaveLength(3);
      await expect(bindings.refreshOrganization("alice","2")).rejects.toMatchObject({code:"runtime_forbidden"});
    }finally{fs.rmSync(home,{recursive:true,force:true});}
  });
  it("shares an admin-authorized binding with separate existing user workspaces only",()=>{
    const home=fs.mkdtempSync(path.join(os.tmpdir(),"claude-shared-"));
    try {
      const users=path.join(home,"users");
      for(const name of ["alice","bob"])fs.mkdirSync(path.join(users,name),{recursive:true});
      fs.symlinkSync(path.join(users,"alice"),path.join(users,"alias"));
      const base=path.join(home,".rec/claude/accounts/11");fs.mkdirSync(path.join(base,"config"),{recursive:true});
      fs.writeFileSync(path.join(base,"device.json"),JSON.stringify({sk:"fixture",org_id:1}));
      fs.writeFileSync(path.join(base,"config/.claude.json"),JSON.stringify({oauthAccount:{accountUuid:"fixture-account"}}));
      const bindings=new ClaudeBindings({home,storageDirectory:path.join(home,"state"),executable:"/bin/true",users:{},sharedUsers:{workspaceDirectory:users,orgIds:["1"]}});
      expect(bindings.list("alice")[0].workspaceRoot).toBe(path.join(users,"alice"));
      expect(bindings.list("bob")[0].workspaceRoot).toBe(path.join(users,"bob"));
      expect(bindings.list("alice")[0].accountKey).toBe(bindings.list("bob")[0].accountKey);
      for(const name of ["missing","alias","../alice","alice/../bob"])expect(bindings.list(name)).toEqual([]);
      bindings.config.sharedUsers!.orgIds=["2"];
      expect(bindings.list("alice")).toEqual([]);
    } finally {fs.rmSync(home,{recursive:true,force:true});}
  });
  it("uses the client's versioned ids for execution and keeps legacy family selections working",()=>{
    const home=fs.mkdtempSync(path.join(os.tmpdir(),"claude-models-"));
    try{
      const base=path.join(home,".rec/claude/accounts/11");fs.mkdirSync(path.join(base,"config"),{recursive:true});
      fs.writeFileSync(path.join(base,"device.json"),JSON.stringify({sk:"fixture",org_id:1,org_name:"fixture"}));
      fs.writeFileSync(path.join(base,"config/.claude.json"),JSON.stringify({oauthAccount:{accountUuid:"fixture-account"}}));
      const key=createHash("sha256").update("fixture-account").digest("hex"),state=path.join(home,"state");fs.mkdirSync(path.join(state,"model-catalog"),{recursive:true});
      const rows=[{value:"default",resolvedModel:"claude-opus-5-5",displayName:"Default"},
        {value:"opus",resolvedModel:"claude-opus-5-5",displayName:"Opus 5.5"},
        {value:"claude-opus-5-5",resolvedModel:"claude-opus-5-5",displayName:"Opus 5.5"},
        {value:"claude-opus-4-6",resolvedModel:"claude-opus-4-6",displayName:"Opus 4.6"}];
      expect(claudeModelEntries(rows)).toHaveLength(2);
      fs.writeFileSync(path.join(state,`model-catalog/${key}.json`),JSON.stringify(rows));
      const bindings=new ClaudeBindings({home,storageDirectory:state,executable:"/bin/true",users:{alice:{workspaceRoot:home,orgIds:["1"]}}});
      expect(bindings.profiles("alice").map(profile=>profile.displayName)).toEqual(["Claude Opus 5.5 · fixture","Claude Opus 4.6 · fixture"]);
      expect(bindings.resolve("alice","reclaude-opus@1").verifiedModels["reclaude-opus@1"]).toBe("claude-opus-5-5");
      expect(bindings.resolve("alice","reclaude-opus-4-6@1").verifiedModels["reclaude-opus-4-6@1"]).toBe("claude-opus-4-6");
      expect(()=>bindings.resolve("alice","reclaude-opus-99@1")).toThrow(/版本/);
      expect(bindings.profiles("bob")).toEqual([]);
      rows[1]=Object.assign(rows[1],{supportsEffort:true,supportedEffortLevels:["low","medium","high","max","invalid"]});
      fs.writeFileSync(path.join(state,`model-catalog/${key}.json`),JSON.stringify(rows));
      expect(bindings.profiles("alice").filter(p=>p.model==="reclaude-opus@1").map(p=>p.effort)).toEqual(["low","medium","high","max"]);
      expect(bindings.effort("alice","reclaude-opus@1","max")).toBe("max");
      expect(()=>bindings.effort("alice","reclaude-opus@1","xhigh")).toThrow(/不支持/);
      expect(bindings.effort("alice","reclaude-opus-4-6@1","medium")).toBeUndefined();
    }finally{fs.rmSync(home,{recursive:true,force:true});}
  });
});
