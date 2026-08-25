import { DatabaseSync } from "node:sqlite";

const [webDatabasePath, stateDatabasePath] = process.argv.slice(2);
if (!webDatabasePath || !stateDatabasePath) {
  throw new Error("usage: analyze-session-attribution.mjs <codex-web.sqlite> <state.sqlite>");
}

class UnionFind {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }

  find(id) {
    const parent = this.parent.get(id);
    if (!parent) {
      this.parent.set(id, id);
      return id;
    }
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }
}

const web = new DatabaseSync(webDatabasePath, { readOnly: true });
const state = new DatabaseSync(stateDatabasePath, { readOnly: true });
const users = new Set(web.prepare("SELECT id FROM users").all().map((row) => String(row.id)));
const ownerRows = web.prepare("SELECT thread_id, user_id FROM thread_owners").all();
const threadRows = state.prepare(`
  SELECT id, cwd, created_at, created_at_ms, source, thread_source, agent_role,
         git_origin_url, has_user_event
  FROM threads
`).all();
const edgeRows = state.prepare("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges").all();
const threadIds = new Set(threadRows.map((row) => String(row.id)));
for (const row of ownerRows) threadIds.add(String(row.thread_id));
for (const row of edgeRows) {
  threadIds.add(String(row.parent_thread_id));
  threadIds.add(String(row.child_thread_id));
}

const embeddedEdges = [];
for (const row of threadRows) {
  const candidates = [row.source, row.thread_source];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate);
      const parentThreadId = parsed?.subagent?.thread_spawn?.parent_thread_id;
      if (typeof parentThreadId === "string" && parentThreadId.trim()) {
        embeddedEdges.push({ parent_thread_id: parentThreadId.trim(), child_thread_id: String(row.id) });
        threadIds.add(parentThreadId.trim());
      }
    } catch {
      // Ignore older non-JSON source labels.
    }
  }
}

const unionFind = new UnionFind([...threadIds]);
for (const row of edgeRows) unionFind.union(String(row.parent_thread_id), String(row.child_thread_id));
for (const row of embeddedEdges) unionFind.union(row.parent_thread_id, row.child_thread_id);

const seeds = new Map();
const evidenceCounts = { owner: 0, cwd: 0 };
function addSeed(threadId, userId, evidence) {
  if (!users.has(userId)) return;
  let labels = seeds.get(threadId);
  if (!labels) {
    labels = new Map();
    seeds.set(threadId, labels);
  }
  labels.set(userId, evidence);
  evidenceCounts[evidence] += 1;
}

for (const row of ownerRows) addSeed(String(row.thread_id), String(row.user_id), "owner");
for (const row of threadRows) {
  const cwd = typeof row.cwd === "string" ? row.cwd : "";
  const match = cwd.match(/\/codex_zerotier_remote\/users\/([^/]+)/);
  if (match) addSeed(String(row.id), decodeURIComponent(match[1]), "cwd");
}

const componentLabels = new Map();
for (const [threadId, labels] of seeds) {
  const root = unionFind.find(threadId);
  let usersForComponent = componentLabels.get(root);
  if (!usersForComponent) {
    usersForComponent = new Set();
    componentLabels.set(root, usersForComponent);
  }
  for (const userId of labels.keys()) usersForComponent.add(userId);
}

const attributed = new Map();
const conflicts = new Map();
for (const threadId of threadIds) {
  const labels = componentLabels.get(unionFind.find(threadId));
  if (!labels?.size) continue;
  if (labels.size === 1) attributed.set(threadId, [...labels][0]);
  else conflicts.set(threadId, [...labels].sort());
}

const byUser = {};
for (const userId of attributed.values()) byUser[userId] = (byUser[userId] ?? 0) + 1;
const stateAttributed = threadRows.filter((row) => attributed.has(String(row.id))).length;
const ownerIds = new Set(ownerRows.map((row) => String(row.thread_id)));
const propagatedBeyondOwner = [...attributed.keys()].filter((id) => !ownerIds.has(id)).length;
const cwdDistribution = {};
const sourceDistribution = {};
const dayDistribution = {};
const userEventDistribution = {};
for (const row of threadRows) {
  if (attributed.has(String(row.id))) continue;
  const cwd = typeof row.cwd === "string" && row.cwd ? row.cwd : "(empty)";
  cwdDistribution[cwd] = (cwdDistribution[cwd] ?? 0) + 1;
  const source = [row.source, row.thread_source, row.agent_role].filter(Boolean).join(" | ") || "(empty)";
  sourceDistribution[source] = (sourceDistribution[source] ?? 0) + 1;
  const timestamp = Number(row.created_at_ms ?? row.created_at ?? 0);
  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  const day = milliseconds > 0 ? new Date(milliseconds).toISOString().slice(0, 10) : "(unknown)";
  dayDistribution[day] = (dayDistribution[day] ?? 0) + 1;
  const userEventKey = String(Number(row.has_user_event ?? 0));
  userEventDistribution[userEventKey] = (userEventDistribution[userEventKey] ?? 0) + 1;
}

console.log(JSON.stringify({
  stateThreads: threadRows.length,
  owners: ownerRows.length,
  spawnEdges: edgeRows.length,
  embeddedSpawnEdges: embeddedEdges.length,
  evidenceCounts,
  attributedStateThreads: stateAttributed,
  propagatedBeyondOwner,
  unattributedStateThreads: threadRows.length - stateAttributed,
  conflictThreads: conflicts.size,
  attributedByUser: Object.fromEntries(Object.entries(byUser).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  unattributedCwdDistribution: Object.fromEntries(Object.entries(cwdDistribution).sort((a, b) => b[1] - a[1]).slice(0, 30)),
  unattributedSourceDistribution: Object.fromEntries(Object.entries(sourceDistribution).sort((a, b) => b[1] - a[1]).slice(0, 30)),
  unattributedDayDistribution: Object.fromEntries(Object.entries(dayDistribution).sort()),
  unattributedHasUserEvent: userEventDistribution,
}, null, 2));

web.close();
state.close();
