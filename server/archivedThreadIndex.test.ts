import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {it,expect} from "vitest";
import {readArchivedThreadIndex} from "./archivedThreadIndex.js";

it("reads archived owned metadata only, without opening rollout files",async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"archived-index-"));
  const db=new DatabaseSync(path.join(home,"state_5.sqlite"));
  db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, archived INTEGER,title TEXT,updated_at INTEGER,rollout_path TEXT)");
  const insert=db.prepare("INSERT INTO threads VALUES(?,?,?,?,?)");
  insert.run("owned",1,"历史名称",100,"/not/readable/huge.jsonl");
  insert.run("foreign",1,"别人的会话",200,"/not/readable/other.jsonl");
  insert.run("active",0,"未归档",300,"/not/readable/active.jsonl");db.close();
  try{
    const result=await readArchivedThreadIndex([home],new Set(["owned","active"]));
    expect(result).toMatchObject({available:true,incomplete:false,data:[{id:"owned",name:"历史名称",updatedAt:100}]});
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
