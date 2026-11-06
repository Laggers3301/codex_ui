import { DatabaseSync } from "node:sqlite";
import { expect,it } from "vitest";
import { HistoryWriteBatch } from "./historyWriteBatch.js";

it("commits bounded row and byte batches and leaves no open transaction",()=>{
  const db=new DatabaseSync(":memory:");db.exec("CREATE TABLE t(n INTEGER)");
  try {
    const insert=db.prepare("INSERT INTO t VALUES(?)"),batch=new HistoryWriteBatch<number>(db,n=>insert.run(n));
    for(let i=0;i<127;i++)expect(batch.add(i,1)).toBe(0);
    expect(batch.add(127,1)).toBe(128);expect(db.isTransaction).toBe(false);
    expect(batch.add(128,1024*1024)).toBe(1);expect(db.isTransaction).toBe(false);
    expect(batch.add(129,1)).toBe(0);expect(batch.flush()).toBe(1);expect(batch.flush()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()?.n).toBe(130);
  }finally{db.close();}
});
it("rolls back an interrupted batch without undoing a previous committed batch",()=>{
  const db=new DatabaseSync(":memory:");db.exec("CREATE TABLE t(n INTEGER UNIQUE)");
  try {
    const insert=db.prepare("INSERT INTO t VALUES(?)"),batch=new HistoryWriteBatch<number>(db,n=>insert.run(n));
    batch.add(1,1);batch.flush();batch.add(2,1);batch.add(1,1);
    expect(()=>batch.flush()).toThrow();expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT n FROM t ORDER BY n").all()).toEqual([{n:1}]);
  }finally{db.close();}
});
