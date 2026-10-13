// Reuse for every deployed feature/fix. A version is marked read per user;
// republishing that same version does not make the dot reappear.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const version = process.argv[2];
const target = process.argv[3];
const notice = process.argv[4];
if (target && !['account', 'plugins'].includes(target)) throw new Error('Invalid update target');
if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(version ?? '')) throw new Error('Usage: node scripts/publish-ui-update.cjs <unique-release-version>');
const directory = path.resolve(__dirname, '../data/backend/ui-updates');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const temp = path.join(directory, `.release-${crypto.randomUUID()}.tmp`);
fs.writeFileSync(temp, JSON.stringify({ version, ...(target ? { targets: [target] } : {}), ...(notice ? { notice: notice.slice(0, 500) } : {}), publishedAt: new Date().toISOString() }), { mode: 0o600 });
fs.renameSync(temp, path.join(directory, 'release.json'));
console.log(JSON.stringify({ publishedUpdate: version }));
