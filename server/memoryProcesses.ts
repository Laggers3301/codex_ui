import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import type { MemoryProcesses } from '../shared/hostResources.js';
const run = promisify(execFile);
export function parseProcessRows(text: string) {
  return text.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), uid: match[2], rssBytes: Number(match[3]) * 1024, name: match[4] }];
  }).filter(p => p.pid > 0 && p.rssBytes > 0 && Number.isSafeInteger(p.rssBytes)).sort((a,b) => b.rssBytes-a.rssBytes).slice(0,5);
}
export function directoryOwnerHint(cwd: string | null): string | null {
  // A directory is a clue, not proof of the human who launched a process.
  return cwd?.match(/\/codex_zerotier_remote\/users\/([^/]+)(?:\/|$)/)?.[1] ?? null;
}
const readLink = (file: string) => fs.readlink(file).catch(() => null);
async function capture(): Promise<MemoryProcesses> {
  const [{ stdout }, passwd] = await Promise.all([
    run('ps', ['-eo','pid=,uid=,rss=,comm='], { timeout: 3000, maxBuffer: 2 * 1024 * 1024 }),
    fs.readFile('/etc/passwd','utf8').catch(() => '')
  ]);
  const names = new Map(passwd.split('\n').map(line => { const a=line.split(':'); return [a[2],a[0]]; }));
  const processes = await Promise.all(parseProcessRows(stdout).map(async p => {
    const [cwd, executable, group] = await Promise.all([readLink(`/proc/${p.pid}/cwd`),readLink(`/proc/${p.pid}/exe`),fs.readFile(`/proc/${p.pid}/cgroup`,'utf8').catch(()=>'')]);
    return { pid:p.pid, name:p.name, rssBytes:p.rssBytes, osUser:names.get(p.uid) || `UID ${p.uid}`, cwd, executable,
      resourceGroup: group.split('\n').find(line => line.startsWith('0::'))?.slice(3) ?? null, ownerHint:directoryOwnerHint(cwd) };
  }));
  return { sampledAt:new Date().toISOString(), processes };
}
export class MemoryProcessMonitor {
  private cache: MemoryProcesses | null = null;
  private pending: Promise<MemoryProcesses> | null = null;
  constructor(private sample = capture) {}
  read(): Promise<MemoryProcesses> {
    if (this.cache && Date.now()-Date.parse(this.cache.sampledAt)<15000) return Promise.resolve(this.cache);
    if (this.pending) return this.pending;
    this.pending=this.sample().then(data => {this.cache=data; return data;}).finally(()=>{this.pending=null;});
    return this.pending;
  }
}
