import type {ThreadItem} from './types';

/** Display local CLI acknowledgements as collapsed activity, never as prose.
 * UUID message IDs distinguish synthetic CLI output from normal msg_* replies.
 * The original item and persistent history are untouched.
 */
export function presentClaudeCommandReceipt(item:ThreadItem):ThreadItem{
  if(item.type!=='agentMessage'||typeof item.text!=='string'||
    !/^claude-message:[^:]*:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/i.test(item.id)||
    !/^Goal set:\s*\S/.test(item.text))return item;
  const {text,...rest}=item;
  return {...rest,type:'dynamicToolCall',tool:'claude_goal_set',output:text,status:'completed',claudeCommandReceipt:true};
}
