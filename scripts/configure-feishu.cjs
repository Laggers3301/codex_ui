// Administrator-only local setup. Never accepts secrets in command arguments.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const root = path.resolve(__dirname, '..');
const file = process.env.FEISHU_CONFIG_FILE || path.join(root, 'data/backend/feishu/application.json');
let masked = false;
const output = new Writable({ write(chunk, encoding, done) { if (!masked) process.stdout.write(chunk, encoding); done(); } });
const rl = readline.createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
const ask = label => new Promise(resolve => rl.question(label, value => resolve(value.trim())));
async function main() {
  if (!process.stdin.isTTY) throw new Error('请在管理员的交互终端运行，不接受管道传入密钥。');
  console.log('飞书应用一次性配置；普通用户以后只需点击授权。密钥不会显示或写入聊天。');
  const appId = await ask('App ID: ');
  process.stdout.write('App Secret（隐藏输入）: '); masked = true;
  const appSecret = await ask(''); masked = false; process.stdout.write('\n');
  const redirectUri = (await ask('回调地址 [https://codex.example.com/api/feishu/callback]: ')) || 'https://codex.example.com/api/feishu/callback';
  const scopes = (await ask('已批准的 OAuth 权限范围（空格分隔；回车先启用文档）: ')) || 'offline_access docx:document docx:document:readonly contact:user.base:readonly';
  const botMessagingEnabled = (await ask('启用机器人群消息？需已开启机器人、批准消息权限并加到目标群 [y/N]: ')).toLowerCase() === 'y';
  if (!/^cli_[A-Za-z0-9_-]+$/.test(appId) || !appSecret || new URL(redirectUri).protocol !== 'https:' || /[\r\n]/.test(scopes)) throw new Error('应用配置格式不正确，未保存。');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    const answer = await ask('已有配置。确认替换？输入 yes: '); if (answer !== 'yes') { console.log('已取消，保留原配置。'); return; }
  }
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ appId, appSecret, redirectUri, scopes, botMessagingEnabled }), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file);
  console.log(`已保存私有配置：${file}\n请在飞书后台配置同一回调地址，发布并批准应用权限，再到插件 → 飞书办公连接。`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => rl.close());
