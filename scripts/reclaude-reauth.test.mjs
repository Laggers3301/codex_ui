import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { reauthenticate, authorizationUrl } from "./reclaude-reauth.mjs";

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory,{recursive:true,force:true}); });
async function fixture(mode = "normal") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),"reclaude-cli-test-")); directories.push(home);
  await fs.writeFile(path.join(home,"mode"),mode);
  const client = path.join(home,"fake-reclaude");
  await fs.writeFile(client,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const home=process.env.HOME,args=process.argv.slice(2),mode=fs.readFileSync(path.join(home,'mode'),'utf8');
fs.appendFileSync(path.join(home,'calls'),JSON.stringify(args)+'\\n');
if(args[0]==='logout')process.exit(0);
if(mode==='unbound'&&args[0]==='login'){console.error('本机还没有绑定组织');process.exit(1);}
fs.writeFileSync(path.join(home,'client-pid'),String(process.pid));
console.error('private-fixture-key-never-expose');
const url='https://reclaude.ai/cli/auth?state=fixture-complete-state';
if(mode==='browser'){spawnSync('xdg-open',[url],{stdio:'inherit'});process.exit(0);}
process.stdout.write('https://reclaude.ai/cli/auth?state=fixture-');
setTimeout(()=>{process.stdout.write('complete-state\\n');if(mode!=='hold')setTimeout(()=>process.exit(0),20);},20);
if(mode==='hold')setInterval(()=>{},1000);
`,{mode:0o700});
  return { home,client,orgId:"123" };
}
test("accepts only the documented HTTPS device approval page",()=>{
  assert.equal(authorizationUrl("https://reclaude.ai/cli/auth?state=ok"),"https://reclaude.ai/cli/auth?state=ok");
  for(const url of ["javascript:alert(1)","https://reclaude.ai.evil.test/cli/auth?state=x","https://evil@reclaude.ai/cli/auth?state=x","https://reclaude.ai/api/devices?state=x","https://reclaude.ai/cli/auth?state=x&token=private","https://reclaude.ai/cli/auth"]) assert.equal(authorizationUrl(url),null);
});
test("runs scoped logout/login and waits for a complete URL line without leaking CLI output",async()=>{
  const options=await fixture(),events=[];
  await reauthenticate(options,event=>events.push(event));
  assert.deepEqual((await fs.readFile(path.join(options.home,"calls"),"utf8")).trim().split("\n").map(JSON.parse),[["logout","--org","123"],["login","--org","123"]]);
  assert.deepEqual(events.filter(event=>event.type==="authorization"),[{type:"authorization",url:"https://reclaude.ai/cli/auth?state=fixture-complete-state"}]);
  assert.ok(!JSON.stringify(events).includes("private-fixture-key"));
});
test("captures the CLI browser opener instead of opening a browser on the server",async()=>{
  const events=[];await reauthenticate(await fixture("browser"),event=>events.push(event));
  assert.equal(events.filter(event=>event.type==="authorization").length,1);
});
test("binds the same organization when logout removed the selected local binding",async()=>{
  const options=await fixture("unbound");await reauthenticate(options,()=>{});
  const calls=(await fs.readFile(path.join(options.home,"calls"),"utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.at(-1),["org","bind","123"]);assert.equal(calls.length,3);
});
test("cancels and reaps the native login client",async()=>{
  const options=await fixture("hold"),controller=new AbortController();
  await assert.rejects(reauthenticate({...options,signal:controller.signal},event=>{if(event.type==="authorization")controller.abort();}),/cancelled/);
  const pid=Number(await fs.readFile(path.join(options.home,"client-pid"),"utf8"));
  assert.throws(()=>process.kill(pid,0),{code:"ESRCH"});
});
