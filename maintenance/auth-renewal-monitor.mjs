// Independent, read-only auth observer. Never calls OAuth or a Codex RPC.
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHmac} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const exec = promisify(execFile);
const HOUR = 3600000;
const iso = n => new Date(n).toISOString();
const time = x => typeof x === 'string' && Number.isFinite(Date.parse(x)) ? Date.parse(x) : null;

export function readTiming(home) {
  let fd;
  try {
    fd = fs.openSync(path.join(home, 'auth.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 131072) throw Error();
    const text = fs.readFileSync(fd, 'utf8');
    // Select only the access token and date; do not parse/copy refresh tokens.
    const access = text.match(/"access_token"\s*:\s*("(?:[^"\\]|\\.)*")/);
    const refreshDate = text.match(/"last_refresh"\s*:\s*("(?:[^"\\]|\\.)*")/);
    const claims = JSON.parse(Buffer.from(JSON.parse(access?.[1] ?? 'null').split('.')[1], 'base64url'));
    if (!Number.isFinite(claims.exp) || claims.exp <= 0 || claims.exp > 32503680000) throw Error();
    return {lastRefresh: refreshDate ? JSON.parse(refreshDate[1]) : null,
      issuedAt: Number.isFinite(claims.iat) ? iso(claims.iat * 1000) : null, expiresAt: iso(claims.exp * 1000)};
  } catch { return {error: 'credential_metadata_unavailable'}; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function parseDiagnostics(text) {
  const result = [];
  for (const line of text.split('\n')) {
    try {
      const r = JSON.parse(line);
      if (!/^\d{6}$/.test(r.accountId)) continue;
      const code = r.code;
      // account_missing is a host observation, including a transient stale
      // cache during device-login handover, not a native refresh rejection.
      if (['renewed', 'renewal_temporarily_failed', 'refresh_token_reused', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_unavailable'].includes(code)) {
        result.push({accountId:r.accountId, code, at:Number.isFinite(r.time) ? iso(r.time) : null});
      }
    } catch { /* Do not retain raw native logs. */ }
  }
  return result;
}

export async function readDiagnostics(service, from, command=exec) {
  const args=['--user','-u',service,'--since','@'+Math.floor(from/1000),'--no-pager','-o','cat','-n','1000','--grep','Account authentication|Account runtime lifecycle'];
  try {return parseDiagnostics((await command('/usr/bin/journalctl',args,{timeout:8000,maxBuffer:1024*1024})).stdout);}
  catch(error) {
    // journalctl --grep returns 1 (without stderr) when no records match.
    if(error.code===1 && !String(error.stderr??'').trim()) return [];
    throw Error('auth_journal_unavailable');
  }
}

export function evaluateAccount(account, metadata, previous, diagnostics, now) {
  const old = previous ?? {};
  const lastRefresh = time(metadata.lastRefresh), expires = time(metadata.expiresAt);
  const epoch = metadata.expiresAt ?? old.expiresAt ?? 'unknown';
  const event = (kind, reason) => ({key:`${account.id}:${kind}:${epoch}:${reason}`, accountId:account.id,
    kind, reason, at:iso(now), expiresAt:metadata.expiresAt ?? null});
  const current = {...metadata, status:'before_renewal_window'};
  if (metadata.error || !lastRefresh || !expires) return {current:{...current,status:'metadata_unavailable'}, event:event('warning','metadata_unavailable')};
  current.renewalWindowAt = iso(expires - 24 * HOUR);
  const relevant = diagnostics.filter(x => x.accountId === account.id && (!time(x.at) || time(x.at) >= lastRefresh));
  const failed = relevant.findLast(x => x.code !== 'renewed');
  const advanced = lastRefresh > (time(old.lastRefresh) ?? lastRefresh) && expires > (time(old.expiresAt) ?? expires);
  const known = account.knownFailure && lastRefresh <= time(account.knownFailure.lastRefresh);
  if (known) return {current:{...current,status:'known_reauthorization_required'}};
  if (failed && (!advanced || time(failed.at) > lastRefresh)) {
    const reason = failed.code === 'renewal_temporarily_failed' ? failed.code : 'reauthorization_required';
    return {current:{...current,status:reason}, event:event('failure',reason)};
  }
  if (advanced) {
    const confirmed = relevant.some(x => x.code === 'renewed');
    return {current:{...current,status:confirmed?'renewed':'advanced_without_native_confirmation'},
      event:event(confirmed?'success':'notice',confirmed?'renewed':'metadata_advanced_native_event_unavailable')};
  }
  if (old.status === 'advanced_without_native_confirmation' && relevant.some(x=>x.code === 'renewed')) {
    return {current:{...current,status:'renewed'},event:event('success','renewed')};
  }
  if (now >= expires) return {current:{...current,status:'access_expired'}, event:event('failure','access_expired')};
  if (['reauthorization_required','renewal_temporarily_failed'].includes(old.status) &&
      old.lastRefresh === metadata.lastRefresh && old.expiresAt === metadata.expiresAt) {
    return {current:{...current,status:old.status}};
  }
  if (now >= expires - 24 * HOUR + 15 * 60000) return {current:{...current,status:'renewal_overdue'},event:event('warning','renewal_window_no_progress')};
  if (now >= expires - 24 * HOUR) current.status = 'renewal_window';
  // A successful rotation stays successful until the next window, not "ready".
  else if (['renewed','advanced_without_native_confirmation'].includes(old.status)) current.status = old.status;
  return {current};
}

function readJson(file) { return JSON.parse(fs.readFileSync(file,'utf8')); }
function save(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value,null,2)+'\n',{mode:0o600});
  fs.renameSync(tmp,file);
  fs.chmodSync(file,0o600);
}

export async function deliver(config, state, request = fetch) {
  const unsent = state.events.filter(x => !x.delivery);
  if (!unsent.length) return;
  const url = new URL(config.notification.baseUrl);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw Error('notification_target_not_loopback');
  const payload = Buffer.from(JSON.stringify({u:config.notification.userId,exp:Date.now()+120000})).toString('base64url');
  const sig = createHmac('sha256',fs.readFileSync(config.notification.sessionSecretFile,'utf8').trim()).update(payload).digest('base64url');
  const headers = {'content-type':'application/json',cookie:`${config.notification.cookieName}=${payload}.${sig}`};
  const base = `${url.origin}/api/projects/${encodeURIComponent(config.notification.projectId)}/threads/${encodeURIComponent(config.notification.threadId)}/schedules`;
  const call = async (method, endpoint, body) => {
    const r = await request(endpoint,{method,headers,signal:AbortSignal.timeout(8000),...(body?{body:JSON.stringify(body)}:{})});
    if (!r.ok) throw Error(`notification_http_${r.status}`);
    return (await r.json()).data;
  };
  const tasks = await call('GET',base);
  const task = tasks.find(x => x.id === config.notification.taskId);
  if (!task) throw Error('notification_task_missing');
  // Reconcile an interrupted POST/PATCH before retrying. Never claim actual
  // chat delivery merely because a future schedule was saved.
  const batch = state.deliveryBatch;
  if (batch) {
    if (task.prompt?.includes(batch.marker)) {
      const run = task.history?.findLast(x => Date.parse(x.scheduledAt) >= Date.parse(batch.preparedAt)-1000);
      if (run?.status === 'queued') {
        for (const item of state.events) if (batch.keys.includes(item.key)) item.delivery = {status:'queued_to_conversation',at:iso(Date.now())};
        state.deliveryBatch = null;
        return;
      }
      if (task.enabled || task.status === 'dispatching') return;
    }
    if (Date.now() < Date.parse(batch.preparedAt)+5*60000) return;
    state.deliveryBatch = null; // failed/skipped one-shot: safely retry later
  }
  const items = state.events.filter(x => !x.delivery).slice(0,12);
  const marker = `auth-monitor:${items.map(x=>x.at+':'+x.accountId+':'+x.reason).join('|')}`;
  const preparedAt = iso(Date.now());
  state.deliveryBatch = {marker,keys:items.map(x=>x.key),preparedAt};
  // Durable before network I/O: timeout cannot result in duplicate submissions.
  save(config.stateFile,state);
  const prompt = `【独立认证监控事件通知】\n${marker}\n脚本已只读核实以下事件（UTC），请仅用简体中文简短向用户报告账号、事件、时间、到期剩余时间及是否需授权。不要再巡检、刷新凭据、登录/登出、清理或重启。success=原生renewed事件与凭据日期双重确认；notice仅代表日期推进，尚未核实原生事件。服务故障告警可能是后端恢复后补送，不能声称实时送达。不要创建任何新任务。\n${JSON.stringify(items.map(({accountId,kind,reason,at,expiresAt})=>({accountId,kind,reason,at,expiresAt})))}`;
  await call('PATCH',`${base}/${encodeURIComponent(task.id)}`,{title:'账号续签监控事件通知（仅事件触发）',prompt,
    schedule:{kind:'once',at:iso(Date.now()+30000),timezone:'Asia/Shanghai'},enabled:true});
}

export async function run(config) {
  const now=Date.now();
  let state;
  try { state=readJson(config.stateFile); }
  catch(error) {
    if (error.code !== 'ENOENT') throw Error('monitor_state_unreadable');
    let baseline={}; try {baseline=readJson(config.baselineFile);}catch{}
    state={checkedAt:baseline.checkedAt??null,accounts:baseline.accounts??{},events:[],reported:[]};
  }
  state.events ??= []; state.reported ??= [];
  const add = event => {
    if (!event || state.events.some(x=>x.key===event.key) || state.reported.includes(event.key)) return;
    state.events.push(event);
    console.log(JSON.stringify({event:'auth_monitor_event',...event}));
  };
  const service = await exec('/usr/bin/systemctl',['--user','show',config.service,'-p','ActiveState','--value'],{timeout:5000,maxBuffer:4096}).then(x=>x.stdout.trim()).catch(()=>'unknown');
  if (service !== 'active') add({key:`service:${service}:${state.serviceOutageAt??iso(now)}`,accountId:'backend',kind:'failure',reason:'backend_'+service,at:iso(now),expiresAt:null});
  if (service !== 'active') state.serviceOutageAt ??= iso(now);
  else if (state.serviceOutageAt) {
    add({key:`service:recovered:${state.serviceOutageAt}`,accountId:'backend',kind:'success',reason:'backend_recovered',at:iso(now),expiresAt:null});
    state.serviceOutageAt=null;
  }
  let diagnostics=[];
  try {
    diagnostics=await readDiagnostics(config.service,Math.max(now-24*HOUR,(time(state.checkedAt)??now-5*60000)-5000));
  } catch {add({key:`journal:${iso(now).slice(0,10)}`,accountId:'monitor',kind:'warning',reason:'auth_journal_unavailable',at:iso(now),expiresAt:null});}
  for(const account of config.accounts) {
    const previous=state.accounts[account.id];
    const result=evaluateAccount(account,readTiming(account.home),previous,diagnostics,now);
    // Preserve last usable timestamps during temporary file/read errors.
    state.accounts[account.id]={...previous,...result.current};
    add(result.event);
    if (previous && /failure|unavailable|overdue|expired|required/.test(previous.status??'') && !/failure|unavailable|overdue|expired|required/.test(result.current.status) && result.event?.kind!=='success') {
      add({key:`${account.id}:recovered:${result.current.lastRefresh}`,accountId:account.id,kind:'notice',reason:'metadata_recovered_not_proof_of_auth',at:iso(now),expiresAt:result.current.expiresAt});
    }
  }
  state.checkedAt=iso(now);state.serviceStatus=service;
  save(config.stateFile,state);
  if (config.notification) {
    try {await deliver(config,state);state.notificationStatus=state.deliveryBatch?'scheduled_pending_queue':'idle_or_queued';}
    catch {state.notificationStatus='retry_pending';console.error(JSON.stringify({event:'auth_monitor_notification_deferred',at:iso(now)}));}
  }
  // Bound journaled history; retain undelivered alerts and recent dedup keys.
  const completed=state.events.filter(x=>x.delivery);
  if(completed.length>100) {
    const remove=new Set(completed.slice(0,-100).map(x=>x.key));
    state.reported=[...new Set([...state.reported,...remove])].slice(-1000);
    state.events=state.events.filter(x=>!remove.has(x.key));
  }
  save(config.stateFile,state);
  console.log(JSON.stringify({event:'auth_monitor_checked',at:state.checkedAt,service,accounts:Object.fromEntries(Object.entries(state.accounts).map(([id,a])=>[id,a.status])),pending:state.events.filter(x=>!x.delivery).length}));
  return state;
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {await run(readJson(process.argv[2]));}
  catch {console.error(JSON.stringify({event:'auth_monitor_failed',at:iso(Date.now()),reason:'local_check_failed'}));process.exitCode=1;}
}
