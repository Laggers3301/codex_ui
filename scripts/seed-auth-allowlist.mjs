import fs from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const [sourcePath, projectDbPath, destinationPath] = process.argv.slice(2);
if (!sourcePath || !projectDbPath || !destinationPath) {
  throw new Error("usage: seed-auth-allowlist.mjs <source-auth-json> <project-db> <destination-auth-json>");
}

function readUsers(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return value?.users && typeof value.users === "object" ? value.users : {};
}

const sourceUsers = readUsers(sourcePath);
const destinationUsers = readUsers(destinationPath);
const users = { ...sourceUsers, ...destinationUsers };
const database = new DatabaseSync(projectDbPath, { readOnly: true });
const knownUsers = database.prepare("SELECT id FROM users WHERE id <> 'admin' ORDER BY id").all().map((row) => String(row.id).trim()).filter(Boolean);
database.close();

const initialPassword = process.env.CODEX_WEB_DEFAULT_PASSWORD || "ls";
const now = new Date().toISOString();
let added = 0;
for (const username of knownUsers) {
  if (users[username]) continue;
  const salt = randomBytes(16).toString("hex");
  users[username] = {
    salt,
    hash: scryptSync(initialPassword, salt, 64).toString("hex"),
    createdAt: now,
    updatedAt: now,
  };
  added += 1;
}

fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
const temporary = `${destinationPath}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify({ users }, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, destinationPath);
fs.chmodSync(destinationPath, 0o600);
console.log(`Auth allowlist ready: ${knownUsers.length} known users, ${added} added.`);
