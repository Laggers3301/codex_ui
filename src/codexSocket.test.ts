import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {CodexSocket} from './codexSocket';
class FakeSocket extends EventTarget {
  static CONNECTING=0;static OPEN=1;static CLOSED=3;static instances:FakeSocket[]=[];
  readyState=0;sent:string[]=[];closed=false;
  constructor(public url:string){super();FakeSocket.instances.push(this);}
  send(text:string){this.sent.push(text);}
  close(){this.closed=true;this.readyState=3;/* emulate a lost close event */}
  open(){this.readyState=1;this.dispatchEvent(new Event('open'));}
  message(data:unknown){this.dispatchEvent(Object.assign(new Event('message'),{data:JSON.stringify(data)}));}
}
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-10T00:00:00Z'));FakeSocket.instances=[];
  vi.stubGlobal('WebSocket',FakeSocket);
  vi.stubGlobal('window',Object.assign(new EventTarget(),{location:{protocol:'https:',host:'console.test'},setTimeout,clearTimeout,setInterval,clearInterval}));
  vi.stubGlobal('document',Object.assign(new EventTarget(),{visibilityState:'visible'}));
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
describe('transport recovery',()=>{
 it('rebuilds a stuck connecting socket even if closing never emits an event',()=>{
  const c=new CodexSocket();c.connect();vi.advanceTimersByTime(11000);
  expect(FakeSocket.instances).toHaveLength(2);expect(FakeSocket.instances[0].closed).toBe(true);
 });
 it('reconnects a half-open link and never replays business messages',()=>{
  const c=new CodexSocket();c.connect();const first=FakeSocket.instances[0];first.open();
  c.send({type:'turn.start',prompt:'test'});vi.advanceTimersByTime(16000);
  expect(FakeSocket.instances).toHaveLength(2);expect(first.closed).toBe(true);
  expect(FakeSocket.instances[1].sent).toEqual([]);
 });
 it('keeps a healthy socket alive, filters heartbeat replies and ignores old socket close',()=>{
  const c=new CodexSocket(),messages:unknown[]=[];c.subscribe(m=>messages.push(m));c.connect();const s=FakeSocket.instances[0];s.open();
  for(let i=0;i<10;i++){vi.advanceTimersByTime(5000);s.message({type:'transport.pong',ok:true});}
  expect(FakeSocket.instances).toHaveLength(1);expect(messages).toEqual([]);
  s.message({type:'hello'});expect(messages).toEqual([{type:'hello'}]);
 });
 it('probes on wake and lets stale sockets reconnect',()=>{
  const c=new CodexSocket();c.connect();const s=FakeSocket.instances[0];s.open();window.dispatchEvent(new Event('online'));
  expect(s.sent.map(t=>JSON.parse(t).type)).toEqual(['transport.ping']);
  vi.advanceTimersByTime(11000);expect(FakeSocket.instances).toHaveLength(2);
  s.dispatchEvent(new Event('close'));expect(FakeSocket.instances).toHaveLength(2);
 });
});
