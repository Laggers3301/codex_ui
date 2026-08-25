import { DatabaseSync } from "node:sqlite";

const databasePath = process.argv[2];
if (!databasePath) {
  throw new Error("database path is required");
}

const database = new DatabaseSync(databasePath, { readOnly: true });
const tables = database
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((row) => String(row.name));

for (const table of tables) {
  const escapedTable = table.replaceAll("'", "''");
  const columns = database.prepare(`PRAGMA table_info('${escapedTable}')`).all().map((row) => ({
    name: String(row.name),
    type: String(row.type),
    primaryKey: Number(row.pk) > 0,
  }));
  const quotedTable = `"${table.replaceAll('"', '""')}"`;
  const count = Number(database.prepare(`SELECT COUNT(*) AS count FROM ${quotedTable}`).get().count);
  console.log(JSON.stringify({ table, count, columns }));
}

database.close();
