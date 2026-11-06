import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const responseLanguageInstructions=[
 '## 默认回复语言 / Default response language',
 '',
 '- 主代理及所有层级的子代理默认以简体中文撰写用户可见的说明、进度、结论、任务汇报和协作消息；不因模型、子任务描述或参考资料使用英文而切换回复语言。',
 '- 创建子代理或交接任务时，应携带此语言约定，包括不继承父会话历史的子代理。',
 '- 用户明确指定其他语言时按用户要求；代码、命令、路径、标识符、模型名、必要英文术语、原文引用和原始工具日志保留原样，不为统一语言改写它们。',
 '- 用户未要求双语时，不要先输出英文进度再翻译一遍；将子代理结果整理成一次中文汇报，不直接粘贴其英文叙述。',
 '- This applies to the root agent and every subagent, including fresh/no-history forks: use Simplified Chinese for explanations, progress, summaries and collaboration messages by default. An English task description is not a request for an English reply. Honor an explicit user language request and preserve code, identifiers, essential terms and raw logs.'
].join('\n');

export const responseStyleInstructions = [
  '## 对话输出：递归自包含，结论优先',
  '',
  '- 对话回答默认使用递归自包含的分级列表：第一层直接给出结论或结果，每个父项本身概括下层的核心信息，而不是只写“背景／分析／建议”等空标题。读者只看外层也能获得关键结论，展开内层才需阅读依据、细节和操作。通常两层，必要时三层；能用一句话答清的问题直接简答，不强行分级。',
  '- 每项只表达一个主要意思，使用短句、具体事实和明确动作。先回答当前问题，再提供影响判断的依据；不复述要求，不重复父项，不为排版增加篇幅，不把同一事实拆成冗长清单。',
  '- 去掉套话、自我辩解、无关免责声明、反复的否定铺垫和防御性措辞，不反复使用“不能保证／只能说／不是……而是……”替代直接回答。影响决定的不确定性、权限边界或危险操作后果只在相关处简短说明一次；未核实的事实和未完成的工作如实标明，不编造确定性。',
  '- 以上仅约束对话中的解释、进度与回答，不强套到代码、命令、日志、论文、邮件、演示文稿等交付内容；交付物按用途和用户指定格式。用户明确要求其他格式或详细说明时，按当前要求；交接子代理时携带此表达约定。'
].join('\n');

/** Native Claude user memory, preserving existing instructions and file mode. */
export function ensureClaudeResponseStyle(configRoot) {
  const file=path.join(configRoot,'CLAUDE.md');
  let old='',mode=0o600;
  try {const st=fs.lstatSync(file);if(!st.isFile()||st.size>256*1024)throw Error('Invalid Claude instructions file');old=fs.readFileSync(file,'utf8');mode=st.mode&0o777;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const start='<!-- codex-web:response-style:start -->',end='<!-- codex-web:response-style:end -->';
  if(old.includes(start)!==old.includes(end))throw Error('Incomplete managed response-style block');
  const body=old.replace(new RegExp(`${start}[\\s\\S]*?${end}(?:\\r?\\n){0,2}`,'g'),'');
  const next=`${start}\n${responseLanguageInstructions}\n\n${responseStyleInstructions}\n${end}\n\n${body}`;
  if(next===old)return false;
  const temporary=`${file}.style-${randomUUID()}`;
  try{fs.writeFileSync(temporary,next,{flag:'wx',mode});fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return true;
}
