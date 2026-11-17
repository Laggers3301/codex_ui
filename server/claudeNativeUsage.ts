import {nativeClaudeQuery} from './claudeRuntime.js';
import type {ClaudeBinding} from './claudeBindings.js';
import type {ReclaudeUsageWindow} from '../shared/reclaudeUsage.js';

function resetTime(text:string,now:number):number|null {
  const match=text.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)$/i);
  if(!match)return null;
  const month=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(match[1].toLowerCase());
  const day=Number(match[2]),hour=Number(match[3]),minute=Number(match[4]??0);
  if(month<0||day<1||day>31||hour<1||hour>12||minute>59)return null;
  try{
    const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:match[6],year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
    const parts=(at:number)=>Object.fromEntries(formatter.formatToParts(at).map(p=>[p.type,p.value]));
    const currentYear=Number(parts(now).year),h=hour%12+(match[5].toLowerCase()==='pm'?12:0);
    for(const year of [currentYear,currentYear+1]){
      const calendar=Date.UTC(year,month,day,h,minute);
      let at=calendar;
      for(let i=0;i<3;i++){const p=parts(at);const local=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));at+=calendar-local;}
      const p=parts(at);
      if(Number(p.month)===month+1&&Number(p.day)===day&&Number(p.hour)===h&&Number(p.minute)===minute&&at>now&&at-now<=8*86400000)return at;
    }
  }catch{/* Unrecognized timezone/date: retain unknown reset rather than guess. */}
  return null;
}

/** Trusted text emitted by the unmodified CLI's local /usage command only. */
export function parseNativeClaudeUsage(text:string,now=Date.now()):ReclaudeUsageWindow[]{
  const windows:ReclaudeUsageWindow[]=[];
  for(const line of text.split('\n')){
    const match=line.trim().match(/^(Current session|Current week \(([^)]+)\)):\s*(\d+(?:\.\d+)?)% used(?:\s*[·•]\s*resets\s+(.+))?$/);
    if(!match)continue;
    const percent=Number(match[3]);if(percent<0||percent>100)continue;
    const scope=match[2]?.toLowerCase();
    const kind=match[1]==='Current session'?'five_hour':scope==='all models'?'seven_day':scope&&/^[a-z0-9 -]+$/.test(scope)?`seven_day_${scope.replace(/[ -]+/g,'_')}`:null;
    if(kind)windows.push({kind,percent,observedAt:now,resetsAt:match[4]?resetTime(match[4],now):null,source:'native-command'});
  }
  return windows;
}

export async function readNativeClaudeUsage(binding:ClaudeBinding):Promise<string>{
  if(!binding.privateHome||!binding.nativeUsageEnabled)throw new Error('Native usage query is not enabled for this private binding');
  const env={...process.env,HOME:binding.privateHome,RECLAUDE_ORG:binding.orgId,CLAUDE_CONFIG_DIR:binding.configRoot,CLAUDE_CODE_DISABLE_WORKFLOWS:'1'};
  for(const key of Object.keys(env))if(/^(?:CODEX_WEB_|OPENAI_|ARK_|MIMO_|ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$)/.test(key))delete (env as NodeJS.ProcessEnv)[key];
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
  let stream:Awaited<ReturnType<typeof nativeClaudeQuery>>|undefined;
  try{
    stream=await nativeClaudeQuery('/usage',{cwd:binding.workspaceRoot,env,model:'opus',pathToClaudeCodeExecutable:binding.executable,
      settingSources:[],tools:[],maxTurns:1,maxBudgetUsd:0.000001,persistSession:false,abortController:controller});
    for await(const item of stream){
      const row=item as any;
      if(row.type==='result'){
        if(row.subtype!=='success'||row.is_error||row.total_cost_usd!==0||typeof row.result!=='string'||!parseNativeClaudeUsage(row.result).some(w=>w.kind==='seven_day'))throw new Error('Native usage response unavailable');
        return row.result;
      }
    }
    throw new Error('Native usage response missing');
  }finally{clearTimeout(timer);stream?.close();controller.abort();}
}
