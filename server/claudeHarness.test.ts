import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {it,expect} from 'vitest';
import {claudeWebMcp,claudeSkills,claudeInput,claudeOfficeText} from './claudeHarness.js';
import {execFileSync} from 'node:child_process';
import {claudeVisibleItems} from './claudeStreamAdapter.js';
it('keeps child narration in agent details, repairs old parent-less snapshots without translating main English',()=>{
 const child={id:'claude-message:toolu_parent:msg1:0',type:'agentMessage',text:'The Newton runs are coming through normally.'};
 const main={id:'claude-message::msg2:0',type:'agentMessage',text:'English explicitly requested by user.'};
 const think={id:'claude-message:toolu_parent:msg3:0',type:'reasoning',summary:['child reasoning']};
 const original=[child,main,think];expect(claudeVisibleItems(original)).toEqual([main]);
 expect(claudeVisibleItems(original,{includeSubagents:true})).toEqual(original);expect(original).toHaveLength(3);
});
it('translates only scoped loopback services to native SDK MCP without exposing unrelated config',()=>{
  const config={'mcp_servers.codex_browser':{url:'http://127.0.0.1:4576/api/browser/mcp',http_headers:{'x-codex-browser-token':'fixture'}},'mcp_servers.foreign':{url:'https://example.com'}};
  expect(claudeWebMcp(config)).toEqual({codex_browser:{type:'http',url:'http://127.0.0.1:4576/api/browser/mcp',headers:{'x-codex-browser-token':'fixture'}}});
  expect(()=>claudeWebMcp({'mcp_servers.codex_browser':{url:'https://example.com/api/browser/mcp'}})).toThrow('Invalid');
});
it('discovers nested native skills, passes selected references, accepts owned images and refuses foreign paths',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-harness-')),outside=fs.mkdtempSync(path.join(os.tmpdir(),'claude-other-'));
  try{
    const skill=path.join(root,'skills/synced/pdf');fs.mkdirSync(skill,{recursive:true});fs.writeFileSync(path.join(skill,'SKILL.md'),'---\nname: pdf\ndescription: PDF skill\n---\nRead on demand.');
    expect(claudeSkills([path.join(root,'skills')])).toMatchObject([{name:'pdf',enabled:true}]);
    const file=path.join(root,'test.png');fs.writeFileSync(file,Buffer.from('png-fixture'));
    const input=claudeInput([{type:'text',text:'读图'},{type:'skill',name:'pdf',path:path.join(skill,'SKILL.md')},{type:'localImage',path:file}],'alice',root);
    expect(input.prompt).toContain('SKILL.md');expect(input.content?.[1]).toMatchObject({type:'image',source:{media_type:'image/png',data:Buffer.from('png-fixture').toString('base64')}});
    const foreign=path.join(outside,'foreign.png');fs.writeFileSync(foreign,'x');fs.symlinkSync(foreign,path.join(root,'escape.png'));
    expect(()=>claudeInput([{type:'localImage',path:foreign}],'alice',root)).toThrow('当前用户');
    expect(()=>claudeInput([{type:'localImage',path:path.join(root,'escape.png')}],'alice',root)).toThrow('当前用户');
    expect(()=>claudeInput(Array(9).fill({type:'localImage',path:file}),'alice',root)).toThrow('8个');
  }finally{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});}
});
it('repairs only duplicate same-message reasoning in history presentation and preserves distinct calls and original data',()=>{
  const original=[{id:'claude-message::msg1:0',type:'reasoning',summary:['相同思考']},{id:'claude-message::msg1:1',type:'reasoning',summary:['相同思考']},{id:'claude-message::msg2:0',type:'reasoning',summary:['相同思考']},...['a','b'].map(id=>({id:'claude-tool::'+id,type:'dynamicToolCall',tool:'Bash',arguments:{command:'pwd'}}))];
  expect(claudeVisibleItems(original)).toHaveLength(4);expect(original).toHaveLength(5);
  const snapshots=[{id:'claude-tool::one',type:'dynamicToolCall',status:'inProgress',arguments:{command:'pwd'}},{id:'claude-tool::one',type:'dynamicToolCall',status:'completed',output:'done'}];
  expect(claudeVisibleItems(snapshots)).toEqual([{...snapshots[0],...snapshots[1]}]);
  expect(snapshots[0].status).toBe('inProgress');
});
it('reads DOCX text without pandoc and does not modify the file',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-office-'));
  try{
    const file=path.join(root,'fixture.docx');
    execFileSync('/usr/bin/python3',['-c',"import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('word/document.xml','<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>Hello 文档</w:t></w:r></w:p></w:body></w:document>')",file]);
    const before=fs.readFileSync(file),result=await claudeOfficeText(file,'alice',root);
    expect(result.text).toBe('Hello 文档');expect(result.nextOffset).toBeNull();expect(fs.readFileSync(file)).toEqual(before);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
