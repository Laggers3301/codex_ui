import type {ThreadSummary} from './types';
export const sidebarVisibilityEvent='codex:sidebar-visibility';
export const sidebarHiddenKey=(userId:string)=>`codex-sidebar-hidden-${userId}`;
export function sidebarVisibilityVersion(userId:string,projectId:string) {try{return Number(window.localStorage.getItem(`codex-sidebar-revision-${userId}-${projectId}`)??0);}catch{return 0;}}
function hidden(userId:string):Record<string,string> {
  try{return JSON.parse(window.localStorage.getItem(sidebarHiddenKey(userId))??'{}');}catch{return {};}
}
export function visibleSidebarThreads(userId:string,rows:ThreadSummary[]) {
  const removed=hidden(userId);return rows.filter(row=>!removed[row.id]);
}
export function setSidebarThreadHidden(userId:string,projectId:string,threadId:string,hide:boolean) {
  const removed=hidden(userId);if(hide)removed[threadId]=`${projectId}|${Date.now()}`;else delete removed[threadId];
  try{
    window.localStorage.setItem(`codex-sidebar-revision-${userId}-${projectId}`,String(sidebarVisibilityVersion(userId,projectId)+1));
    window.localStorage.setItem(sidebarHiddenKey(userId),JSON.stringify(removed));
    const key=`codex-v2-threads-${userId}-${projectId}`;
    const cache=JSON.parse(window.localStorage.getItem(key)??'[]') as ThreadSummary[];
    window.localStorage.setItem(key,JSON.stringify(visibleSidebarThreads(userId,cache)));
  }catch{/* Storage errors must not prevent the live-list invalidation. */}
  window.dispatchEvent(new CustomEvent(sidebarVisibilityEvent,{detail:{userId,projectId,threadId,hide}}));
}

export function reconcileSidebarVisibility(userId:string,projectId:string,rows:ThreadSummary[],hiddenIds:string[]=[],requestedAt=Date.now()) {
  const removed=hidden(userId);let changed=false;
  for(const id of hiddenIds)if(!removed[id]){removed[id]=`${projectId}|${requestedAt}`;changed=true;}
  for(const row of rows){
    const timestamp=Number(removed[row.id]?.split('|').at(-1));
    if(removed[row.id]&&!hiddenIds.includes(row.id)&&(!Number.isFinite(timestamp)||timestamp<requestedAt)){delete removed[row.id];changed=true;}
  }
  if(changed)try{window.localStorage.setItem(sidebarHiddenKey(userId),JSON.stringify(removed));}catch{}
  return visibleSidebarThreads(userId,rows);
}
