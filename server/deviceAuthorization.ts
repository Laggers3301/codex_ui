import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import {randomUUID} from "node:crypto";
import type {CodexBridge} from "./codexBridge.js";
import {authDiagnostic, type AuthDiagnostic} from "./authDiagnostics.js";

interface Target {home:string;expected:{stamp:number;fingerprint:string|null};version:string}
export interface AuthorizationHost {
  authorizationTarget(accountId:string):Target;
  createDeviceAuthorizationBridge(accountId:string,stageHome:string):CodexBridge;
  installAuthorizedCredentials(accountId:string,stageHome:string,expected:Target["expected"]):Promise<"busy"|"installed">;
  verifyAuthorizedAccount(accountId:string):Promise<boolean>;
}
type Phase="starting"|"awaiting_authorization"|"authorized_waiting_idle"|"verifying"|"completed"|"failed";
interface Session {id:string;accountId:string;status:Phase;createdAt:string;updatedAt:string;expected:Target["expected"];code?:string;verificationUrl?:string;error?:string;native?:CodexBridge;working?:boolean;nextTryAt?:number}
const value=(x:unknown):Record<string,unknown>=>x&&typeof x==="object"?x as Record<string,unknown>:{};
const safeError=(error:unknown)=>error instanceof Error&&["account_mismatch","authorization_conflict","invalid_credentials"].includes(error.message)?error.message:"authorization_failed";

export class DeviceAuthorization {
  private sessions=new Map<string,Session>();
  private timer:ReturnType<typeof setInterval>;
  private stopped=false;
  constructor(private host:AuthorizationHost,private root:string,private diagnostic:(row:AuthDiagnostic)=>void=()=>{}) {
    fs.mkdirSync(root,{recursive:true,mode:0o700});fs.chmodSync(root,0o700);
    // Resume completed authorizations after deployment without re-running login.
    for(const id of fs.readdirSync(root).filter(v=>/^[a-f0-9-]{36}$/.test(v)).slice(-50)) {
      try {
        const row=JSON.parse(fs.readFileSync(path.join(root,id,"session.json"),"utf8")) as Session;
        if(row.id!==id || !["authorized_waiting_idle","verifying"].includes(row.status))continue;
        this.host.authorizationTarget(row.accountId);this.sessions.set(id,row);
      }catch{/* A damaged private manifest must not modify any live account. */}
    }
    this.timer=setInterval(()=>{void this.tick();},15_000);this.timer.unref();
  }
  private home(s:Session){return path.join(this.root,s.id,"home");}
  private save(s:Session){
    s.updatedAt=new Date().toISOString();
    // Device codes and raw native responses stay in memory, not on disk.
    const {id,accountId,status,createdAt,updatedAt,expected,error}=s;
    const file=path.join(this.root,id,"session.json"),tmp=file+".tmp";
    fs.writeFileSync(tmp,JSON.stringify({id,accountId,status,createdAt,updatedAt,expected,error}),{mode:0o600});fs.renameSync(tmp,file);
  }
  private view(s:Session){return {id:s.id,accountId:s.accountId,status:s.status,createdAt:s.createdAt,updatedAt:s.updatedAt,error:s.error,
    ...(s.status==="awaiting_authorization"?{userCode:s.code,verificationUrl:s.verificationUrl}: {})};}
  status(id:string){const s=this.sessions.get(id);if(!s)throw new Error("Unknown authorization session");return this.view(s);}
  async start(accountId:string){
    if(this.stopped)throw new Error("Authorization manager stopped");
    const existing=[...this.sessions.values()].find(s=>s.accountId===accountId&&!["completed","failed"].includes(s.status));
    if(existing)return this.view(existing);
    const target=this.host.authorizationTarget(accountId);
    const now=new Date().toISOString();const s:Session={id:randomUUID(),accountId,status:"starting",createdAt:now,updatedAt:now,expected:target.expected};
    fs.mkdirSync(this.home(s),{recursive:true,mode:0o700});fs.chmodSync(path.dirname(this.home(s)),0o700);
    // An empty staging home must never fall back to the OS shared keyring.
    fs.writeFileSync(path.join(this.home(s),"config.toml"),'cli_auth_credentials_store = "file"\n',{mode:0o600,flag:"wx"});
    this.sessions.set(s.id,s);this.save(s);
    try {
      const native=this.host.createDeviceAuthorizationBridge(accountId,this.home(s));s.native=native;
      native.on("notification",(message:unknown)=>{
        const m=value(message),p=value(m.params);
        if(m.method!=="account/login/completed" || this.stopped || s.status==="failed")return;
        if(p.success===true){s.status="authorized_waiting_idle";delete s.code;delete s.verificationUrl;this.save(s);void this.advance(s);}
        else {s.status="failed";s.error="authorization_failed";this.save(s);native.stop();this.diagnostic(authDiagnostic(accountId,"device_authorization","failure",{code:"authorization_failed"}));}
      });
      await native.start();
      const login=value(await native.request("account/login/start",{type:"chatgptDeviceCode"},30_000));
      if(this.stopped){native.stop();throw new Error("Authorization manager stopped");}
      if(typeof login.userCode!=="string" || !/^[A-Z0-9-]{6,24}$/.test(login.userCode) || login.verificationUrl!=="https://auth.openai.com/codex/device")throw new Error("Invalid device login result");
      if(s.status==="starting"){s.status="awaiting_authorization";s.code=login.userCode;s.verificationUrl=login.verificationUrl;this.save(s);}
      this.diagnostic(authDiagnostic(accountId,"device_start","success"));
      return this.view(s);
    }catch(error){s.status="failed";s.error=safeError(error);s.native?.stop();this.save(s);this.diagnostic(authDiagnostic(accountId,"device_start","failure",error));throw new Error(s.error);}
  }
  private async advance(s:Session){
    if(this.stopped||s.working||Date.now()<(s.nextTryAt??0))return;s.working=true;
    try {
      if(s.status==="authorized_waiting_idle") {
        // A successful device exchange is not yet an installed credential.
        await s.native?.stopAndWait();s.native=undefined;
        if(this.stopped)return;
        this.diagnostic(authDiagnostic(s.accountId,"device_authorization","success"));
        if(await this.host.installAuthorizedCredentials(s.accountId,this.home(s),s.expected)==="busy")return;
        s.status="verifying";this.save(s);
      }
      if(s.status==="verifying" && !this.stopped) {
        if(await this.host.verifyAuthorizedAccount(s.accountId)){s.status="completed";delete s.error;}
        else{s.error="verification_incomplete";s.nextTryAt=Date.now()+60_000;}
        this.save(s);
      }
    }catch(error){
      s.status="failed";s.error=safeError(error);this.save(s);
      this.diagnostic(authDiagnostic(s.accountId,"credential_install","failure",{code:s.error}));
    }finally{s.working=false;}
  }
  async tick(){
    if(this.stopped)return;
    for(const s of this.sessions.values()){
      if(s.status==="awaiting_authorization" && Date.now()-Date.parse(s.createdAt)>15*60_000){s.status="failed";s.error="authorization_expired";s.native?.stop();this.save(s);}
      if(["authorized_waiting_idle","verifying"].includes(s.status))await this.advance(s);
    }
  }
  close(){this.stopped=true;clearInterval(this.timer);for(const s of this.sessions.values())s.native?.stop();}
}

