// scriptc-sqlite/migrate: bring a database's tables up to date with the
// program. A program lists its schema changes in order, once and forever:
//
//   migrate(db, [
//     { name: "create notes", sql: "create table notes (id integer primary key, body text not null)" },
//     { name: "add tags", sql: "alter table notes add column tags text" },
//   ]);
//
// migrate() applies the changes this database has not had yet, each in
// its own transaction, and records them in a table named _migrations. It
// refuses to run when the list no longer matches what the database
// recorded: a change edited, renamed or reordered after it was applied, or
// a database that has changes this program does not know (a newer
// program wrote it). Works on any node:sqlite-shaped DatabaseSync, so the
// same program runs under Node.
import type { DatabaseSync } from "./sqlite.ts";

export interface Migration {
  /** Unique; never rename one that was applied. */
  name: string;
  /** SQL to run: one or more statements. */
  sql?: string;
  /** Or code, for a change SQL alone can't make. Its text isn't checked
   * for edits, only its name. */
  run?: (db: DatabaseSync) => void;
  /** false runs it outside a transaction, for statements SQLite refuses
   * inside one (`vacuum`, `pragma journal_mode`, `pragma foreign_keys`).
   * Default true. */
  transaction?: boolean;
}

export interface MigrateResult {
  /** Names applied by this call, in order. */
  applied: string[];
  /** Changes the database has now. */
  total: number;
}

/** A change that failed: `migration` is its name, `error` what it threw.
 * Its transaction was rolled back; the changes before it stay applied. */
export class MigrationError extends Error {
  migration: string;
  error: unknown;
  constructor(migration: string, error: unknown) {
    super(`migration "${migration}" failed: ${error instanceof Error ? error.message : String(error)}`);
    this.migration = migration;
    this.error = error;
  }
}

const TABLE = "_migrations";

/** FNV-1a over the UTF-16 code units, as hex: enough to notice an edit. */
function checksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function checksumOf(m: Migration): string {
  return m.sql !== undefined ? checksum(m.sql) : "code";
}

type Recorded = { name: string; checksum: string };

function check(migrations: Migration[]): void {
  const names = new Set<string>();
  for (const m of migrations) {
    if (typeof m.name !== "string" || m.name === "") throw new Error("every migration needs a name");
    if (names.has(m.name)) throw new Error(`two migrations are named "${m.name}"`);
    names.add(m.name);
    if ((m.sql === undefined) === (m.run === undefined))
      throw new Error(`migration "${m.name}" needs either sql or run, not both or neither`);
  }
}

function recorded(db: DatabaseSync): Recorded[] {
  db.exec(`create table if not exists ${TABLE} (
    id integer primary key,
    name text not null unique,
    checksum text not null,
    applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  return db.prepare(`select name, checksum from ${TABLE} order by id`).all() as Recorded[];
}

/** The changes recorded must be the first ones of the list, unchanged. */
function compare(done: Recorded[], migrations: Migration[]): void {
  if (done.length > migrations.length)
    throw new Error(
      `the database has ${done.length} migrations and this program knows ${migrations.length}: a newer program changed it`,
    );
  for (let i = 0; i < done.length; i++) {
    const m = migrations[i]!;
    const r = done[i]!;
    if (r.name !== m.name)
      throw new Error(`migration ${i + 1} in the database is "${r.name}", but this program's migration ${i + 1} is "${m.name}"`);
    if (r.checksum !== checksumOf(m)) throw new Error(`migration "${m.name}" was changed after it was applied`);
  }
}

/** Names of the changes migrate() would apply now. */
export function pendingMigrations(db: DatabaseSync, migrations: Migration[]): string[] {
  check(migrations);
  const done = recorded(db);
  compare(done, migrations);
  return migrations.slice(done.length).map((m) => m.name);
}

/** Applies the changes the database hasn't had, in order. */
export function migrate(db: DatabaseSync, migrations: Migration[]): MigrateResult {
  check(migrations);
  const done = recorded(db);
  compare(done, migrations);
  const applied: string[] = [];
  const record = db.prepare(`insert into ${TABLE} (name, checksum) values (?, ?)`);
  for (let i = done.length; i < migrations.length; i++) {
    const m = migrations[i]!;
    const inTransaction = m.transaction !== false;
    if (inTransaction) db.exec("begin immediate");
    try {
      if (m.sql !== undefined) db.exec(m.sql);
      else m.run!(db);
      record.run(m.name, checksumOf(m));
      if (inTransaction) db.exec("commit");
    } catch (error) {
      if (inTransaction && db.isTransaction) db.exec("rollback");
      throw new MigrationError(m.name, error);
    }
    applied.push(m.name);
  }
  return { applied, total: migrations.length };
}
