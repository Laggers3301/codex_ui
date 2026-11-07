import {reclaudeWindowActive,type ReclaudeUsageStatus} from '../shared/reclaudeUsage';

/** Five-hour remaining percentages are displayed as a sum, not a shared pool. */
export function claudeFiveHourRemaining(status:ReclaudeUsageStatus|null,now=Date.now()):number{
  return (status?.accounts??[]).reduce((sum,account)=>{
    if(account.state==='disabled')return sum;
    const window=account.windows.find(w=>w.kind==='five_hour'&&reclaudeWindowActive(w,now));
    return sum+(window&&Number.isFinite(window.percent)?Math.max(0,Math.min(100,100-window.percent)):0);
  },0);
}