/** Local Unix socket only. No public HTTP login/credential-upload endpoint. */
export async function startAuthorizationControl(manager:DeviceAuthorization,socketPath:string){
  if(fs.existsSync(socketPath)) {
    if(!fs.lstatSync(socketPath).isSocket())throw new Error("Auth control path is not a socket");
    const live=await new Promise<boolean>(resolve=>{const s=net.connect(socketPath);s.setTimeout(500);s.once("connect",()=>{s.destroy();resolve(true);});s.once("error",()=>resolve(false));s.once("timeout",()=>{s.destroy();resolve(true);});});
    if(live)throw new Error("Auth control already running");fs.unlinkSync(socketPath);
  }
  const server=net.createServer(socket=>{
    let buffer="",handled=false;socket.setTimeout(35_000,()=>socket.destroy());
    socket.on("error",()=>{});
    socket.on("data",chunk=>{
      if(handled)return;buffer+=chunk.toString("utf8");if(buffer.length>4096){socket.destroy();return;}
      const end=buffer.indexOf("\n");if(end<0)return;handled=true;
      void(async()=>{
        try {
          const input=value(JSON.parse(buffer.slice(0,end)));let result:unknown;
          if(input.action==="health")result={ready:true};
          else if(input.action==="start"&&typeof input.accountId==="string")result=await manager.start(input.accountId);
          else if(input.action==="status"&&typeof input.sessionId==="string")result=manager.status(input.sessionId);
          else throw new Error();
          socket.end(JSON.stringify({ok:true,data:result})+"\n");
        }catch{socket.end(JSON.stringify({ok:false,error:"authorization_control_failed"})+"\n");}
      })();
    });
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(socketPath,()=>{server.off("error",reject);resolve();});});
  fs.chmodSync(socketPath,0o600);
  return ()=>{manager.close();server.close();};
}
