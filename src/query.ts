// scriptc-sqlite/query: a small typed query builder that compiles natively
// with scriptc (Kysely and Drizzle only run as Node islands; see NOTES.md,
// day 3). It works on any node:sqlite-shaped DatabaseSync, so the same
// program runs under Node with node:sqlite.
//
//   const person = table("person", { id: integer(), name: text(), age: integer() });
//   const q = new QueryBuilder(db);
//   q.insertInto(person).values({ name: "Ada", age: 36 }).run();
//   const rows = q.select({ name: person.c.name }).from(person).where(gt(person.c.age, 30)).all();
//   // rows: { name: string }[]
//
// Values are always bound as parameters; only names the program wrote
// (tables, columns, aliases) and SQL text passed to `raw` go into the SQL.
//
// The shape follows from scriptc 0.4.12's limits, each found by a failed
// first try (NOTES.md, day 3):
// - A query's row type is fixed by select() and never changes along the
//   chain: a class whose methods return another instantiation of itself
//   does not compile (SC1090), which is what blocks Kysely.
// - Mapped row types are computed in method return types (select<S>()
//   returns Select<RowOf<S>>), never inside a class generic over the
//   selection (SC2009).
// - Code that walks expressions at run time sees the non-generic base
//   class SqlExpr: scriptc has no variance, so an Expr<number> cannot go
//   where an Expr<SQLOutputValue> is declared (SC2002).
// - Comparing with a value and with an expression are separate functions:
//   scriptc does not narrow `Expr<T> | T` inside a generic (SC2003).
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "./sqlite.ts";

// ── expressions ──────────────────────────────────────────────────────────

/** SQL text with its parameters, as code that walks a query sees it.
 * For a table column it also holds what createTable needs: its SQL name,
 * its table, its type and constraints. (They live here, not on Column,
 * because code that walks a table's columns can only see this non-generic
 * class.) table() fills in `sql`, `column` and `table`. */
export class SqlExpr {
  sql: string;
  readonly params: SQLInputValue[];
  column = "";
  table = "";
  columnType = "";
  notNull = true;
  primary = false;
  isUnique = false;
  defaultSql = "";
  reference: SqlExpr | null = null;
  onDelete = "";
  constructor(sql: string, params: SQLInputValue[]) {
    this.sql = sql;
    this.params = params;
  }
}

/** A selection, a table's columns or a row of values, as a record. The
 * parameter is `unknown`: a record of Column<number> and Column<string>
 * does not convert to a record of the base class directly (SC2002). */
function entriesOf<V>(record: unknown): Record<string, V> {
  return record as Record<string, V>;
}

/** An SQL expression whose value reads as T. */
export class Expr<T> extends SqlExpr {
  /** Ties T to the expression, so Expr<number> and Expr<string> differ. */
  read(value: SQLOutputValue): T {
    return value as T;
  }
}

/** A table column. `table()` gives it its table and, unless the column
 * was given one, its name. The constraint methods are for createTable;
 * each returns the column. */
export class Column<T> extends Expr<T> {
  constructor(name: string, columnType: string) {
    super("", []);
    this.column = name;
    this.columnType = columnType;
  }
  /** PRIMARY KEY. An `integer()` primary key is SQLite's rowid: leave it
   * out of an insert and SQLite picks the next number. */
  primaryKey(): Column<T> {
    this.primary = true;
    return this;
  }
  unique(): Column<T> {
    this.isUnique = true;
    return this;
  }
  /** REFERENCES the other table's column (a foreign key). */
  references(target: Column<T> | Column<NonNullable<T>>, onDelete?: "cascade" | "set null" | "restrict"): Column<T> {
    this.reference = target;
    this.onDelete = onDelete ?? "";
    return this;
  }
  /** DEFAULT: the value used when an insert leaves the column out. */
  defaultTo(value: T): Column<T> {
    this.defaultSql = literal(value as SQLInputValue);
    return this;
  }
}

