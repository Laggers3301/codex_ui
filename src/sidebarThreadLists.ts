import { useEffect, useState } from "react";
import { listThreads } from "./api";
import type { ThreadSummary } from "./types";
import {sidebarVisibilityEvent,sidebarHiddenKey,sidebarVisibilityVersion,visibleSidebarThreads,reconcileSidebarVisibility} from './sidebarVisibility';

type SidebarLists = {
  userId: string;
  lists: Record<string, ThreadSummary[]>;
  loading: Record<string, boolean>;
  errors: Record<string, string>;
};

// Expanding a workspace must load its list without activating that workspace
// or touching the active conversation/composer. localStorage is a warm cache,
// not the authoritative source for non-selected workspaces.
export function useSidebarThreadLists(
  userId: string,
  projectIds: string[],
  expandedProjectIds: string[],
  selectedProjectId: string
) {
  const [state, setState] = useState<SidebarLists>(() => ({ userId, lists: {}, loading: {}, errors: {} }));
  const [revision, setRevision] = useState(0);
  useEffect(()=>{
    const changed=()=>{
      setState(value=>({...value,lists:Object.fromEntries(Object.entries(value.lists).map(([id,rows])=>[id,visibleSidebarThreads(userId,rows)]))}));
      setRevision(value=>value+1);
    };
    const local=(event:Event)=>{if((event as CustomEvent).detail?.userId===userId)changed();};
    const remote=(event:StorageEvent)=>{if(event.key===sidebarHiddenKey(userId))changed();};
    window.addEventListener(sidebarVisibilityEvent,local);window.addEventListener('storage',remote);
    return()=>{window.removeEventListener(sidebarVisibilityEvent,local);window.removeEventListener('storage',remote);};
  },[userId]);
  const available = new Set(projectIds);
  const key = JSON.stringify(expandedProjectIds.filter(id => available.has(id) && id !== selectedProjectId));

  useEffect(() => {
    const ids = JSON.parse(key) as string[];
    let cancelled = false;
    const update = (fn: (value: SidebarLists) => SidebarLists) => {
      if (!cancelled) setState(value => fn(value.userId === userId ? value : { userId, lists: {}, loading: {}, errors: {} }));
    };
    update(value => ({ ...value, loading: Object.fromEntries(ids.map(id => [id, true])), errors: {} }));
    let next = 0;
    const worker = async () => {
      while (!cancelled && next < ids.length) {
        const projectId = ids[next++];
        try {
          const requestedAt=Date.now();
          const visibilityVersion=sidebarVisibilityVersion(userId,projectId);
          const response = await listThreads(projectId);
          if (cancelled) return;
          if(visibilityVersion!==sidebarVisibilityVersion(userId,projectId))continue;
          const data=reconcileSidebarVisibility(userId,projectId,response.data,response.hiddenThreadIds,requestedAt);
          update(value => ({ ...value, lists: { ...value.lists, [projectId]: data }, loading: { ...value.loading, [projectId]: false } }));
          try { window.localStorage.setItem(`codex-v2-threads-${userId}-${projectId}`, JSON.stringify(data)); } catch { /* A full browser cache must not hide server results. */ }
        } catch (error) {
          if (cancelled) return;
          update(value => ({ ...value, loading: { ...value.loading, [projectId]: false }, errors: { ...value.errors, [projectId]: error instanceof Error ? error.message : String(error) } }));
        }
      }
    };
    // Bound concurrency so a refresh with many expanded workspaces does not
    // flood the shared backend. Failures preserve existing cached rows.
    for (let i = 0; i < Math.min(3, ids.length); i++) void worker();
    return () => { cancelled = true; };
  }, [userId, key, revision]);

  return {
    lists: state.userId === userId ? state.lists : {},
    loading: state.userId === userId ? state.loading : {},
    errors: state.userId === userId ? state.errors : {},
    refresh: () => setRevision(value => value + 1)
  };
}
