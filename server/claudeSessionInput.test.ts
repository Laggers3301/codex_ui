import {it,expect} from 'vitest';
import {ClaudeSessionInput,ClaudeTaskLedger} from './claudeSessionInput.js';
it('keeps the native input stream open and delivers a non-interrupting steer with its UUID before closing',async()=>{
  const input=new ClaudeSessionInput(),iterator=input[Symbol.asyncIterator]();
  input.push({type:'user',message:{role:'user',content:'first'},parent_tool_use_id:null,session_id:''});
  expect((await iterator.next()).value?.message.content).toBe('first');
  const next=iterator.next();input.steer([{type:'text',text:'steer'}],'steer-id');
  const delivered=(await next).value;expect(delivered?.priority).toBe('next');expect(delivered?.uuid).toBe('steer-id');expect(delivered?.message.content).toEqual([{type:'text',text:'steer'}]);const done=iterator.next();input.close();expect((await done).done).toBe(true);
  expect(()=>input.push({type:'user',message:{role:'user',content:'late'},parent_tool_use_id:null,session_id:''})).toThrow();
});
it('tracks authoritative async Agent receipts and terminal notifications without reading encoded tool text',()=>{
  const ledger=new ClaudeTaskLedger();ledger.update({type:'user',tool_use_result:{isAsync:true,status:'async_launched',agentId:'agent1',description:'研究'},message:{content:[{type:'tool_result',tool_use_id:'call1'}]}});
  expect(ledger.pending).toMatchObject([{id:'agent1',kind:'agent',toolUseId:'call1'}]);
  ledger.update({type:'system',subtype:'task_notification',task_id:'agent1',status:'completed'});expect(ledger.pending).toHaveLength(0);
});
it('excludes foreground and ambient tasks and ignores late notifications from an older run',()=>{
  const ledger=new ClaudeTaskLedger();ledger.update({type:'system',subtype:'task_started',task_id:'foreground',is_backgrounded:false});
  ledger.update({type:'system',subtype:'task_started',task_id:'watcher',ambient:true});expect(ledger.pending).toHaveLength(0);
  ledger.update({type:'system',subtype:'task_updated',task_id:'foreground',run_id:'002',patch:{is_backgrounded:true}});
  ledger.update({type:'system',subtype:'task_notification',task_id:'foreground',run_id:'001',status:'stopped'});expect(ledger.pending).toHaveLength(1);
  ledger.stop();expect(ledger.snapshot()[0].status).toBe('interrupted');
});
it('accepts a completed structured Agent result and does not report an absent task as still running',()=>{
  const ledger=new ClaudeTaskLedger();ledger.update({type:'system',subtype:'task_started',task_id:'a',is_backgrounded:true});
  ledger.update({type:'system',subtype:'background_tasks_changed',tasks:[]});expect(ledger.pending).toHaveLength(0);expect(ledger.snapshot()[0].status).toBe('unknown');
  ledger.update({type:'user',tool_use_result:{agentId:'a',status:'completed'}});expect(ledger.snapshot()[0].status).toBe('completed');
});
