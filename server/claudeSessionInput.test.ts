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
it('retains bounded progress and a final summary without stale frames reviving a task',()=>{
  const ledger=new ClaudeTaskLedger();
  ledger.update({type:'system',subtype:'task_started',task_id:'shell',run_id:'002',task_type:'local_bash',description:'运行测试',parent_task_id:'agent',is_backgrounded:true});
  ledger.update({type:'system',subtype:'task_progress',task_id:'shell',run_id:'002',description:'运行测试',last_tool_name:'Bash',summary:'正在测试',usage:{total_tokens:120,tool_uses:2,duration_ms:2000}});
  expect(ledger.snapshot()[0]).toMatchObject({kind:'shell',parentTaskId:'agent',summary:'正在测试',lastToolName:'Bash',usage:{totalTokens:120,toolUses:2,durationMs:2000}});
  ledger.update({type:'system',subtype:'task_notification',task_id:'shell',run_id:'002',status:'completed',summary:'全部通过'});
  ledger.update({type:'system',subtype:'task_progress',task_id:'shell',run_id:'002',summary:'晚到的进度'});
  ledger.update({type:'system',subtype:'task_notification',task_id:'shell',run_id:'001',status:'failed',summary:'旧运行失败'});
  expect(ledger.snapshot()[0]).toMatchObject({status:'completed',summary:'全部通过'});
  ledger.update({type:'system',subtype:'task_started',task_id:'shell',run_id:'003',task_type:'local_bash',description:'重新测试',is_backgrounded:true});
  expect(ledger.snapshot()[0]).toMatchObject({status:'running',runId:'003',description:'重新测试'});
  expect(ledger.snapshot()[0].summary).toBeUndefined();
});
it('does not turn ambient progress into a user task and retains the identity of ended background work',()=>{
  const ledger=new ClaudeTaskLedger();
  ledger.update({type:'system',subtype:'task_started',task_id:'watcher',ambient:true});
  ledger.update({type:'system',subtype:'task_progress',task_id:'watcher',summary:'不可展示'});
  expect(ledger.snapshot()).toEqual([]);
  ledger.update({type:'system',subtype:'task_started',task_id:'shell',task_type:'local_bash',is_backgrounded:true});
  ledger.update({type:'system',subtype:'background_tasks_changed',tasks:[]});
  expect(ledger.snapshot()[0]).toMatchObject({background:false,wasBackground:true,status:'unknown'});
  ledger.update({type:'system',subtype:'task_notification',task_id:'shell',status:'completed',summary:'x'.repeat(5000)});
  expect(ledger.snapshot()[0].summary).toHaveLength(4096);
});
