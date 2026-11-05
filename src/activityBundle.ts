import type {ThreadItem} from './types';

export function activityBundleSummary(items:ThreadItem[]) {
  const tools=items.filter(item=>!/reasoning|thinking/i.test(String(item.type)));
  const calls=tools.filter(item=>String(item.type).toLowerCase()==='toolcall');
  const names=[...new Set(calls.map(item=>String(item.tool??'').trim()).filter(Boolean))];
  return {
    hasTools:tools.length>0,
    bundle:tools.length>0||items.length>1,
    count:tools.length ? (calls.length||tools.length) : items.length,
    toolLabel:names.length===1?names[0]:names.length>1?'工具':'tool'
  };
}
