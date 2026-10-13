import path from "node:path";
import { fileURLToPath } from "node:url";
import { installDocumentAuthoringSkill } from "./install-document-authoring-skill.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--dry-run")) throw new Error("Usage: node scripts/install-scheduled-tasks-skill.mjs [--dry-run]");
const runtimes = installDocumentAuthoringSkill({ name: "scheduled-tasks", source: path.join(root, "skills/scheduled-tasks"), poolFile: path.join(root, "account-pool.json"), dryRun: args.includes("--dry-run") });
console.log(JSON.stringify({ skill: "scheduled-tasks", dryRun: args.includes("--dry-run"), runtimes }, null, 2));
