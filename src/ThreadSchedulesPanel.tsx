import { useEffect, useState } from "react";
import { Clock, Edit, Trash, Pause, Play, Plus, X } from "./PanelIcons";
import { createThreadSchedule, deleteThreadSchedule, updateThreadSchedule, type ScheduleDraft, type ScheduleKind, type ThreadSchedule } from "./threadSchedules";
import "./threadSchedules.css";

type Controller = ReturnType<typeof import("./threadSchedules").useThreadSchedules>;
const kinds: Array<[ScheduleKind, string]> = [["once", "指定时间"], ["interval", "间隔"], ["daily", "每天"], ["weekdays", "工作日"], ["weekly", "每周"]];
const weekdays = [[1,"周一"],[2,"周二"],[3,"周三"],[4,"周四"],[5,"周五"],[6,"周六"],[0,"周日"]] as const;
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const scheduleDate = new Intl.DateTimeFormat("zh-CN", {month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false});
const runStatus: Record<string, string> = {dispatching:"正在启动",queued:"已提交",completed:"已完成",failed:"失败",skipped:"合并跳过（上一轮未结束）"};
const dateLocal = (value?: string) => { if (!value || !Number.isFinite(Date.parse(value))) return ""; const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16); };
export const scheduleStatusLabel = (s: ThreadSchedule) => s.status === "failed" || s.lastRunStatus === "failed" ? "上次失败" : s.status === "completed" ? "已完成" : s.status === "dispatching" ? "正在启动" : s.status === "queued" ? "已提交" : s.status === "paused" || !s.enabled ? "已暂停" : "已启用";
const nextLabel = (s: ThreadSchedule) => !s.enabled ? "无后续运行" : s.nextRunAt ? `下次 ${scheduleDate.format(new Date(s.nextRunAt))}` : "等待调度";
export function ThreadSchedules({ controller, initialScheduleId, onClose }: { controller: Controller; initialScheduleId?: string | null; onClose: () => void }) {
  const [selected, setSelected] = useState<string | null>(initialScheduleId ?? null);
  const [draft, setDraft] = useState<ScheduleDraft>(() => blankDraft());
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmClosing, setConfirmClosing] = useState(false);
  const existing = controller.schedules.find(x => x.id === selected);
  useEffect(() => {
    setSelected(initialScheduleId ?? null);
    if (!initialScheduleId) setDraft(blankDraft());
  }, [initialScheduleId]);
  useEffect(() => {
    setDraft(existing ? toDraft(existing) : blankDraft());
  }, [selected, existing?.id]);
  const set = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) => setDraft(d => ({...d,[key]:value}));
  const setSchedule = (value: Partial<ScheduleDraft["schedule"]>) => setDraft(d => ({...d,schedule:{...d.schedule,...value}}));
  const save = async () => {
    setSaving(true); controller.setError("");
    try {
      const payload = { title: draft.title.trim(), prompt: draft.prompt.trim(), enabled: existing?.enabled ?? draft.enabled, schedule: cleanSchedule(draft.schedule) };
      const saved = existing ? await updateThreadSchedule(controller.projectId, controller.threadId, existing.id, payload) : await createThreadSchedule(controller.projectId, controller.threadId, payload);
      await controller.refresh(); setSelected(saved.id);
    } catch (e) { controller.setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  const toggle = async (s: ThreadSchedule) => {
    try { await updateThreadSchedule(controller.projectId, controller.threadId, s.id, {enabled:!s.enabled}); await controller.refresh(); }
    catch(e) { controller.setError(e instanceof Error ? e.message : String(e)); }
  };
  const remove = async (id: string) => {
    try { await deleteThreadSchedule(controller.projectId, controller.threadId, id); await controller.refresh(); setSelected(null); closeDelete(); }
    catch(e) { controller.setError(e instanceof Error ? e.message : String(e)); }
  };
  const newDraft = () => { setSelected(null); setDraft(blankDraft()); controller.setError(""); };
  const closeDelete = () => { setConfirmClosing(true); window.setTimeout(() => { setConfirmDelete(null); setConfirmClosing(false); }, 210); };
  const validOnce = draft.schedule.kind !== "once" || Boolean(draft.schedule.at && Number.isFinite(Date.parse(draft.schedule.at)) && Date.parse(draft.schedule.at) > Date.now());
  return <section className="threadSchedulesPanel" aria-label="定时任务">
    <header className="threadSchedulesHeader"><div><span className="threadSchedulesTitleIcon"><Clock size={17}/></span><strong>定时任务</strong></div><button type="button" className="threadScheduleIconButton" onClick={onClose} aria-label="关闭"><X size={16}/></button></header>
    <p className="threadSchedulesNotice">在此聊天中继续运行。关闭网页后仍会计时，服务器需保持在线。</p>
    {controller.loading ? <div className="threadScheduleEmpty">正在载入…</div> : controller.schedules.length ? <div className="threadScheduleList">{controller.schedules.map(s => <article className={`threadScheduleCard${selected===s.id?" selected":""}`} key={s.id}>
      <button className="threadScheduleMain" type="button" onClick={() => {setSelected(s.id); controller.setError("");}}><span className={`threadScheduleDot${!s.enabled ? " paused" : ""}${s.status === "failed" || s.lastRunStatus === "failed" ? " failed" : ""}`}/><span className="threadScheduleCardText"><strong>{s.title || "未命名任务"}</strong><small>{scheduleStatusLabel(s)} · {nextLabel(s)}</small></span></button>
      <div className="threadScheduleActions"><button type="button" className="threadScheduleIconButton" title={s.enabled?"暂停":"恢复"} aria-label={s.enabled?"暂停":"恢复"} onClick={() => void toggle(s)}>{s.enabled?<Pause size={15}/>:<Play size={15}/>}</button><button type="button" className="threadScheduleIconButton" title="编辑" aria-label="编辑" onClick={() => {setSelected(s.id);controller.setError("");}}><Edit size={15}/></button></div>
      {(s.lastRunError || s.lastError) ? <small className="threadScheduleErrorHint" title={s.lastRunError || s.lastError || ""}>最近错误：{s.lastRunError || s.lastError}</small> : null}
    </article>)}</div> : <div className="threadScheduleEmpty">此聊天还没有定时任务。</div>}
    <button type="button" className="threadScheduleNew" onClick={newDraft}><Plus size={15}/>新建定时任务</button>
    {controller.error ? <p className="threadScheduleError" role="alert">{controller.error}</p> : null}
    <div className="threadScheduleEditor">
      <div className="threadScheduleEditorHeading"><strong>{existing?"编辑任务":"新建任务"}</strong>{existing?<button type="button" className="threadScheduleIconButton" aria-label="删除任务" onClick={() => setConfirmDelete(existing.id)}><Trash size={15}/></button>:null}</div>
      <label>任务名称<input value={draft.title} maxLength={120} onChange={e=>set("title",e.target.value)} placeholder="例如：整理本周进展"/></label>
      <label>发送给 Codex 的内容<textarea rows={4} maxLength={20000} spellCheck={false} value={draft.prompt} onChange={e=>set("prompt",e.target.value)} placeholder="描述届时要完成的任务"/></label>
      <label>频率<select value={draft.schedule.kind} onChange={e=>setSchedule({kind:e.target.value as ScheduleKind, intervalMinutes: draft.schedule.intervalMinutes ?? 60, time: draft.schedule.time ?? "09:00", at: draft.schedule.at ?? new Date(Date.now()+3600000).toISOString()})}>{kinds.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
      {draft.schedule.kind === "once" ? <label>日期和时间<input type="datetime-local" min={dateLocal(new Date().toISOString())} value={dateLocal(draft.schedule.at)} onChange={e=>setSchedule({at:Number.isFinite(Date.parse(e.target.value))?new Date(e.target.value).toISOString():undefined})}/></label> : null}
      {draft.schedule.kind === "interval" ? <label>每隔<input className="threadScheduleNumber" type="number" min={5} max={525600} value={draft.schedule.intervalMinutes ?? 60} onChange={e=>setSchedule({intervalMinutes:Number(e.target.value)})}/><span className="threadScheduleSuffix">分钟（最少 5 分钟）</span></label> : null}
      {draft.schedule.kind !== "once" && draft.schedule.kind !== "interval" ? <>
        <label>开始时间<input type="time" value={draft.schedule.time ?? "09:00"} onChange={e=>setSchedule({time:e.target.value})}/></label>
        {draft.schedule.kind === "weekly" ? <fieldset className="threadScheduleWeekdays"><legend>星期</legend>{weekdays.map(([n,l])=><label key={n}><input type="checkbox" checked={draft.schedule.weekdays?.includes(n) ?? false} onChange={e=>setSchedule({weekdays:e.target.checked?[...(draft.schedule.weekdays??[]),n].sort((a,b)=>a-b):(draft.schedule.weekdays??[]).filter(x=>x!==n)})}/>{l}</label>)}</fieldset> : null}
      </> : null}
      <small className="threadScheduleTimezone">使用本地时区：{draft.schedule.timezone}</small>
      <p className="threadSchedulesNotice threadScheduleRunNotice">到点后使用当前上下文继续；若正在回答则等待空闲，不打断。暂停或删除不会撤回已提交的轮次。</p>
      {!validOnce && <p className="threadScheduleError">请选择未来的日期和时间。</p>}
      <div className="threadScheduleSaveRow"><button type="button" className="threadScheduleSave" disabled={saving || !draft.title.trim() || !draft.prompt.trim() || !validOnce || (draft.schedule.kind === "interval" && !(Number(draft.schedule.intervalMinutes)>=5)) || (draft.schedule.kind === "weekly" && !draft.schedule.weekdays?.length)} onClick={()=>void save()}>{saving?"保存中…":"保存"}</button>{existing?<button type="button" className="threadScheduleCancel" onClick={newDraft}>新建</button>:null}</div>
      {(existing?.history?.length || existing?.lastRunError || existing?.lastError) ? <details className="threadScheduleRunDetails"><summary>最近运行详情</summary>{existing.history?.slice(-3).reverse().map((run,i)=><p key={i}>{run.scheduledAt || run.startedAt ? scheduleDate.format(new Date(run.scheduledAt || run.startedAt!)) : "最近运行"} · {runStatus[run.status] ?? run.status}{run.error?`：${run.error}`:""}{run.warning?`：${run.warning}`:""}</p>)}{!existing.history?.length ? <p>{existing.lastRunError || existing.lastError}</p> : null}</details> : null}
    </div>
    {confirmDelete ? <div className={`threadScheduleConfirm${confirmClosing?" closing":""}`} role="group" aria-label="确认删除"><span>删除此定时任务？此操作无法撤销。</span><div><button type="button" onClick={closeDelete}>取消</button><button type="button" className="danger" onClick={()=>void remove(confirmDelete)}>删除</button></div></div>:null}
  </section>;
}

function blankDraft(): ScheduleDraft { return {title:"",prompt:"",enabled:true,schedule:{kind:"once",at:new Date(Date.now()+3600000).toISOString(),timezone}}; }
function toDraft(s: ThreadSchedule): ScheduleDraft { return {title:s.title,prompt:s.prompt,enabled:s.enabled,schedule:{...s.schedule}}; }
function cleanSchedule(schedule: ScheduleDraft["schedule"]): ScheduleDraft["schedule"] {
  const common = {kind:schedule.kind,timezone:schedule.timezone};
  if (schedule.kind === "once") return {...common,at:schedule.at};
  if (schedule.kind === "interval") return {...common,intervalMinutes:schedule.intervalMinutes ?? 60};
  if (schedule.kind === "weekly") return {...common,time:schedule.time ?? "09:00",weekdays:schedule.weekdays ?? []};
  return {...common,time:schedule.time ?? "09:00"};
}

export function threadScheduleSummary(s: ThreadSchedule): string { return `${scheduleStatusLabel(s)} · ${nextLabel(s)}`; }
