import { DatabaseSync } from "node:sqlite";

const [databasePath] = process.argv.slice(2);
if (!databasePath) {
  throw new Error("codex-web database path is required");
}

const database = new DatabaseSync(databasePath, { readOnly: true });
const summary = database.prepare(`
  SELECT source, user_name, COUNT(*) AS count
  FROM (
    SELECT 'owner' AS source, COALESCE(u.name, o.user_id) AS user_name, o.thread_id
    FROM thread_owners o
    LEFT JOIN users u ON u.id = o.user_id
    UNION ALL
    SELECT 'deleted' AS source, COALESCE(u.name, d.user_id) AS user_name, d.thread_id
    FROM unuse d
    LEFT JOIN users u ON u.id = d.user_id
    WHERE NOT EXISTS (SELECT 1 FROM thread_owners o WHERE o.thread_id = d.thread_id)
  )
  GROUP BY source, user_name
  ORDER BY source, count DESC, user_name
`).all();

const totals = database.prepare(`
  SELECT
    (SELECT COUNT(*) FROM thread_owners) AS owners,
    (SELECT COUNT(DISTINCT thread_id) FROM unuse) AS deleted,
    (SELECT COUNT(DISTINCT thread_id) FROM unuse d
      WHERE NOT EXISTS (SELECT 1 FROM thread_owners o WHERE o.thread_id = d.thread_id)) AS deleted_only,
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM projects) AS projects
`).get();

console.log(JSON.stringify({ totals, summary }, null, 2));
database.close();
