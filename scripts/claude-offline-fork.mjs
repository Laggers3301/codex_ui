import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
// Keep the modern filesystem-only SDK (Zod 4) isolated from the host's existing
// runtime dependencies (Zod 3). No model process is started by this worker.
const sessionRequire = createRequire(new URL("../integrations/claude-session-tools/package.json", import.meta.url));
const { forkSession } = await import(sessionRequire.resolve("@anthropic-ai/claude-agent-sdk"));
const [sessionId, cwd, title, upToMessageId] = process.argv.slice(2);
const resultFile = process.env.CLAUDE_FORK_RESULT_FILE;
const root = process.env.CLAUDE_CONFIG_DIR;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function candidates() {
  const directory = path.join(root, "projects"), files = [];
  for (const project of fs.readdirSync(directory, { withFileTypes:true })) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    for (const file of fs.readdirSync(path.join(directory,project.name), {withFileTypes:true})) {
      const id = file.name.replace(/\.jsonl$/, "");
      if (file.isFile() && file.name.endsWith(".jsonl") && uuid.test(id) && id !== sessionId) files.push({id,file:path.join(directory,project.name,file.name)});
    }
  }
  return files;
}
async function validate(file, id) {
  const input = fs.createReadStream(file, {highWaterMark:64*1024}), lines = createInterface({input,crlfDelay:Infinity});
  let origin = false, inspected = 0;
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line)>32*1024*1024) throw Error("Offline fork record exceeds safe validation budget");
      const row=JSON.parse(line);
      if(row.forkedFrom?.sessionId===sessionId&&row.sessionId===id){origin=true;break;}
      if(++inspected>=16)break;
    }
  }finally{lines.close();input.destroy();}
  const fd=fs.openSync(file,"r"),size=fs.fstatSync(fd).size,buffer=Buffer.alloc(Math.min(size,256*1024));
  try{fs.readSync(fd,buffer,0,buffer.length,Math.max(0,size-buffer.length));}finally{fs.closeSync(fd);}
  const last=buffer.toString("utf8").trimEnd().split("\n").at(-1);
  let tail;try{tail=JSON.parse(last);}catch{throw Error("Offline fork is incomplete; original history retained");}
  if(!origin||tail.type!=="custom-title"||tail.sessionId!==id)throw Error("Offline fork result is uncertain; original history retained");
}
function start(pid){try{const stat=fs.readFileSync(`/proc/${pid}/stat`,"utf8");return stat.slice(stat.lastIndexOf(")")+2).split(" ")[19];}catch{return "";}}
let lock,nonce;
try {
  if(resultFile){
    if(!root||!path.isAbsolute(resultFile)||fs.realpathSync(path.dirname(resultFile))!==fs.realpathSync(root))throw Error("Invalid offline fork result location");
    lock=resultFile+".lock";nonce=randomUUID();
    if(fs.existsSync(lock)){
      const owner=JSON.parse(fs.readFileSync(lock,"utf8"));
      let alive=true;try{process.kill(owner.pid,0);}catch(error){if(error.code==="ESRCH")alive=false;}
      if(alive&&(!owner.start||!start(owner.pid)||start(owner.pid)===owner.start))throw Error("This offline fork is already running");
      fs.unlinkSync(lock);
    }
    fs.writeFileSync(lock,JSON.stringify({pid:process.pid,start:start(process.pid),nonce}),{flag:"wx",mode:0o600});
  }
  let result;
  if(resultFile&&fs.existsSync(resultFile)){
    const saved=JSON.parse(fs.readFileSync(resultFile,"utf8"));
    if(saved.sourceSessionId!==sessionId||saved.upToMessageId!==(upToMessageId||null)||!uuid.test(saved.sessionId))throw Error("Offline fork recovery record mismatch");
    const found=candidates().filter(entry=>entry.id===saved.sessionId);
    if(found.length!==1)throw Error("Offline fork recovery file missing");
    await validate(found[0].file,saved.sessionId);result={sessionId:saved.sessionId};
  }else{
    const existing=resultFile?candidates():[];
    if(existing.length>1)throw Error("Multiple offline fork results found; refusing to repeat fork");
    if(existing.length){await validate(existing[0].file,existing[0].id);result={sessionId:existing[0].id};}
    else result=await forkSession(sessionId,{...(cwd?{dir:cwd}:{}),...(title?{title}:{}),...(upToMessageId?{upToMessageId}:{})});
    if(resultFile){
      const temporary=resultFile+".partial";
      fs.writeFileSync(temporary,JSON.stringify({...result,sourceSessionId:sessionId,upToMessageId:upToMessageId||null}),{mode:0o600});fs.renameSync(temporary,resultFile);
    }
  }
  process.stdout.write(JSON.stringify(result)+"\n");
}finally{if(lock&&fs.existsSync(lock)&&JSON.parse(fs.readFileSync(lock,"utf8")).nonce===nonce)fs.unlinkSync(lock);}