/** A value written into DDL, where parameters can't go. */
function literal(value: SQLInputValue): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  let hex = "";
  for (let i = 0; i < value.length; i++) hex += value[i]!.toString(16).padStart(2, "0");
  return `x'${hex}'`;
}

type ValueOf<E> = E extends Expr<infer T> ? T : never;
/** The row a selection gives: its keys, each with its expression's type. */
export type RowOf<S> = { [K in keyof S]: ValueOf<S[K]> };
/** What an insert or update takes: some of a table's columns. */
export type ValuesOf<C> = { [K in keyof C]?: ValueOf<C[K]> };

export function integer(name = ""): Column<number> {
  return new Column<number>(name, "integer");
}
export function real(name = ""): Column<number> {
  return new Column<number>(name, "real");
}
export function text(name = ""): Column<string> {
  return new Column<string>(name, "text");
}
export function blob(name = ""): Column<Uint8Array> {
  return new Column<Uint8Array>(name, "blob");
}
/** A column that may hold NULL: `nullable(text())`. Its other
 * constraints come along. */
export function nullable<T>(column: Column<T>): Column<T | null> {
  const c = new Column<T | null>(column.column, column.columnType);
  c.notNull = false;
  c.primary = column.primary;
  c.isUnique = column.isUnique;
  c.defaultSql = column.defaultSql;
  c.reference = column.reference;
  c.onDelete = column.onDelete;
  return c;
}

/** A table and its columns: `table("pet", { ownerId: integer("owner_id") })`.
 * With an alias, the same table under another name in one query
 * (`table("person", personColumns(), "boss")`, columns made fresh). */
export class Table<C> {
  readonly name: string;
  readonly alias: string;
  readonly c: C;
  constructor(name: string, columns: C, alias: string) {
    this.name = name;
    this.alias = alias;
    this.c = columns;
  }
}

/** Declares a table. A column without a name takes its key. For a self-join
 * declare it twice with fresh column objects and an alias for the second:
 * a function that returns the columns makes that easy. */
export function table<C>(name: string, columns: C, alias = ""): Table<C> {
  const record = entriesOf<SqlExpr>(columns);
  for (const key of Object.keys(record)) {
    const column = record[key]!;
    if (column.table !== "") throw new Error(`column ${key} already belongs to table ${column.table}: declare fresh columns`);
    if (column.column === "") column.column = key;
    column.table = name;
    column.sql = `${quote(alias === "" ? name : alias)}.${quote(column.column)}`;
  }
  return new Table<C>(name, columns, alias);
}

