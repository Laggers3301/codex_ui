import {describe,it,expect,vi} from 'vitest';
import {CodexBridge} from './codexBridge.js';
function fixture(options:{goalActive?:boolean;terminals?:unknown[]}={}){
  const bridge=new CodexBridge({command:'/unused',args:[],idleThreadReclaim:true});
  vi.spyOn(bridge,'start').mockResolvedValue();
  const send=vi.fn(async(method:string)=>{
    if(method==='thread/read')return {thread:{status:{type:'idle'}}};
    if(method==='thread/goal/get')return {goal:options.goalActive?{status:'active'}:null};
    if(method==='thread/backgroundTerminals/list')return {data:options.terminals??[]};
    if(method==='thread/unsubscribe')return {status:'unsubscribed'};
    return {};
  });
  Object.assign(bridge,{proc:{pid:1,kill:vi.fn()},sendRequest:send});
  return {bridge,send,reclaim:(id:string)=>(bridge as unknown as {reclaimIdleThread(id:string):Promise<unknown>}).reclaimIdleThread(id)};
}
describe('native idle reclamation',()=>{
  it('unsubscribes only an idle thread, then resumes its event stream before a new turn',async()=>{
    const f=fixture();try{
      await f.reclaim('thread');expect(f.send.mock.calls.map(c=>c[0])).toEqual(['thread/read','thread/goal/get','thread/backgroundTerminals/list','thread/unsubscribe']);
      f.send.mockClear();await f.bridge.request('turn/start',{threadId:'thread'});
      expect(f.send.mock.calls.map(c=>c[0])).toEqual(['thread/resume','turn/start']);
    }finally{f.bridge.stop();}
  });
  it.each([{goalActive:true},{terminals:[{processId:'running'}]}])('retains goals and background terminals: %j',async options=>{
    const f=fixture(options);try{expect(await f.reclaim('thread')).toBe(false);expect(f.send.mock.calls.some(c=>c[0]==='thread/unsubscribe')).toBe(false);}finally{f.bridge.stop();}
  });
  it('does not probe or touch an account with an active turn',async()=>{
    const f=fixture();Object.assign(f.bridge,{activeThreadIds:new Set(['active'])});
    try{expect(await f.reclaim('thread')).toBe(false);expect(f.send).not.toHaveBeenCalled();}finally{f.bridge.stop();}
  });
});
