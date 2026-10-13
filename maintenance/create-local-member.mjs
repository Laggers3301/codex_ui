// Provision only the requested local Web login; never reset existing passwords
// or copy user credentials to another machine. Password is entered via stdin.
import fs from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const [username] = process.argv.slice(2);
if (!username || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(username)) throw Error('Invalid member username');
const root = new URL('../', import.meta.url).pathname;
const file = root + 'data/auth/member-passwords.json';
const db = new DatabaseSync(root + 'data/backend/codex-web.sqlite');
db.exec('PRAGMA busy_timeout=8000');
let password = '';
for await (const chunk of process.stdin) password += chunk;
password = password.trimEnd();
if (!password) throw Error('Password required via stdin');
const before = fs.readFileSync(file, 'utf8');
const auth = JSON.parse(before);
if (auth.users?.[username] || db.prepare('SELECT id FROM users WHERE id=?').get(username)) throw Error('Member already exists; not resetting credentials');
if (!auth.users || typeof auth.users !== 'object') throw Error('Invalid member database');
const now = new Date().toISOString(), salt = randomBytes(16).toString('hex');
const entry = { salt, hash: scryptSync(password, salt, 64).toString('hex'), createdAt: now, updatedAt: now };
const backupDir = root + 'data/auth/member-provision-backups';
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const backup = backupDir + '/' + username + '-' + Date.now() + '.json';
fs.writeFileSync(backup, JSON.stringify({ username, createdAt: now, previouslyPresent: false }), { mode: 0o600, flag: 'wx' });
const temp = file + '.member-' + process.pid + '.tmp';
auth.users[username] = entry;
db.exec('BEGIN IMMEDIATE');
try {
  db.prepare('INSERT INTO users (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(username, username, now, now);
  fs.writeFileSync(temp, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  if (fs.readFileSync(file, 'utf8') !== before) throw Error('Member database changed concurrently; retry safely');
  fs.renameSync(temp, file);
  db.exec('COMMIT');
  console.log(JSON.stringify({ created: true, username, host: 'local-account-pool', servicesRestarted: false }));
} catch (error) {
  db.exec('ROLLBACK');
  // Preserve unrelated concurrent edits when removing just our new entry.
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (current.users?.[username]?.hash === entry.hash) {
    delete current.users[username];
    fs.writeFileSync(temp, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  if (fs.existsSync(temp)) fs.unlinkSync(temp);
  throw error;
} finally { db.close(); password = ''; }
