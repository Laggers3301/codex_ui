/** Native child narration belongs in the agent detail, not the parent answer. */
export function isClaudeSubagentText(item:Record<string,any>):boolean{
  return ['agentMessage','reasoning'].includes(String(item.type))&&String(item.id??'').startsWith('claude-message:')&&
    (!!item.parentToolUseId||/^claude-message:[^:]+:/.test(String(item.id)));
}
/** View-only repair; original records remain available in agent details. */
export function claudeVisibleItems<T extends Record<string,any>>(items:T[],options:{includeSubagents?:boolean}={}):T[]{
  const seen=new Set<string>(),tools=new Map<string,number>(),result:T[]=[];
  for(const item of items){
    if(!options.includeSubagents&&isClaudeSubagentText(item))continue;
    const id=String(item.id??'');if(!id.startsWith('claude-')){result.push(item);continue;}
    if(item.type==='reasoning'){
      const text=Array.isArray(item.summary)?item.summary.join('\n'):String(item.text??'');
      if(!text.trim())continue;
      const message=id.match(/^(claude-message:.*):[^:]+$/)?.[1];
      if(message){const key=message+'\n'+text;if(seen.has(key))continue;seen.add(key);}
    }else if(item.type==='dynamicToolCall'){
      const index=tools.get(id);
      if(index!==undefined){result[index]={...result[index],...item};continue;}
      tools.set(id,result.length);
    }
    result.push(item);
  }
  return result;
}
