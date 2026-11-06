import {expect,it} from 'vitest';
import {applyLiveAgentUpdate,keepSnapshotAgent} from './liveAgentUpdates';
const metadata={threadId:'thread',turnId:'turn',startedAt:'start',sequence:1,sourceItemId:'item'};
it('retains completed commentary from an active turn when a tool or reconnect snapshot arrives',()=>{
 const paragraph={...metadata,text:'工具前的解释',completed:true,streamState:'completed' as const};
 expect(keepSnapshotAgent(paragraph,{thread:'turn'})).toBe(true);
 expect(keepSnapshotAgent(paragraph,{thread:'new-turn'})).toBe(false);
 expect(keepSnapshotAgent({...paragraph,streamState:'superseded'},{thread:'turn'})).toBe(false);
});
it('reuses identical wire snapshots so repeated updates do not trigger transcript rendering',()=>{
 const first=applyLiveAgentUpdate(undefined,{...metadata,text:'unchanged'})!;
 expect(applyLiveAgentUpdate(first,{...metadata,text:'unchanged'})).toBe(first);
 expect(applyLiveAgentUpdate(first,{...metadata,text:'changed'})?.text).toBe('changed');
});
it('accepts old-server snapshots and preserves full Markdown boundaries',()=>{
 expect(applyLiveAgentUpdate(undefined,{...metadata,text:'正文\n\n**中文 code**'})).toEqual({...metadata,text:'正文\n\n**中文 code**'});
});
it('appends compact updates exactly once, including whitespace and Unicode',()=>{
 const first=applyLiveAgentUpdate(undefined,{...metadata,delta:'中🙂',textOffset:0})!;
 const final=applyLiveAgentUpdate(first,{...metadata,delta:'\n\n1. item',textOffset:first.text.length})!;
 expect(final.text).toBe('中🙂\n\n1. item');
 expect(applyLiveAgentUpdate(final,{...metadata,delta:'\n\n1. item',textOffset:first.text.length})).toBeNull();
});
it('detects missing bases and accepts an authoritative reconnect snapshot',()=>{
 expect(applyLiveAgentUpdate(undefined,{...metadata,delta:'tail',textOffset:8})).toBeNull();
 const recovered=applyLiveAgentUpdate(undefined,{...metadata,text:'previous'})!;
 expect(applyLiveAgentUpdate(recovered,{...metadata,delta:' tail',textOffset:8})?.text).toBe('previous tail');
});
