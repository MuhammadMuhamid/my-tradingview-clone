import fs from "node:fs";
import path from "node:path";
import { pool, closePool } from "./pool";

const migrationCandidates = [
  path.join(__dirname, "migrations"),
  path.join(process.cwd(), "src", "db", "migrations"),
];
const MIGRATIONS_DIR = migrationCandidates.find((dir) => {
  try {
    return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).some((f) => f.endsWith(".sql"));
  } catch {
    return false;
  }
});

/** The exact migration set shipped with this build, in application order. */
export function requiredMigrationFiles(): string[] {
  if (!MIGRATIONS_DIR) {
    throw new Error(`No SQL migration directory found (checked: ${migrationCandidates.join(", ")})`);
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    // Ignore macOS AppleDouble files (._001_init.sql) and other hidden files.
    .filter((f) => !f.startsWith(".") && f.endsWith(".sql"))
    .sort();
}

/**
 * Applies pending .sql migrations in filename order, each inside its own
 * transaction, recording progress in schema_migrations. Idempotent — safe to
 * run on every boot.
 */
export async function migrate(): Promise<string[]> {
  const files = requiredMigrationFiles();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations"
  );
  const applied = new Set(rows.map((r) => r.filename));
  const newlyApplied: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR!, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file]
      );
      await client.query("COMMIT");
      newlyApplied.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}

if (require.main === module) {
  migrate()
    .then((applied) => {
      console.log(
        applied.length > 0
          ? `Applied: ${applied.join(", ")}`
          : "No pending migrations."
      );
      return closePool();
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
      return closePool();
    });
}