/** How a table appears after FROM or JOIN. */
function tableRef<C>(t: Table<C>): string {
  return t.alias === "" ? quote(t.name) : `${quote(t.name)} as ${quote(t.alias)}`;
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Raw SQL with a declared type: `raw<number>("length(?)", ["abc"])`. Put
 * an expression in with its `sql` (`raw<number>(`${t.c.x.sql} * 2`)`),
 * values only as parameters. */
export function raw<T>(sql: string, params: SQLInputValue[] = []): Expr<T> {
  return new Expr<T>(sql, params);
}

/** The same expression, typed as possibly NULL: for columns of a
 * left-joined table. */
export function orNull<T>(e: Expr<T>): Expr<T | null> {
  return new Expr<T | null>(e.sql, e.params);
}

function call<T>(fn: string, e: SqlExpr): Expr<T> {
  return new Expr<T>(`${fn}(${e.sql})`, e.params);
}

/** count(*), or count(e) (non-NULL values). */
export function count(e?: SqlExpr): Expr<number> {
  return e === undefined ? new Expr<number>("count(*)", []) : call<number>("count", e);
}
/** NULL over no rows, as in SQL. */
export function sum(e: Expr<number> | Expr<number | null>): Expr<number | null> {
  return call<number | null>("sum", e);
}
export function avg(e: Expr<number> | Expr<number | null>): Expr<number | null> {
  return call<number | null>("avg", e);
}
export function min<T>(e: Expr<T>): Expr<T | null> {
  return call<T | null>("min", e);
}
export function max<T>(e: Expr<T>): Expr<T | null> {
  return call<T | null>("max", e);
}

// ── conditions ───────────────────────────────────────────────────────────

/** A WHERE, HAVING or ON condition. */
export class Condition extends SqlExpr {}

type Op = "=" | "<>" | "<" | "<=" | ">" | ">=";

function compare(a: SqlExpr, op: Op, b: SqlExpr): Condition {
  return new Condition(`${a.sql} ${op} ${b.sql}`, [...a.params, ...b.params]);
}

function compareValue(a: SqlExpr, op: Op, value: SQLInputValue): Condition {
  return new Condition(`${a.sql} ${op} ?`, [...a.params, value]);
}

export function eq<T extends SQLInputValue>(a: Expr<T>, value: T): Condition {
  return compareValue(a, "=", value);
}
export function ne<T extends SQLInputValue>(a: Expr<T>, value: T): Condition {
  return compareValue(a, "<>", value);
}
export function lt<T extends SQLInputValue>(a: Expr<T>, value: T): Condition {
  return compareValue(a, "<", value);
}
export function le<T extends SQLInputValue>(a: Expr<T>, value: T): Condition {
  return compareValue(a, "<=", value);
}
export function gt<T extends SQLInputValue>(a: Expr<T>, value: T): Condition {
  return compareValue(a, ">", value);
}
export function ge<T extends SQLInputValue>(a: Expr<T>, value: T): Condition {
  return compareValue(a, ">=", value);
}
/** Two expressions of the same type, either side possibly nullable:
 * `same(pet.c.ownerId, "=", person.c.id)`. Two type parameters, not one:
 * one would make TypeScript widen a Column<number> to Expr<number | null>
 * when the other side is nullable, and scriptc compiles those as unrelated
 * classes (SC1090). */
export function same<A, B extends A | null>(a: Expr<A>, op: Op, b: Expr<B>): Condition {
  return compare(a, op, b);
}

export function and(...conditions: Condition[]): Condition {
  return join(conditions, " and ", "1");
}
export function or(...conditions: Condition[]): Condition {
  return join(conditions, " or ", "0");
}

function join(conditions: Condition[], separator: string, empty: string): Condition {
  if (conditions.length === 0) return new Condition(empty, []);
  const params: SQLInputValue[] = [];
  for (const c of conditions) for (const p of c.params) params.push(p);
  return new Condition(conditions.map((c) => `(${c.sql})`).join(separator), params);
}

export function not(condition: Condition): Condition {
  return new Condition(`not (${condition.sql})`, condition.params);
}
export function isNull(e: SqlExpr): Condition {
  return new Condition(`${e.sql} is null`, e.params);
}
export function isNotNull(e: SqlExpr): Condition {
  return new Condition(`${e.sql} is not null`, e.params);
}
/** `e in (…)`; an empty list matches nothing, as in SQL. */
export function inList<T extends SQLInputValue>(e: Expr<T>, values: T[]): Condition {
  const params: SQLInputValue[] = [...e.params];
  for (const v of values) params.push(v);
  return new Condition(`${e.sql} in (${values.map(() => "?").join(", ")})`, params);
}
export function like(e: Expr<string> | Expr<string | null>, pattern: string): Condition {
  return new Condition(`${e.sql} like ?`, [...e.params, pattern]);
}
export function between<T extends SQLInputValue>(e: Expr<T>, low: T, high: T): Condition {
  return new Condition(`${e.sql} between ? and ?`, [...e.params, low, high]);
}

// ── queries ──────────────────────────────────────────────────────────────

/** A compiled query: what `toSQL()` returns. */
export interface CompiledQuery {
  sql: string;
  params: SQLInputValue[];
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** The SELECT list for a selection, and its parameters. */
function selectList(selection: unknown, params: SQLInputValue[]): string {
  const record = entriesOf<SqlExpr>(selection);
  const parts: string[] = [];
  for (const key of Object.keys(record)) {
    const e = record[key]!;
    for (const p of e.params) params.push(p);
    parts.push(`${e.sql} as ${quote(key)}`);
  }
  return parts.join(", ");
}

/** A SELECT whose rows are R. */
export class Select<R> {
  #db: DatabaseSync;
  #columns: string;
  #columnParams: SQLInputValue[];
  #distinct = false;
  #from = "";
  #joins: string[] = [];
  #joinParams: SQLInputValue[] = [];
  #where: Condition | null = null;
  #groupBy: SqlExpr[] = [];
  #having: Condition | null = null;
  #orderBy: string[] = [];
  #orderParams: SQLInputValue[] = [];
  #limit = -1;
  #offset = -1;

  /** @internal Use QueryBuilder.select. */
  constructor(db: DatabaseSync, columns: string, params: SQLInputValue[]) {
    this.#db = db;
    this.#columns = columns;
    this.#columnParams = params;
  }
  distinct(): Select<R> {
    this.#distinct = true;
    return this;
  }
  from<C>(t: Table<C>): Select<R> {
    this.#from = tableRef(t);
    return this;
  }
  innerJoin<C>(t: Table<C>, on: Condition): Select<R> {
    return this.#join("join", tableRef(t), on);
  }
  /** Select the joined table's columns through orNull(): its rows may be
   * missing. */
  leftJoin<C>(t: Table<C>, on: Condition): Select<R> {
    return this.#join("left join", tableRef(t), on);
  }
  /** Several where() calls are joined with AND. */
  where(condition: Condition): Select<R> {
    this.#where = this.#where === null ? condition : and(this.#where, condition);
    return this;
  }
  groupBy(...exprs: SqlExpr[]): Select<R> {
    for (const e of exprs) this.#groupBy.push(e);
    return this;
  }
  having(condition: Condition): Select<R> {
    this.#having = this.#having === null ? condition : and(this.#having, condition);
    return this;
  }
  orderBy(e: SqlExpr, direction: "asc" | "desc" = "asc"): Select<R> {
    this.#orderBy.push(`${e.sql} ${direction}`);
    for (const p of e.params) this.#orderParams.push(p);
    return this;
  }
  limit(n: number): Select<R> {
    this.#limit = Math.trunc(n);
    return this;
  }
  offset(n: number): Select<R> {
    this.#offset = Math.trunc(n);
    return this;
  }
  toSQL(): CompiledQuery {
    const params = [...this.#columnParams];
    let sql = `select ${this.#distinct ? "distinct " : ""}${this.#columns}`;
    if (this.#from !== "") sql += ` from ${this.#from}`;
    for (const j of this.#joins) sql += ` ${j}`;
    for (const p of this.#joinParams) params.push(p);
    if (this.#where !== null) {
      sql += ` where ${this.#where.sql}`;
      for (const p of this.#where.params) params.push(p);
    }
    if (this.#groupBy.length > 0) {
      sql += ` group by ${this.#groupBy.map((e) => e.sql).join(", ")}`;
      for (const e of this.#groupBy) for (const p of e.params) params.push(p);
    }
    if (this.#having !== null) {
      sql += ` having ${this.#having.sql}`;
      for (const p of this.#having.params) params.push(p);
    }
    if (this.#orderBy.length > 0) {
      sql += ` order by ${this.#orderBy.join(", ")}`;
      for (const p of this.#orderParams) params.push(p);
    }
    if (this.#limit >= 0 || this.#offset >= 0) sql += ` limit ${this.#limit}`;
    if (this.#offset >= 0) sql += ` offset ${this.#offset}`;
    return { sql, params };
  }
  all(): R[] {
    const q = this.toSQL();
    return this.#db.prepare(q.sql).all(...q.params) as R[];
  }
  /** The first row, or undefined. */
  first(): R | undefined {
    const rows = this.all();
    return rows.length > 0 ? rows[0] : undefined;
  }

  #join(kind: string, ref: string, on: Condition): Select<R> {
    this.#joins.push(`${kind} ${ref} on ${on.sql}`);
    for (const p of on.params) this.#joinParams.push(p);
    return this;
  }
}

/** Rows a write gives back with RETURNING. */
export class Returning<R> {
  #db: DatabaseSync;
  #query: CompiledQuery;
  /** @internal */
  constructor(db: DatabaseSync, query: CompiledQuery) {
    this.#db = db;
    this.#query = query;
  }
  toSQL(): CompiledQuery {
    return this.#query;
  }
  all(): R[] {
    return this.#db.prepare(this.#query.sql).all(...this.#query.params) as R[];
  }
}

/** A table's name and its columns' SQL names by key: what a write needs.
 * Writes keep no typed values: a class generic over the table cannot hold
 * a ValuesOf<C> (SC2001), so QueryBuilder converts them first. */
interface TableInfo {
  name: string;
  columns: Record<string, string>;
}

function tableInfo<C>(t: Table<C>): TableInfo {
  const record = entriesOf<SqlExpr>(t.c);
  const columns: Record<string, string> = {};
  for (const key of Object.keys(record)) columns[key] = record[key]!.column;
  return { name: t.name, columns };
}

/** A row of values as column names and parameters, undefined left out. */
function assignments(info: TableInfo, values: unknown): { names: string[]; params: SQLInputValue[] } {
  const record = entriesOf<SQLInputValue | undefined>(values);
  const names: string[] = [];
  const params: SQLInputValue[] = [];
  for (const key of Object.keys(record)) {
    const v = record[key];
    if (v === undefined) continue;
    names.push(quote(info.columns[key]!));
    params.push(v);
  }
  return { names, params };
}

/** An INSERT, UPDATE or DELETE: run() it, or ask for rows with
 * returning(). */
export class Write {
  #db: DatabaseSync;
  #table: string;
  #insert: boolean;
  #sql: string;
  #params: SQLInputValue[];
  #conflict = "";
  #where: Condition | null = null;
  #error: string;
  /** @internal Use QueryBuilder.insertInto, update or deleteFrom. */
  constructor(db: DatabaseSync, table: string, insert: boolean, sql: string, params: SQLInputValue[], error = "") {
    this.#db = db;
    this.#table = table;
    this.#insert = insert;
    this.#sql = sql;
    this.#params = params;
    this.#error = error;
  }
  /** For update and delete; several calls are joined with AND. */
  where(condition: Condition): Write {
    if (this.#insert) this.#fail("where() is for update and delete; an insert has none");
    this.#where = this.#where === null ? condition : and(this.#where, condition);
    return this;
  }
  /** Upsert: rows that would break a UNIQUE or PRIMARY KEY constraint (on
   * `target`, or any, when none is given) are skipped. */
  onConflictDoNothing(...target: SqlExpr[]): Write {
    this.#conflict = ` on conflict${target.length > 0 ? ` (${columnList(target)})` : ""} do nothing`;
    return this.#onlyInsert("onConflictDoNothing");
  }
  /** Upsert: a row whose `target` columns match an existing row updates
   * that row's `columns` to the new values instead. */
  onConflictDoUpdate(target: SqlExpr[], columns: SqlExpr[]): Write {
    if (target.length === 0 || columns.length === 0)
      this.#fail("onConflictDoUpdate needs the conflict columns and the columns to update");
    const sets = columns.map((c) => `${quote(c.column)} = excluded.${quote(c.column)}`).join(", ");
    this.#conflict = ` on conflict (${columnList(target)}) do update set ${sets}`;
    return this.#onlyInsert("onConflictDoUpdate");
  }
  toSQL(): CompiledQuery {
    if (this.#error !== "") throw new Error(this.#error);
    let sql = this.#sql + this.#conflict;
    const params = [...this.#params];
    if (this.#where !== null) {
      sql += ` where ${this.#where.sql}`;
      for (const p of this.#where.params) params.push(p);
    }
    return { sql, params };
  }
  run(): RunResult {
    const q = this.toSQL();
    const r = this.#db.prepare(q.sql).run(...q.params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  /** The written rows, as `select` would give them; columns are named
   * without their table, as RETURNING requires. */
  returning<S>(selection: S): Returning<RowOf<S>> {
    const q = this.toSQL();
    const record = entriesOf<SqlExpr>(selection);
    const prefix = `${quote(this.#table)}.`;
    const parts: string[] = [];
    for (const key of Object.keys(record)) {
      const e = record[key]!;
      for (const p of e.params) q.params.push(p);
      parts.push(`${e.sql.replaceAll(prefix, "")} as ${quote(key)}`);
    }
    return new Returning<RowOf<S>>(this.#db, { sql: `${q.sql} returning ${parts.join(", ")}`, params: q.params });
  }

  #onlyInsert(what: string): Write {
    if (!this.#insert) this.#fail(`${what}() is for inserts`);
    return this;
  }

  #fail(message: string): void {
    if (this.#error === "") this.#error = message;
  }
}

/** Column names for DDL and ON CONFLICT: without their table. */
function columnList(columns: SqlExpr[]): string {
  return columns.map((c) => quote(c.column)).join(", ");
}

/** A CREATE or DROP statement. */
export class Ddl {
  #db: DatabaseSync;
  #sql: string;
  /** @internal Use QueryBuilder.createTable, createIndex or dropTable. */
  constructor(db: DatabaseSync, sql: string) {
    this.#db = db;
    this.#sql = sql;
  }
  toSQL(): CompiledQuery {
    return { sql: this.#sql, params: [] };
  }
  run(): void {
    this.#db.exec(this.#sql);
  }
}

function columnDefinition(c: SqlExpr): string {
  let sql = `${quote(c.column)} ${c.columnType}`;
  if (c.primary) sql += " primary key";
  // An integer primary key is the rowid, which SQLite fills in itself.
  if (c.notNull && !(c.primary && c.columnType === "integer")) sql += " not null";
  if (c.isUnique) sql += " unique";
  if (c.defaultSql !== "") sql += ` default ${c.defaultSql}`;
  if (c.reference !== null) {
    sql += ` references ${quote(c.reference.table)} (${quote(c.reference.column)})`;
    if (c.onDelete !== "") sql += ` on delete ${c.onDelete}`;
  }
  return sql;
}

/** Writes need the table's own name: an alias is for reading. */
function aliasError<C>(t: Table<C>, what: string): string {
  return t.alias === "" ? "" : `${what} ${t.name}: use the table, not its alias "${t.alias}"`;
}

// ── subqueries ───────────────────────────────────────────────────────────

/** `e in (select …)`: the subquery selects one column of e's type. */
export function inSelect<T, R extends { [key: string]: T | null }>(e: Expr<T>, sub: Select<R>): Condition {
  const q = sub.toSQL();
  return new Condition(`${e.sql} in (${q.sql})`, [...e.params, ...q.params]);
}

/** `exists (select …)`: true when the subquery has a row. */
export function exists<R>(sub: Select<R>): Condition {
  const q = sub.toSQL();
  return new Condition(`exists (${q.sql})`, q.params);
}

/** A subquery of one column as a value: its first row's value, or NULL
 * when it has none. */
export function scalar<R>(sub: Select<R>): Expr<R[keyof R] | null> {
  const q = sub.toSQL();
  return new Expr<R[keyof R] | null>(`(${q.sql})`, q.params);
}

export class QueryBuilder {
  #db: DatabaseSync;
  #depth = 0;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  /** `select({ alias: expression, … })`: rows have exactly these keys and
   * types. */
  select<S>(selection: S): Select<RowOf<S>> {
    const params: SQLInputValue[] = [];
    const columns = selectList(selection, params);
    return new Select<RowOf<S>>(this.#db, columns, params);
  }
  /** Every column of a table, under its key: `selectAll(person)`. */
  selectAll<C>(t: Table<C>): Select<RowOf<C>> {
    const params: SQLInputValue[] = [];
    const columns = selectList(t.c, params);
    return new Select<RowOf<C>>(this.#db, columns, params).from(t);
  }
  /** One or more rows, all setting the same columns. */
  insertInto<C>(t: Table<C>, ...rows: ValuesOf<C>[]): Write {
    const info = tableInfo(t);
    const params: SQLInputValue[] = [];
    const tuples: string[] = [];
    let names: string[] = [];
    let error = rows.length === 0 ? `insert into ${t.name}: no values` : "";
    for (const row of rows) {
      const a = assignments(info, row);
      if (tuples.length === 0) names = a.names;
      else if (a.names.join() !== names.join()) error = `insert into ${t.name}: every row must set the same columns`;
      for (const p of a.params) params.push(p);
      tuples.push(`(${a.names.map(() => "?").join(", ")})`);
    }
    if (error === "") error = aliasError(t, "insert into");
    const sql = `insert into ${quote(t.name)} (${names.join(", ")}) values ${tuples.join(", ")}`;
    return new Write(this.#db, t.name, true, sql, params, error);
  }
  /** Add where(), or every row is updated. */
  update<C>(t: Table<C>, values: ValuesOf<C>): Write {
    const a = assignments(tableInfo(t), values);
    const sql = `update ${quote(t.name)} set ${a.names.map((n) => `${n} = ?`).join(", ")}`;
    const error = a.names.length === 0 ? `update ${t.name}: no values` : aliasError(t, "update");
    return new Write(this.#db, t.name, false, sql, a.params, error);
  }
  /** Add where(), or every row is deleted. */
  deleteFrom<C>(t: Table<C>): Write {
    return new Write(this.#db, t.name, false, `delete from ${quote(t.name)}`, [], aliasError(t, "delete from"));
  }
  /** CREATE TABLE from the declaration: NOT NULL unless nullable(), and
   * the columns' primaryKey(), unique(), references() and defaultTo().
   * `primaryKey` declares a key of several columns. */
  createTable<C>(t: Table<C>, options?: { ifNotExists?: boolean; primaryKey?: SqlExpr[] }): Ddl {
    const record = entriesOf<SqlExpr>(t.c);
    const parts = Object.keys(record).map((k) => columnDefinition(record[k]!));
    const o = options ?? {};
    if (o.primaryKey !== undefined) parts.push(`primary key (${columnList(o.primaryKey)})`);
    const sql = `create table ${o.ifNotExists === true ? "if not exists " : ""}${quote(t.name)} (${parts.join(", ")})`;
    return new Ddl(this.#db, sql);
  }
  createIndex<C>(name: string, t: Table<C>, columns: SqlExpr[], options?: { unique?: boolean; ifNotExists?: boolean }): Ddl {
    const o = options ?? {};
    const sql = `create ${o.unique === true ? "unique " : ""}index ${o.ifNotExists === true ? "if not exists " : ""}${quote(name)} on ${quote(t.name)} (${columnList(columns)})`;
    return new Ddl(this.#db, sql);
  }
  dropTable<C>(t: Table<C>, options?: { ifExists?: boolean }): Ddl {
    return new Ddl(this.#db, `drop table ${options?.ifExists === true ? "if exists " : ""}${quote(t.name)}`);
  }
  /** Runs `body` in a transaction: committed when it returns, rolled back
   * when it throws (and the exception rethrown). Nested calls use
   * savepoints, so an inner failure the outer body catches undoes only the
   * inner part. */
  transaction<T>(body: () => T): T {
    const depth = this.#depth;
    const savepoint = `sp${depth}`;
    this.#db.exec(depth === 0 ? "begin" : `savepoint ${savepoint}`);
    this.#depth = depth + 1;
    try {
      const result = body();
      this.#db.exec(depth === 0 ? "commit" : `release ${savepoint}`);
      this.#depth = depth;
      return result;
    } catch (error) {
      // Also when the commit itself fails (a deferred constraint).
      this.#depth = depth;
      if (this.#db.isTransaction)
        this.#db.exec(depth === 0 ? "rollback" : `rollback to ${savepoint}; release ${savepoint}`);
      throw error;
    }
  }
}
