import {EventEmitter} from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {it,expect,vi} from "vitest";
import {DeviceAuthorization,startAuthorizationControl,type AuthorizationHost} from "./deviceAuthorization.js";
import type {CodexBridge} from "./codexBridge.js";
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"device-auth-"));const native=new EventEmitter() as EventEmitter&{start:()=>Promise<void>;stop:()=>void;stopAndWait:()=>Promise<void>;request:ReturnType<typeof vi.fn>};
 native.start=async()=>{};native.stop=()=>{};native.stopAndWait=async()=>{};
 native.request=vi.fn(async()=>({userCode:"FIXT-ABCD",verificationUrl:"https://auth.openai.com/codex/device"}));
 const host:AuthorizationHost={authorizationTarget:()=>({home:root,expected:{stamp:1,fingerprint:"private-fixture"},version:"0.163.0"}),createDeviceAuthorizationBridge:()=>native as unknown as CodexBridge,
 installAuthorizedCredentials:vi.fn(async()=>"installed" as const),verifyAuthorizedAccount:vi.fn(async()=>true)};
 const manager=new DeviceAuthorization(host,root);
 return {root,native,host,manager,cleanup(){manager.close();fs.rmSync(root,{recursive:true,force:true});}};
}
it("uses the official device flow only in staging and does not persist the code",async()=>{
 const f=fixture();try{const s=await f.manager.start("a");
  expect(f.native.request).toHaveBeenCalledWith("account/login/start",{type:"chatgptDeviceCode"},30000);
  expect(s.userCode).toBe("FIXT-ABCD");expect(await f.manager.start("a")).toEqual(s);
  expect(f.native.request).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(path.join(f.root,s.id,"session.json"),"utf8")).not.toContain("FIXT-ABCD");
  expect(f.host.installAuthorizedCredentials).not.toHaveBeenCalled();
 }finally{f.cleanup();}
});
it("waits for successful native completion, installation and verification",async()=>{
 const f=fixture();try{const s=await f.manager.start("a");f.native.emit("notification",{method:"account/login/completed",params:{success:true}});
  await vi.waitFor(()=>expect(f.manager.status(s.id).status).toBe("completed"));
  expect(f.host.installAuthorizedCredentials).toHaveBeenCalledTimes(1);expect(f.host.verifyAuthorizedAccount).toHaveBeenCalledTimes(1);
 }finally{f.cleanup();}
});
it("a busy runtime defers installation without stopping polling or losing authorization",async()=>{
 const f=fixture();try{vi.mocked(f.host.installAuthorizedCredentials).mockResolvedValueOnce("busy");
  const s=await f.manager.start("a");f.native.emit("notification",{method:"account/login/completed",params:{success:true}});
  await vi.waitFor(()=>expect(f.host.installAuthorizedCredentials).toHaveBeenCalledTimes(1));
  expect(f.manager.status(s.id).status).toBe("authorized_waiting_idle");await f.manager.tick();
  expect(f.manager.status(s.id).status).toBe("completed");
 }finally{f.cleanup();}
});
it("failed authorization never installs or exposes native error details",async()=>{
 const f=fixture();try{const s=await f.manager.start("a");f.native.emit("notification",{method:"account/login/completed",params:{success:false,error:"SECRET"}});
  expect(f.manager.status(s.id).status).toBe("failed");expect(JSON.stringify(f.manager.status(s.id))).not.toContain("SECRET");expect(f.host.installAuthorizedCredentials).not.toHaveBeenCalled();
 }finally{f.cleanup();}
});
it("keeps installed credentials on transient verification failure",async()=>{
 const f=fixture();try{vi.mocked(f.host.verifyAuthorizedAccount).mockResolvedValueOnce(false);
  const s=await f.manager.start("a");f.native.emit("notification",{method:"account/login/completed",params:{success:true}});
  await vi.waitFor(()=>expect(f.manager.status(s.id).status).toBe("verifying"));
  expect(f.host.installAuthorizedCredentials).toHaveBeenCalledTimes(1);
 }finally{f.cleanup();}
});
it("exposes only a private local socket and does not start login for health checks",async()=>{
 const f=fixture();let close:(()=>void)|undefined;
 try{const file=path.join(f.root,"control.sock");close=await startAuthorizationControl(f.manager,file);
  const reply=await new Promise<string>((resolve,reject)=>{const s=net.connect(file);let text="";s.once("error",reject);s.once("connect",()=>s.write('{"action":"health"}\n'));s.on("data",c=>{text+=c;});s.on("end",()=>resolve(text));});
  expect(JSON.parse(reply)).toEqual({ok:true,data:{ready:true}});expect(fs.statSync(file).mode&0o777).toBe(0o600);expect(f.native.request).not.toHaveBeenCalled();
 }finally{close?.();f.cleanup();}
});
