import type {ModelProfile} from "./types";

const rank:Record<string,number>={ultra:0,max:1,xhigh:2,high:3,medium:4,low:5};
export function effortDescending(a:string,b:string){return (rank[a]??99)-(rank[b]??99);}

/** Keep model groups in catalogue order; order only their effort variants. */
export function profilesByDescendingEffort(profiles:ModelProfile[]):ModelProfile[]{
  const groups=new Map<string,ModelProfile[]>();
  for(const profile of profiles){const group=groups.get(profile.model)??[];group.push(profile);groups.set(profile.model,group);}
  return [...groups.values()].flatMap(group=>[...group].sort((a,b)=>effortDescending(a.effort,b.effort)));
}
