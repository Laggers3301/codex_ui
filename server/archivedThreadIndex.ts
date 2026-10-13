import fs from "node:fs/promises";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

/** Read only indexed metadata for owned IDs; never repair or parse rollouts. */
export async function readArchivedThreadIndex(homes: string[], owned: Set<string>) {
  if (!owned.size) return {available:true,incomplete:false,data:[]};
  const rows = new Map<string, Record<string, unknown>>();
  let available = false;
  let incomplete = false;
  for (const home of new Set(homes)) {
    let db: DatabaseSync | null = null;
    try {
      const names = (await fs.readdir(home)).filter(name => /^state_\d+\.sqlite$/.test(name))
        .sort((a,b) => Number(b.match(/\d+/)![0])-Number(a.match(/\d+/)![0]));
      if (!names.length) continue;
      db = new DatabaseSync(path.join(home,names[0]),{readOnly:true});
      db.exec("PRAGMA busy_timeout=100");
      const columns = new Set((db.prepare("PRAGMA table_info(threads)").all() as {name:string}[]).map(row=>row.name));
      if (!columns.has("id") || !columns.has("archived")) { incomplete=true; continue; }
      const fields=["id","archived","title","name","preview","cwd","created_at","updated_at","created_at_ms","updated_at_ms"].filter(field=>columns.has(field));
      const query=db.prepare(`SELECT ${fields.map(field=>`"${field}"`).join(",")} FROM threads WHERE id = ?`);
      for (const id of owned) {
        const row=query.get(id) as Record<string,unknown>|undefined;
        if (!row) continue;
        const previous=rows.get(id);
        const time=(value:Record<string,unknown>)=>Number(value.updated_at_ms??Number(value.updated_at??0)*1000);
        if (!previous || time(row)>time(previous)) rows.set(id,row);
      }
      available=true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code!=="ENOENT") incomplete=true;
    } finally { db?.close(); }
  }
  const data=[...rows.values()].filter(row=>Number(row.archived)===1).map(row=>({
    id:String(row.id),name:String(row.name||row.title||""),preview:String(row.preview||""),cwd:String(row.cwd||""),
    createdAt:Number(row.created_at_ms??Number(row.created_at??0)*1000)/1000,
    updatedAt:Number(row.updated_at_ms??Number(row.updated_at??0)*1000)/1000
  }));
  return {available,incomplete,data};
}
