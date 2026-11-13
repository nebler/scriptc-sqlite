// A node:sqlite-shaped module for scriptc: DatabaseSync and StatementSync,
// on SQLite compiled into the program (see ../build.sh and ../ffi.json).
//
// Values follow Node's node:sqlite (v24): numbers bind as REAL, bigints and
// booleans as INTEGER, strings as TEXT, Uint8Arrays as BLOB, null as NULL; INTEGER
// columns read as numbers (bigints with setReadBigInts(true)), REAL as
// numbers, TEXT as strings, BLOB as Uint8Arrays, NULL as null. Errors carry
// Node's `code`, and SQLite's `errcode` and `errstr`.

declare function sqxOpen(path: string, readOnly: number): bigint;
declare function sqxOpenFailed(db: bigint): number;
declare function sqxClose(db: bigint): number;
declare function sqxExec(db: bigint, sql: string): number;
declare function sqxErrcode(db: bigint): number;
declare function sqxErrmsg(db: bigint, out: Uint8Array): bigint;
declare function sqxErrstr(code: number, out: Uint8Array): bigint;
declare function sqxInTransaction(db: bigint): number;
declare function sqxChanges(db: bigint): bigint;
declare function sqxLastInsertRowid(db: bigint): bigint;
declare function sqxPrepare(db: bigint, sql: string): bigint;
declare function sqxPrepareRc(): number;
declare function sqxFinalize(stmt: bigint): number;
declare function sqxReset(stmt: bigint): number;
declare function sqxStep(stmt: bigint): number;
declare function sqxSql(stmt: bigint, out: Uint8Array): bigint;
declare function sqxParamCount(stmt: bigint): number;
declare function sqxParamName(stmt: bigint, index: number, out: Uint8Array): bigint;
declare function sqxBindNull(stmt: bigint, index: number): number;
declare function sqxBindDouble(stmt: bigint, index: number, value: number): number;
declare function sqxBindInt64(stmt: bigint, index: number, value: bigint): number;
declare function sqxBindText(stmt: bigint, index: number, value: string): number;
declare function sqxBindBlob(stmt: bigint, index: number, value: Uint8Array): number;
declare function sqxColumnCount(stmt: bigint): number;
declare function sqxColumnName(stmt: bigint, index: number, out: Uint8Array): bigint;
declare function sqxColumnType(stmt: bigint, index: number): number;
declare function sqxColumnInt64(stmt: bigint, index: number): bigint;
declare function sqxColumnDouble(stmt: bigint, index: number): number;
declare function sqxColumnText(stmt: bigint, index: number, out: Uint8Array): bigint;
declare function sqxColumnBlob(stmt: bigint, index: number, out: Uint8Array): bigint;
declare function sqxVersion(out: Uint8Array): bigint;

export type SQLInputValue = null | number | bigint | string | Uint8Array;
export type SQLOutputValue = null | number | bigint | string | Uint8Array;
export type SQLRow = Record<string, SQLOutputValue>;

export interface StatementResultingChanges {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface DatabaseSyncOptions {
  open?: boolean;
  readOnly?: boolean;
  readBigInts?: boolean;
}

const SQLITE_OK = 0;
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const SQLITE_INTEGER = 1;
const SQLITE_FLOAT = 2;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;
const NULL_HANDLE = 0n;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** The error node:sqlite throws: an Error with Node's code and, for SQLite
 * failures only, SQLite's extended result code and its description. */
export class SQLiteError extends Error {
  code: string;
  errcode?: number;
  errstr?: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

function stateError(message: string): SQLiteError {
  return new SQLiteError(message, "ERR_INVALID_STATE");
}

// Text and bytes come back from C through a buffer this side owns: the C
// function copies what fits and returns the full length; a longer value is
// fetched again into a buffer of exactly that size.
let scratch = new Uint8Array(256);
const decoder = new TextDecoder();

function readText(fetch: (out: Uint8Array) => bigint): string {
  let n = Number(fetch(scratch));
  if (n <= 0) return "";
  if (n > scratch.length) {
    scratch = new Uint8Array(Math.max(n, scratch.length * 2));
    n = Number(fetch(scratch));
  }
  return decoder.decode(scratch.subarray(0, n));
}

function readBytes(fetch: (out: Uint8Array) => bigint): Uint8Array {
  let n = Number(fetch(scratch));
  if (n <= 0) return new Uint8Array(0);
  if (n > scratch.length) {
    scratch = new Uint8Array(Math.max(n, scratch.length * 2));
    n = Number(fetch(scratch));
  }
  return scratch.slice(0, n);
}

/** A parameter's name with its prefix ("$a", ":a", "@a"), or "?" for an
 * anonymous or numbered one ("?", "?2"). */
function paramName(stmt: bigint, index: number): string {
  if (Number(sqxParamName(stmt, index, scratch)) < 0) return "?";
  return readText((out) => sqxParamName(stmt, index, out));
}

function sqliteError(db: bigint, rc: number): SQLiteError {
  const errcode = db === NULL_HANDLE ? rc : sqxErrcode(db);
  const message = db === NULL_HANDLE ? readText((out) => sqxErrstr(rc, out)) : readText((out) => sqxErrmsg(db, out));
  const errstr = readText((out) => sqxErrstr(errcode, out));
  const error = new SQLiteError(message, "ERR_SQLITE_ERROR");
  error.errcode = errcode;
  error.errstr = errstr;
  return error;
}

/** The SQLite version compiled into this program, such as "3.54.1". */
export function sqliteVersion(): string {
  return readText((out) => sqxVersion(out));
}

export class DatabaseSync {
  #path: string;
  #readOnly: boolean;
  #readBigInts: boolean;
  #db: bigint = NULL_HANDLE;
  #statements: StatementSync[] = [];

