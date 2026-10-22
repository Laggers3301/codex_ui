import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it,vi } from "vitest";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { registerRoutes } from "./routes.js";
import {readArchivedThreadIndex} from "./archivedThreadIndex.js";
vi.mock("./archivedThreadIndex.js",()=>({readArchivedThreadIndex:vi.fn().mockResolvedValue({available:false,incomplete:false,data:[]})}));

describe("archive routes", () => {
  it("lists only archived owned threads and routes archive/restore to Codex", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-archive-routes-"));
    const store = new ProjectStore(path.join(temporary, "test.sqlite"));
    const project = store.createProject({ name: "my project", rootPath: temporary });
    store.registerThreadOwner({ threadId: "owned", userId: "admin", projectId: project.id, rootPath: temporary });
    const calls: string[] = [];
    const bridge = { request: async (method: string, params?: { archived?: boolean }) => {
      calls.push(method);
      if (method === "thread/list") return { data: params?.archived
        ? [{ id: "owned", name: "Archived", updatedAt: "2026-09-29T00:00:00Z" }, { id: "foreign", name: "Foreign" }]
        : [{ id: "active", name: "Active" }], nextCursor: null };
      return {};
    } } as unknown as CodexBridge;
    const app = Fastify();
    try {
      registerRoutes(app, bridge, store, { backgroundIndexing: false });
      const listed = await app.inject({ method: "GET", url: `/api/projects/${project.id}/threads?archived=true&fast=false` });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().data.map((thread: { id: string }) => thread.id)).toEqual(["owned"]);
      expect(store.locallyArchivedThreadIds("admin", project.id).has("owned")).toBe(true);
      const archived = await app.inject({ method: "POST", url: `/api/projects/${project.id}/threads/owned/archive` });
      expect(store.locallyArchivedThreadIds("admin", project.id).has("owned")).toBe(true);
      const restored = await app.inject({ method: "POST", url: `/api/projects/${project.id}/threads/owned/unarchive` });
      expect([archived.statusCode, restored.statusCode]).toEqual([200, 200]);
      expect(store.locallyArchivedThreadIds("admin", project.id).has("owned")).toBe(false);
      expect(calls).toContain("thread/archive");
      expect(calls).toContain("thread/unarchive");
      vi.mocked(readArchivedThreadIndex).mockResolvedValueOnce({available:true,incomplete:false,data:[{id:"owned",name:"Indexed",preview:"",cwd:temporary,createdAt:0,updatedAt:Date.now()/1000+1}]});
      calls.length=0;
      const indexed=await app.inject({method:"GET",url:`/api/projects/${project.id}/threads?archived=true`});
      expect(indexed.statusCode).toBe(200);expect(indexed.json().data.map((item:{id:string})=>item.id)).toEqual(["owned"]);
      expect(calls).toEqual([]);
      store.setThreadLocallyArchived("owned","admin",project.id,true);
      const local=await app.inject({method:"GET",url:`/api/projects/${project.id}/threads?archived=true`});
      expect(local.json().data.map((item:{id:string})=>item.id)).toEqual(["owned"]);expect(calls).toEqual([]);
      const denied = await app.inject({ method: "POST", url: `/api/projects/${project.id}/threads/foreign/archive` });
      expect(denied.statusCode).toBe(404);
    } finally { await app.close(); store.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });
});

it('excludes native archives and deleted rows from normal workspace lists without undoing a newer explicit restore',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'archive-visibility-')),store=new ProjectStore(path.join(root,'test.sqlite'));
  const project=store.createProject({name:'project',rootPath:root});
  for(const id of ['active','native-archived','deleted'])store.registerThreadOwner({threadId:id,userId:'admin',projectId:project.id,rootPath:root});
  store.softDeleteThread('deleted','admin',project.id);
  vi.mocked(readArchivedThreadIndex).mockResolvedValue({available:true,incomplete:false,data:[{id:'native-archived',name:'archive',preview:'',cwd:root,createdAt:0,updatedAt:1}]});
  const bridge={request:async(method:string)=>method==='thread/list'?{data:[{id:'active'},{id:'native-archived'},{id:'deleted'}],nextCursor:null}:{}} as unknown as CodexBridge;
  const app=Fastify();registerRoutes(app,bridge,store,{backgroundIndexing:false});
  try{
    for(const fast of [true,false]) {
      const result=await app.inject({method:'GET',url:`/api/projects/${project.id}/threads?fast=${fast}`});
      expect(result.statusCode).toBe(200);expect(result.json().data.map((x:{id:string})=>x.id)).toEqual(['active']);
      expect(result.json().hiddenThreadIds).toEqual(expect.arrayContaining(['deleted','native-archived']));
    }
    const restore=await app.inject({method:'POST',url:`/api/projects/${project.id}/threads/native-archived/unarchive`});expect(restore.statusCode).toBe(200);
    const listed=await app.inject({method:'GET',url:`/api/projects/${project.id}/threads`});
    expect(listed.json().data.map((x:{id:string})=>x.id)).toEqual(expect.arrayContaining(['active','native-archived']));
    expect(listed.json().data.map((x:{id:string})=>x.id)).not.toContain('deleted');
  }finally{await app.close();store.close();fs.rmSync(root,{recursive:true,force:true});}
});
