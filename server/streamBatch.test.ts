import {afterEach,expect,it,vi} from 'vitest';
import {LatestTaskQueue} from './streamBatch.js';
afterEach(()=>vi.useRealTimers());
it('keeps only the latest replaceable snapshot per item while isolating users',()=>{
 vi.useFakeTimers();const seen:string[]=[];const queue=new LatestTaskQueue(32);
 queue.enqueue('a',()=>seen.push('old'));queue.enqueue('a',()=>seen.push('latest'));queue.enqueue('b',()=>seen.push('other'));
 vi.advanceTimersByTime(31);expect(seen).toEqual([]);vi.advanceTimersByTime(1);expect(seen).toEqual(['latest','other']);
});
it('first content is immediate and completion flushes only its own turn',()=>{
 vi.useFakeTimers();const seen:string[]=[];const queue=new LatestTaskQueue(200);
 queue.enqueue('turn-a/item',()=>seen.push('first'),true);queue.enqueue('turn-a/item',()=>seen.push('final'));queue.enqueue('turn-b/item',()=>seen.push('other'));
 expect(seen).toEqual(['first']);queue.flushPrefix('turn-a/');expect(seen).toEqual(['first','final']);vi.advanceTimersByTime(200);expect(seen).toEqual(['first','final','other']);
});
it('flushes remaining checkpoints once during close and reports failures without losing other items',()=>{
 vi.useFakeTimers();const errors:unknown[]=[];const seen:string[]=[];const queue=new LatestTaskQueue(32,e=>errors.push(e));
 queue.enqueue('bad',()=>{throw Error('disk failure');});queue.enqueue('good',()=>seen.push('saved'));queue.flush();vi.advanceTimersByTime(100);
 expect(seen).toEqual(['saved']);expect(errors).toHaveLength(1);
});
