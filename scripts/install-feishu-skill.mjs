import path from "node:path";
import { fileURLToPath } from "node:url";
import { installDocumentAuthoringSkill } from "./install-document-authoring-skill.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.some(a => a !== "--dry-run")) throw new Error("Usage: node scripts/install-feishu-skill.mjs [--dry-run]");
console.log(JSON.stringify({ skill: "feishu-office", runtimes: installDocumentAuthoringSkill({ name: "feishu-office", source: path.join(root, "skills/feishu-office"), poolFile: path.join(root, "account-pool.json"), dryRun: args.includes("--dry-run") }) }, null, 2));