  constructor(path: string, options?: DatabaseSyncOptions) {
    this.#path = path;
    this.#readOnly = options?.readOnly === true;
    this.#readBigInts = options?.readBigInts === true;
    if (options?.open !== false) this.open();
  }

  get isOpen(): boolean {
    return this.#db !== NULL_HANDLE;
  }

  get isTransaction(): boolean {
    return sqxInTransaction(this.#handle()) !== 0;
  }

  open(): void {
    if (this.#db !== NULL_HANDLE) throw stateError("database is already open");
    const db = sqxOpen(this.#path, this.#readOnly ? 1 : 0);
    const rc = sqxOpenFailed(db);
    if (rc !== SQLITE_OK) {
      const error = sqliteError(db, rc);
      if (db !== NULL_HANDLE) sqxClose(db);
      throw error;
    }
    this.#db = db;
  }

  close(): void {
    const db = this.#handle();
    for (const statement of this.#statements) statement._finalize();
    this.#statements = [];
    sqxClose(db);
    this.#db = NULL_HANDLE;
  }

  exec(sql: string): void {
    const db = this.#handle();
    const rc = sqxExec(db, sql);
    if (rc !== SQLITE_OK) throw sqliteError(db, rc);
  }

  prepare(sql: string): StatementSync {
    const db = this.#handle();
    const stmt = sqxPrepare(db, sql);
    const rc = sqxPrepareRc();
    if (rc !== SQLITE_OK) throw sqliteError(db, rc);
    if (stmt === NULL_HANDLE)
      throw new SQLiteError("The SQL query contains no statements.", "ERR_INVALID_ARG_VALUE");
    const statement = new StatementSync(this, stmt, this.#readBigInts);
    this.#statements.push(statement);
    return statement;
  }

  /** @internal */
  _handle(): bigint {
    return this.#handle();
  }

  #handle(): bigint {
    if (this.#db === NULL_HANDLE) throw stateError("database is not open");
    return this.#db;
  }
}

export class StatementSync {
  #db: DatabaseSync;
  #stmt: bigint;
  #readBigInts: boolean;

  /** @internal Use DatabaseSync.prototype.prepare. */
  constructor(db: DatabaseSync, stmt: bigint, readBigInts: boolean) {
    this.#db = db;
    this.#stmt = stmt;
    this.#readBigInts = readBigInts;
  }

  get sourceSQL(): string {
    const stmt = this.#handle();
    return readText((out) => sqxSql(stmt, out));
  }

  setReadBigInts(enabled: boolean): void {
    this.#handle();
    this.#readBigInts = enabled;
  }

  run(...params: unknown[]): StatementResultingChanges {
    const stmt = this.#start(params);
    const db = this.#db._handle();
    let rc = sqxStep(stmt);
    while (rc === SQLITE_ROW) rc = sqxStep(stmt);
    if (rc !== SQLITE_DONE) {
      const error = sqliteError(db, rc);
      sqxReset(stmt);
      throw error;
    }
    sqxReset(stmt);
    const changes = sqxChanges(db);
    const rowid = sqxLastInsertRowid(db);
    if (this.#readBigInts) return { changes, lastInsertRowid: rowid };
    return { changes: Number(changes), lastInsertRowid: Number(rowid) };
  }

  get(...params: unknown[]): SQLRow | undefined {
    const stmt = this.#start(params);
    const db = this.#db._handle();
    const rc = sqxStep(stmt);
    let row: SQLRow | undefined = undefined;
    if (rc === SQLITE_ROW) {
      try {
        row = this.#row(stmt, this.#columnNames(stmt));
      } catch (error) {
        sqxReset(stmt);
        throw error;
      }
    } else if (rc !== SQLITE_DONE) {
      const error = sqliteError(db, rc);
      sqxReset(stmt);
      throw error;
    }
    sqxReset(stmt);
    return row;
  }

  all(...params: unknown[]): SQLRow[] {
    const stmt = this.#start(params);
    const db = this.#db._handle();
    const rows: SQLRow[] = [];
    const names = this.#columnNames(stmt);
    let rc = sqxStep(stmt);
    while (rc === SQLITE_ROW) {
      try {
        rows.push(this.#row(stmt, names));
      } catch (error) {
        sqxReset(stmt);
        throw error;
      }
      rc = sqxStep(stmt);
    }
    if (rc !== SQLITE_DONE) {
      const error = sqliteError(db, rc);
      sqxReset(stmt);
      throw error;
    }
    sqxReset(stmt);
    return rows;
  }

  /** @internal Called by DatabaseSync.prototype.close. */
  _finalize(): void {
    if (this.#stmt !== NULL_HANDLE) sqxFinalize(this.#stmt);
    this.#stmt = NULL_HANDLE;
  }

  #handle(): bigint {
    if (this.#stmt === NULL_HANDLE) throw stateError("statement has been finalized");
    this.#db._handle();
    return this.#stmt;
  }

  #start(params: unknown[]): bigint {
    const stmt = this.#handle();
    sqxReset(stmt);
    this.#bind(stmt, params);
    return stmt;
  }

  #bind(stmt: bigint, params: unknown[]): void {
    let first = 0;
    const count = sqxParamCount(stmt);
    const head = params.length > 0 ? params[0] : undefined;
    if (head !== null && typeof head === "object" && !(head instanceof Uint8Array)) {
      first = 1;
      const named = head as Record<string, unknown>;
      for (const key of Object.keys(named)) {
        const index = this.#namedIndex(stmt, count, key);
        if (index === 0) throw stateError(`Unknown named parameter '${key}'`);
        this.#bindOne(stmt, index, named[key]);
      }
    }
    // Positional values fill the anonymous parameters ("?" and "?NNN") in
    // order, skipping named ones, as node:sqlite does.
    let index = 1;
    for (let i = first; i < params.length; i++) {
      while (index <= count && !paramName(stmt, index).startsWith("?")) index++;
      this.#bindOne(stmt, index, params[i]);
      index++;
    }
  }

  #namedIndex(stmt: bigint, count: number, key: string): number {
    for (let i = 1; i <= count; i++) {
      const name = paramName(stmt, i);
      if (name.startsWith("?")) continue;
      if (name === key) return i;
      const prefix = name.charAt(0);
      if ((prefix === "$" || prefix === ":" || prefix === "@") && name.slice(1) === key) return i;
    }
    return 0;
  }

  #bindOne(stmt: bigint, index: number, value: unknown): void {
    let rc: number;
    if (value === null) rc = sqxBindNull(stmt, index);
    else if (typeof value === "number") rc = sqxBindDouble(stmt, index, value);
    else if (typeof value === "boolean") rc = sqxBindInt64(stmt, index, value ? 1n : 0n);
    else if (typeof value === "bigint") {
      if (value < INT64_MIN || value > INT64_MAX)
        throw new SQLiteError("BigInt value is too large to bind.", "ERR_INVALID_ARG_VALUE");
      rc = sqxBindInt64(stmt, index, value);
    } else if (typeof value === "string") rc = sqxBindText(stmt, index, value);
    else if (value instanceof Uint8Array) rc = sqxBindBlob(stmt, index, value);
    else
      throw new SQLiteError(
        `Provided value cannot be bound to SQLite parameter ${index}.`,
        "ERR_INVALID_ARG_TYPE",
      );
    if (rc !== SQLITE_OK) throw sqliteError(this.#db._handle(), rc);
  }

  #columnNames(stmt: bigint): string[] {
    const names: string[] = [];
    const count = sqxColumnCount(stmt);
    for (let i = 0; i < count; i++) names.push(readText((out) => sqxColumnName(stmt, i, out)));
    return names;
  }

  #row(stmt: bigint, names: string[]): SQLRow {
    const row: SQLRow = {};
    for (let i = 0; i < names.length; i++) row[names[i]!] = this.#value(stmt, i);
    return row;
  }

  #value(stmt: bigint, i: number): SQLOutputValue {
    const type = sqxColumnType(stmt, i);
    if (type === SQLITE_INTEGER) {
      const value = sqxColumnInt64(stmt, i);
      if (this.#readBigInts) return value;
      // Node 24 refuses only values above the safe range; values below it
      // come back rounded. Copied as is, so results match.
      if (value > MAX_SAFE)
        throw new SQLiteError(
          `Value is too large to be represented as a JavaScript number: ${value}`,
          "ERR_OUT_OF_RANGE",
        );
      return Number(value);
    }
    if (type === SQLITE_FLOAT) return sqxColumnDouble(stmt, i);
    if (type === SQLITE_TEXT) return readText((out) => sqxColumnText(stmt, i, out));
    if (type === SQLITE_BLOB) return readBytes((out) => sqxColumnBlob(stmt, i, out));
    return null;
  }
}
