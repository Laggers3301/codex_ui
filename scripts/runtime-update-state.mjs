import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const appRoot = fileURLToPath(new URL('../', import.meta.url));
export const candidateFile = path.join(appRoot, 'bin/runtime-candidate.json');
export const selectionFile = home => path.join(home, '.web-runtime-version.json');
export const stableVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
export function newerVersion(a, b) {
  if (!stableVersion(a) || !stableVersion(b)) return false;
  const x=a.split('.').map(Number),y=b.split('.').map(Number);
  for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];
  return false;
}
export function runtimeBinary(version, root=appRoot) {
  if (!stableVersion(version)) throw new Error('Invalid stable Codex version');
  return path.join(root, `bin/codex-${version}/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`);
}
export function selectedRuntime(home, fallback, root=appRoot) {
  try {
    const state=JSON.parse(fs.readFileSync(selectionFile(home),'utf8'));
    const binary=runtimeBinary(state.version,root);
    fs.accessSync(binary,fs.constants.X_OK);
    return binary;
  } catch { return fallback; }
}
// Called by the runtime wrapper only AFTER it owns the account's flock lease.
// Explicit replacements and their recovery launches never opt into this path.
export function adoptValidatedStartupRuntime(home, fallback, root=appRoot) {
  try {
    const candidate=JSON.parse(fs.readFileSync(path.join(root,'bin/runtime-candidate.json'),'utf8'));
    const current=selectedRuntime(home,fallback,root).match(/\/codex-(\d+\.\d+\.\d+)\//)?.[1]??'0.0.0';
    if(candidate.validated!==true||!newerVersion(candidate.version,current))return null;
    fs.accessSync(runtimeBinary(candidate.version,root),fs.constants.X_OK);
    writeState(selectionFile(home),{version:candidate.version,selectedAt:new Date().toISOString()});
    return candidate.version;
  }catch{return null;}
}
export function writeState(file, state) {
  const temporary=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state,null,2)+'\n',{mode:0o600});
  fs.renameSync(temporary,file);
}
