import {expect,it} from 'vitest';
import {presentClaudeCommandReceipt} from './claudeCommandReceipt';
import {toolDisplayName} from './toolPresentation';
it('collapses native goal acknowledgements while preserving identity, chronology and original output',()=>{
 const original={id:'claude-message::11111111-1111-4111-8111-111111111111:0',type:'agentMessage',text:'Goal set: '+ '长任务目标。'.repeat(1000),timelineAt:'2026-11-07T00:00:00Z'};
 const display=presentClaudeCommandReceipt(original);
 expect(display).toMatchObject({id:original.id,type:'dynamicToolCall',tool:'claude_goal_set',status:'completed',output:original.text,timelineAt:original.timelineAt});
 expect(display.text).toBeUndefined();expect(original.type).toBe('agentMessage');expect(original.text.startsWith('Goal set:')).toBe(true);
 expect(toolDisplayName(display)).toBe('设置持续目标');expect(presentClaudeCommandReceipt(display)).toBe(display);
});
it('does not hide user messages, normal model explanations or other local command results',()=>{
 for(const item of [
  {id:'user',type:'userMessage',text:'Goal set: explain this'},
  {id:'claude-message::msg_model:0',type:'agentMessage',text:'Goal set: explain this'},
  {id:'claude-message::11111111-1111-4111-8111-111111111111:0',type:'agentMessage',text:'ordinary local response'},
 ])expect(presentClaudeCommandReceipt(item)).toBe(item);
});
