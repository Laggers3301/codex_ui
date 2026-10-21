import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe,it,expect} from "vitest";
import {authDiagnostic,AuthDiagnosticLog} from "./authDiagnostics.js";
describe("auth diagnostic whitelist",()=>{
  it("preserves only status, known error code, request ID and dates",()=>{
    const input={message:"request failed",data:{httpStatus:401,code:"invalid_grant",request_id:"12345678-1234-1234-1234-123456789012",refresh_token:"SECRET",body:"SECRET",headers:{authorization:"Bearer SECRET"}}};
    const row=authDiagnostic("a","native_refresh","failure",input,"2026-10-20T08:34:00Z");
    expect(row).toMatchObject({httpStatus:401,code:"invalid_grant",requestId:input.data.request_id});
    expect(JSON.stringify(row)).not.toContain("SECRET");
  });
  it("never retains arbitrary codes, messages, emails or malformed IDs",()=>{
    const row=authDiagnostic("a","native_refresh","failure",{code:"SECRET",message:"mail a@example.com Bearer SECRET",requestId:"eyJ.secret.jwt"});
    expect(row.code).toBe("unknown");expect(row.requestId).toBeNull();expect(JSON.stringify(row)).not.toContain("SECRET");
    expect(()=>authDiagnostic("a","health_verify","SECRET" as never)).toThrow();
  });
  it("understands safe native line context and never serializes the line",()=>{
    const row=authDiagnostic("a","native_refresh","failure","Failed to refresh token status=401 invalid_grant request_id=12345678-1234-1234-1234-123456789012 authorization=SECRET");
    expect(row.httpStatus).toBe(401);expect(row.code).toBe("invalid_grant");expect(row.requestId).not.toBeNull();expect(JSON.stringify(row)).not.toContain("SECRET");
  });
  it("writes 0600 bounded files and projects excess runtime properties again",()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"auth-diag-"));
    try{
      const file=path.join(dir,"events.jsonl"),log=new AuthDiagnosticLog(file);
      log.append({...authDiagnostic("a","health_verify","success"),secret:"SECRET"} as never);
      expect(fs.statSync(file).mode&0o777).toBe(0o600);expect(fs.readFileSync(file,"utf8")).not.toContain("SECRET");
      fs.writeFileSync(file," ".repeat(1024*1024));log.append(authDiagnostic("a","health_verify","success"));
      expect(fs.existsSync(file+".1")).toBe(true);expect(fs.statSync(file).size).toBeLessThan(1000);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
