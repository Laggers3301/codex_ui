import {afterEach,describe,it,expect,vi} from 'vitest';
import {IdleThreadReclaimer,RuntimeLoadScheduler,assertRuntimeLoadBudget} from './runtimeMemoryLifecycle.js';
afterEach(()=>vi.useRealTimers());
describe('runtime hydration lane',()=>{
  it('serializes accounts, releases after errors, and executes each operation once',async()=>{
    const lane=new RuntimeLoadScheduler(),events:string[]=[];let release!:()=>void;
    const a=lane.run(async()=>{events.push('first');await new Promise<void>(r=>release=r);throw new Error('failed');});
    const rejected=expect(a).rejects.toThrow('failed');
    const b=lane.run(async()=>{events.push('second');return 42;});
    await vi.waitFor(()=>expect(events).toEqual(['first']));release();await rejected;expect(await b).toBe(42);expect(events).toEqual(['first','second']);
  });
  it('never executes a timed-out queued request or opens a second lane',async()=>{
    vi.useFakeTimers();const lane=new RuntimeLoadScheduler();let release!:()=>void;
    const first=lane.run(()=>new Promise<void>(r=>release=r));await vi.advanceTimersByTimeAsync(0);
    const skipped=vi.fn(async()=>{});const second=lane.run(skipped,10);const check=expect(second).rejects.toMatchObject({code:'memory_pressure'});
    await vi.advanceTimersByTimeAsync(20);await check;
    const third=vi.fn(async()=>{});const last=lane.run(third);expect(third).not.toHaveBeenCalled();release();await first;await last;
    expect(skipped).not.toHaveBeenCalled();expect(third).toHaveBeenCalledTimes(1);
  });
  it('checks host and account budgets independently',()=>{
    const g=1024**3;
    expect(()=>assertRuntimeLoadBudget(g,5*g,4*g)).not.toThrow();
    expect(()=>assertRuntimeLoadBudget(g,2*g,4*g)).toThrow();
    expect(()=>assertRuntimeLoadBudget(g,5*g,2*g)).toThrow();
  });
});
describe('idle subscriptions',()=>{
  it('cancels idle cleanup when a thread is used again and clears timers on stop',async()=>{
    vi.useFakeTimers();const reclaim=vi.fn(async()=>{}),idle=new IdleThreadReclaimer(reclaim,100);
    idle.schedule('a');await idle.beforeUse('a');await vi.advanceTimersByTimeAsync(200);expect(reclaim).not.toHaveBeenCalled();
    idle.schedule('b');idle.clear();await vi.advanceTimersByTimeAsync(200);expect(reclaim).not.toHaveBeenCalled();
  });
  it('waits for an in-progress cleanup before allowing a new turn',async()=>{
    vi.useFakeTimers();let release!:()=>void;const idle=new IdleThreadReclaimer(()=>new Promise<void>(r=>release=r),100);
    idle.schedule('a');await vi.advanceTimersByTimeAsync(100);let ready=false;const next=idle.beforeUse('a').then(()=>{ready=true;});
    await Promise.resolve();expect(ready).toBe(false);release();await next;expect(ready).toBe(true);idle.clear();
  });
  it('retries busy threads later without touching them',async()=>{
    vi.useFakeTimers();const reclaim=vi.fn(async()=>false),idle=new IdleThreadReclaimer(reclaim,100);
    idle.schedule('a');await vi.advanceTimersByTimeAsync(100);expect(reclaim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);expect(reclaim).toHaveBeenCalledTimes(2);idle.clear();
  });
});
