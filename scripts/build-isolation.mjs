import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

export function buildProcess(node,args,cgroup,nonce=randomUUID().slice(0,8)){
 if(!cgroup.includes('/codex-workers.slice/'))return{command:node,args};
 return{command:'/usr/bin/systemd-run',args:['--user','--scope','--collect','--quiet','--slice=app.slice',`--unit=codex-frontend-build-${nonce}`,'-p','MemoryHigh=2560M','-p','MemoryMax=3G','-p','MemorySwapMax=256M','-p','CPUQuota=150%','-p','TasksMax=64','--',node,...args]};
}
export function runBuildNode(args){
 let cgroup='';if(process.platform==='linux'){try{cgroup=fs.readFileSync('/proc/self/cgroup','utf8');}catch{}}
 const command=buildProcess(process.execPath,args,cgroup);
 // No unbounded fallback on isolation failure: leave the live build untouched.
 return spawnSync(command.command,command.args,{stdio:'inherit',env:process.env});
}
