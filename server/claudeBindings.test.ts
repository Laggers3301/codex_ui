import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {describe,it,expect} from "vitest";
import {ClaudeBindings,claudeModelEntries} from "./claudeBindings.js";

describe("native Claude model catalogue",()=>{
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
    }finally{fs.rmSync(home,{recursive:true,force:true});}
  });
});
