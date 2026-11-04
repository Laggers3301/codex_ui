import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe,it,expect} from 'vitest';
import {historyOffsetAt,freezeInheritedSubagents} from './subagentInheritance.js';
import {ProjectStore} from './db.js';
import {readSubagentDirectoryPage} from './subagentHistory.js';
describe('branch subagent inheritance',()=>{
  it('freezes byte boundaries, excludes later children, and isolates branch owners',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'subagent-inherit-'));
    try {
      const file=path.join(root,'child.jsonl');
      const lines=[JSON.stringify({timestamp:'2026-10-01T00:00:00Z',payload:{id:'child'}})+'\n',JSON.stringify({timestamp:'2026-10-01T01:00:00Z',payload:{output:'x'.repeat(700000)}})+'\n',JSON.stringify({timestamp:'2026-10-02T00:00:00Z',payload:{text:'later'}})+'\n'];
      await fs.writeFile(file,lines.join(''));
      const cutoff=Date.parse('2026-10-01T02:00:00Z'),end=Buffer.byteLength(lines.slice(0,2).join(''));
      expect(await historyOffsetAt(file,cutoff)).toBe(end);
      const row={id:'child',name:'/root/worker',parentThreadId:'source',runtimeHome:root,createdAt:'2026-10-01T00:00:00Z',updatedAt:null};
      const inherited=await freezeInheritedSubagents([row,{...row,id:'later',createdAt:'2026-10-02T00:00:00Z'}],'source',cutoff,async()=>file);
      expect(inherited).toHaveLength(1);expect(inherited[0]).toMatchObject({inherited:true,inheritedFromThreadId:'source',maxEndOffset:end});
      await fs.appendFile(file,JSON.stringify({timestamp:'2026-10-03T00:00:00Z',payload:{text:'new turn'}})+'\n');
      expect(await historyOffsetAt(file,Date.parse('2026-10-04'),inherited[0].maxEndOffset)).toBe(end);
      expect(await fs.readFile(file,'utf8')).toContain('later');
      const store=new ProjectStore(path.join(root,'web.sqlite'));
      try{store.setInheritedSubagents('branch','alice',inherited);expect(store.getInheritedSubagents('branch','bob')).toEqual([]);expect(store.getInheritedSubagents('branch','alice')).toEqual(inherited);}finally{store.close();}
      const page=await readSubagentDirectoryPage('branch',[],{inherited,view:'history'});
      expect(page.data).toHaveLength(1);expect(page.page.activeCount).toBe(0);expect(page.page.unknownCount).toBe(0);
      expect((await readSubagentDirectoryPage('branch',[],{inherited,view:'active'})).data).toEqual([]);
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });
});
