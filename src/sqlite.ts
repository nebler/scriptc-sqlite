// A node:sqlite-shaped module for scriptc: DatabaseSync and StatementSync,
// on SQLite compiled into the program (see ../build.sh and ../ffi.json).
//
// Values follow Node's node:sqlite (v24): numbers bind as REAL, bigints and
// booleans as INTEGER, strings as TEXT, Uint8Arrays as BLOB, null as NULL;
// INTEGER columns read as numbers (bigints with setReadBigInts(true)), REAL
// as numbers, TEXT as strings, BLOB as Uint8Arrays, NULL as null. Errors
// carry Node's `code`, and SQLite's `errcode` and `errstr`.
//
// One difference by design: a StatementSync holds no SQLite statement
// between calls. Each call borrows a compiled statement from its
// database's pool and gives it back when it returns (an iterator keeps it
// until it finishes). scriptc has no garbage collector to finalize
// statements a program forgets, as Node does, so this keeps a program that
// prepares statements in a loop at a bounded number of SQLite statements.

declare function sqxOpen(path: string, readOnly: number, foreignKeys: number, dqs: number, timeoutMs: number): bigint;
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
declare function sqxExpandedSql(stmt: bigint, out: Uint8Array): bigint;
declare function sqxParamCount(stmt: bigint): number;
declare function sqxParamName(stmt: bigint, index: number, out: Uint8Array): bigint;
declare function sqxBindNull(stmt: bigint, index: number): number;
declare function sqxBindDouble(stmt: bigint, index: number, value: number): number;
declare function sqxBindInt64(stmt: bigint, index: number, value: bigint): number;
declare function sqxBindText(stmt: bigint, index: number, value: string): number;
declare function sqxBindBlob(stmt: bigint, index: number, value: Uint8Array): number;
declare function sqxColumnCount(stmt: bigint): number;
declare function sqxColumnName(stmt: bigint, index: number, out: Uint8Array): bigint;
declare function sqxColumnOrigin(stmt: bigint, index: number, which: number, out: Uint8Array): bigint;
declare function sqxColumnType(stmt: bigint, index: number): number;
declare function sqxColumnInt64(stmt: bigint, index: number): bigint;
declare function sqxColumnDouble(stmt: bigint, index: number): number;
declare function sqxColumnText(stmt: bigint, index: number, out: Uint8Array): bigint;
declare function sqxColumnBlob(stmt: bigint, index: number, out: Uint8Array): bigint;
declare function sqxVersion(out: Uint8Array): bigint;

export type SQLInputValue = null | number | bigint | string | Uint8Array | boolean;
export type SQLOutputValue = null | number | bigint | string | Uint8Array;
export type SQLRow = Record<string, SQLOutputValue>;

export interface StatementResultingChanges {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface StatementColumnMetadata {
  column: string | null;
  database: string | null;
  name: string;
  table: string | null;
  type: string | null;
}

export interface DatabaseSyncOptions {
  open?: boolean;
  readOnly?: boolean;
  enableForeignKeyConstraints?: boolean;
  enableDoubleQuotedStringLiterals?: boolean;
  timeout?: number;
  readBigInts?: boolean;
  returnArrays?: boolean;
  allowBareNamedParameters?: boolean;
  allowUnknownNamedParameters?: boolean;
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
/** Compiled statements a database keeps for reuse while no call holds them. */
const POOL_LIMIT = 64;

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

function finalizedError(): SQLiteError {
  return stateError("statement has been finalized");
}

/** Rows as arrays (Node's returnArrays) are left out: rows are typed as
 * records here, as in Node's own type definitions, and scriptc refuses to
 * pass an array where a record is declared (SC2003). A union return type
 * would allow both, but then `stmt.get() as { id: number }`, the usual way
 * to read a row, stops compiling. */
function returnArraysError(): SQLiteError {
  return new SQLiteError(
    "returnArrays is not supported by this module: rows are always objects",
    "ERR_METHOD_NOT_IMPLEMENTED",
  );
}

// Text and bytes come back from C through a buffer this side owns: the C
// function copies what fits and returns the full length; a longer value is
// fetched again into a buffer of at least that size.
let scratch = new Uint8Array(256);
const decoder = new TextDecoder();

function fetchInto(fetch: (out: Uint8Array) => bigint): number {
  let n = Number(fetch(scratch));
  if (n > scratch.length) {
    scratch = new Uint8Array(Math.max(n, scratch.length * 2));
    n = Number(fetch(scratch));
  }
  return n;
}

function readText(fetch: (out: Uint8Array) => bigint): string {
  const n = fetchInto(fetch);
  return n <= 0 ? "" : decoder.decode(scratch.subarray(0, n));
}

/** Like readText, but null where the C side answers -1 (no value). */
function readTextOrNull(fetch: (out: Uint8Array) => bigint): string | null {
  const n = fetchInto(fetch);
  if (n < 0) return null;
  return n === 0 ? "" : decoder.decode(scratch.subarray(0, n));
}

function readBytes(fetch: (out: Uint8Array) => bigint): Uint8Array {
  const n = fetchInto(fetch);
  return n <= 0 ? new Uint8Array(0) : scratch.slice(0, n);
}

/** A parameter's name with its prefix ("$a", ":a", "@a"), or "?" for an
 * anonymous or numbered one ("?", "?2"). */
function paramName(stmt: bigint, index: number): string {
  return readTextOrNull((out) => sqxParamName(stmt, index, out)) ?? "?";
}

function sqliteError(db: bigint, rc: number): SQLiteError {
  const errcode = db === NULL_HANDLE ? rc : sqxErrcode(db);
  const message = db === NULL_HANDLE ? readText((out) => sqxErrstr(rc, out)) : readText((out) => sqxErrmsg(db, out));
  const error = new SQLiteError(message, "ERR_SQLITE_ERROR");
  error.errcode = errcode;
  error.errstr = readText((out) => sqxErrstr(errcode, out));
  return error;
}

function checkBoolean(name: string, value: boolean | undefined): void {
  if (value !== undefined && typeof value !== "boolean")
    throw new SQLiteError(`The "options.${name}" argument must be a boolean.`, "ERR_INVALID_ARG_TYPE");
}

/** The SQLite version compiled into this program, such as "3.54.1". */
export function sqliteVersion(): string {
  return readText((out) => sqxVersion(out));
}

interface StatementSettings {
  readBigInts: boolean;
  returnArrays: boolean;
  allowBareNamedParameters: boolean;
  allowUnknownNamedParameters: boolean;
}

export class DatabaseSync {
  #path: string;
  #readOnly: boolean;
  #foreignKeys: boolean;
  #dqs: boolean;
  #timeout: number;
  #defaults: StatementSettings;
  #db: bigint = NULL_HANDLE;
  /** Bumped by every open, so statements of an earlier connection see that
   * theirs is gone. */
  #generation = 0;
  /** Idle compiled statements by SQL text, oldest first. */
  #pool: Map<string, bigint[]> = new Map();
  #pooled = 0;
  /** Compiled statements a call or an iterator holds right now. */
  #lent: Set<bigint> = new Set();

  constructor(path: string, options?: DatabaseSyncOptions) {
    if (typeof path !== "string")
      throw new SQLiteError('The "path" argument must be a string.', "ERR_INVALID_ARG_TYPE");
    const o: DatabaseSyncOptions = options ?? {};
    checkBoolean("open", o.open);
    checkBoolean("readOnly", o.readOnly);
    checkBoolean("enableForeignKeyConstraints", o.enableForeignKeyConstraints);
    checkBoolean("enableDoubleQuotedStringLiterals", o.enableDoubleQuotedStringLiterals);
    checkBoolean("readBigInts", o.readBigInts);
    checkBoolean("returnArrays", o.returnArrays);
    if (o.returnArrays === true) throw returnArraysError();
    checkBoolean("allowBareNamedParameters", o.allowBareNamedParameters);
    checkBoolean("allowUnknownNamedParameters", o.allowUnknownNamedParameters);
    if (o.timeout !== undefined && (typeof o.timeout !== "number" || !Number.isInteger(o.timeout)))
      throw new SQLiteError('The "options.timeout" argument must be an integer.', "ERR_INVALID_ARG_TYPE");
    this.#path = path;
    this.#readOnly = o.readOnly === true;
    this.#foreignKeys = o.enableForeignKeyConstraints !== false;
    this.#dqs = o.enableDoubleQuotedStringLiterals === true;
    this.#timeout = o.timeout ?? 0;
    this.#defaults = {
      readBigInts: o.readBigInts === true,
      returnArrays: false,
      allowBareNamedParameters: o.allowBareNamedParameters !== false,
      allowUnknownNamedParameters: o.allowUnknownNamedParameters === true,
    };
    if (o.open !== false) this.open();
  }

  get isOpen(): boolean {
    return this.#db !== NULL_HANDLE;
  }

  get isTransaction(): boolean {
    return sqxInTransaction(this.#handle()) !== 0;
  }

  open(): void {
    if (this.#db !== NULL_HANDLE) throw stateError("database is already open");
    const db = sqxOpen(this.#path, this.#readOnly ? 1 : 0, this.#foreignKeys ? 1 : 0, this.#dqs ? 1 : 0, this.#timeout);
    const rc = sqxOpenFailed(db);
    if (rc !== SQLITE_OK) {
      const error = sqliteError(db, rc);
      if (db !== NULL_HANDLE) sqxClose(db);
      throw error;
    }
    this.#db = db;
    this.#generation++;
  }

  close(): void {
    const db = this.#handle();
    for (const handles of this.#pool.values()) for (const stmt of handles) sqxFinalize(stmt);
    for (const stmt of this.#lent) sqxFinalize(stmt);
    this.#pool = new Map();
    this.#pooled = 0;
    this.#lent = new Set();
    sqxClose(db);
    this.#db = NULL_HANDLE;
  }

  [Symbol.dispose](): void {
    if (this.#db !== NULL_HANDLE) this.close();
  }

  exec(sql: string): void {
    const db = this.#handle();
    const rc = sqxExec(db, sql);
    if (rc !== SQLITE_OK) throw sqliteError(db, rc);
  }

  prepare(sql: string): StatementSync {
    // Compile once now, so errors in the SQL surface here as in Node; the
    // compiled statement goes to the pool for the first call to use.
    const stmt = this._acquire(sql);
    const text = readText((out) => sqxSql(stmt, out));
    this._release(sql, stmt);
    return new StatementSync(this, sql, text, this.#generation, { ...this.#defaults });
  }

  /** @internal The open connection, or the error Node gives without one. */
  _handle(): bigint {
    return this.#handle();
  }

  /** @internal The connection a statement prepared at `generation` may
   * use, or the error Node gives when it is gone. */
  _handleFor(generation: number): bigint {
    if (this.#db === NULL_HANDLE || generation !== this.#generation) throw finalizedError();
    return this.#db;
  }

  /** @internal Borrow a compiled statement for `sql`. */
  _acquire(sql: string): bigint {
    const db = this.#handle();
    const idle = this.#pool.get(sql);
    let stmt = NULL_HANDLE;
    if (idle !== undefined && idle.length > 0) {
      stmt = idle.pop()!;
      this.#pooled--;
      if (idle.length === 0) this.#pool.delete(sql);
    } else {
      stmt = sqxPrepare(db, sql);
      const rc = sqxPrepareRc();
      if (rc !== SQLITE_OK) throw sqliteError(db, rc);
      if (stmt === NULL_HANDLE)
        throw new SQLiteError("The SQL query contains no statements.", "ERR_INVALID_ARG_VALUE");
    }
    this.#lent.add(stmt);
    return stmt;
  }

  /** @internal Give a borrowed statement back: reset, bindings cleared,
   * kept for reuse unless the pool is full. */
  _release(sql: string, stmt: bigint): void {
    if (!this.#lent.delete(stmt)) return; // finalized by close() meanwhile
    sqxReset(stmt);
    if (this.#pooled >= POOL_LIMIT) {
      // Drop the oldest idle statement to make room.
      for (const [oldSql, handles] of this.#pool) {
        sqxFinalize(handles.shift()!);
        this.#pooled--;
        if (handles.length === 0) this.#pool.delete(oldSql);
        break;
      }
    }
    const idle = this.#pool.get(sql);
    if (idle !== undefined) {
      // Move the key to the newest end.
      this.#pool.delete(sql);
      idle.push(stmt);
      this.#pool.set(sql, idle);
    } else this.#pool.set(sql, [stmt]);
    this.#pooled++;
  }

  /** @internal For tests: compiled statements kept or lent right now. */
  _statementCount(): number {
    return this.#pooled + this.#lent.size;
  }

  #handle(): bigint {
    if (this.#db === NULL_HANDLE) throw stateError("database is not open");
    return this.#db;
  }
}

export class StatementSync {
  #db: DatabaseSync;
  #sql: string;
  #text: string;
  #generation: number;
  #settings: StatementSettings;
  #closed = false;
  /** Bumped by every call; an iterator started earlier is then invalid, as
   * in Node, where the call resets the statement under it. */
  #calls = 0;
  #lastParams: unknown[] | null = null;

  /** @internal Use DatabaseSync.prototype.prepare. */
  constructor(db: DatabaseSync, sql: string, text: string, generation: number, settings: StatementSettings) {
    this.#db = db;
    this.#sql = sql;
    this.#text = text;
    this.#generation = generation;
    this.#settings = settings;
  }

  get sourceSQL(): string {
    this.#check();
    return this.#text;
  }

  get expandedSQL(): string {
    this.#check();
    const stmt = this.#db._acquire(this.#sql);
    try {
      if (this.#lastParams !== null) this.#bind(stmt, this.#lastParams);
      return readText((out) => sqxExpandedSql(stmt, out));
    } finally {
      this.#db._release(this.#sql, stmt);
    }
  }

  setReadBigInts(enabled: boolean): void {
    this.#check();
    this.#settings.readBigInts = enabled;
  }

  setReturnArrays(enabled: boolean): void {
    this.#check();
    if (enabled) throw returnArraysError();
    this.#settings.returnArrays = false;
  }

  setAllowBareNamedParameters(enabled: boolean): void {
    this.#check();
    this.#settings.allowBareNamedParameters = enabled;
  }

  setAllowUnknownNamedParameters(enabled: boolean): void {
    this.#check();
    this.#settings.allowUnknownNamedParameters = enabled;
  }

  columns(): StatementColumnMetadata[] {
    this.#check();
    const stmt = this.#db._acquire(this.#sql);
    try {
      const out: StatementColumnMetadata[] = [];
      const count = sqxColumnCount(stmt);
      for (let i = 0; i < count; i++) {
        out.push({
          column: readTextOrNull((buf) => sqxColumnOrigin(stmt, i, 2, buf)),
          database: readTextOrNull((buf) => sqxColumnOrigin(stmt, i, 0, buf)),
          name: readText((buf) => sqxColumnName(stmt, i, buf)),
          table: readTextOrNull((buf) => sqxColumnOrigin(stmt, i, 1, buf)),
          type: readTextOrNull((buf) => sqxColumnOrigin(stmt, i, 3, buf)),
        });
      }
      return out;
    } finally {
      this.#db._release(this.#sql, stmt);
    }
  }

  run(...params: unknown[]): StatementResultingChanges {
    const stmt = this.#start(params);
    try {
      const db = this.#db._handle();
      let rc = sqxStep(stmt);
      while (rc === SQLITE_ROW) rc = sqxStep(stmt);
      if (rc !== SQLITE_DONE) throw sqliteError(db, rc);
      const changes = sqxChanges(db);
      const rowid = sqxLastInsertRowid(db);
      if (this.#settings.readBigInts) return { changes, lastInsertRowid: rowid };
      return { changes: Number(changes), lastInsertRowid: Number(rowid) };
    } finally {
      this.#db._release(this.#sql, stmt);
    }
  }

  get(...params: unknown[]): SQLRow | undefined {
    const stmt = this.#start(params);
    try {
      const rc = sqxStep(stmt);
      if (rc === SQLITE_ROW) return this.#row(stmt, this.#columnNames(stmt));
      if (rc !== SQLITE_DONE) throw sqliteError(this.#db._handle(), rc);
      return undefined;
    } finally {
      this.#db._release(this.#sql, stmt);
    }
  }

  all(...params: unknown[]): SQLRow[] {
    const stmt = this.#start(params);
    try {
      const rows: SQLRow[] = [];
      const names = this.#columnNames(stmt);
      let rc = sqxStep(stmt);
      while (rc === SQLITE_ROW) {
        rows.push(this.#row(stmt, names));
        rc = sqxStep(stmt);
      }
      if (rc !== SQLITE_DONE) throw sqliteError(this.#db._handle(), rc);
      return rows;
    } finally {
      this.#db._release(this.#sql, stmt);
    }
  }

  iterate(...params: unknown[]): StatementIterator {
    const stmt = this.#start(params);
    try {
      return new StatementIterator(this, stmt, this.#columnNames(stmt), this.#calls);
    } catch (error) {
      this.#db._release(this.#sql, stmt);
      throw error;
    }
  }

  close(): void {
    this.#check();
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    this.#closed = true;
  }

  /** @internal The iterator's next row, or null when it is done. */
  _step(stmt: bigint, names: string[], call: number): SQLRow | null {
    this.#check();
    if (call !== this.#calls) throw stateError("iterator was invalidated");
    const rc = sqxStep(stmt);
    if (rc === SQLITE_ROW) return this.#row(stmt, names);
    if (rc !== SQLITE_DONE) throw sqliteError(this.#db._handle(), rc);
    return null;
  }

  /** @internal An iterator is done with its statement. */
  _finish(stmt: bigint): void {
    this.#db._release(this.#sql, stmt);
  }

  #check(): void {
    if (this.#closed) throw finalizedError();
    this.#db._handleFor(this.#generation);
  }

  #start(params: unknown[]): bigint {
    this.#check();
    this.#calls++;
    const stmt = this.#db._acquire(this.#sql);
    try {
      this.#bind(stmt, params);
    } catch (error) {
      this.#db._release(this.#sql, stmt);
      throw error;
    }
    this.#lastParams = params;
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
        if (index === 0) {
          if (this.#settings.allowUnknownNamedParameters) continue;
          throw stateError(`Unknown named parameter '${key}'`);
        }
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
      if (
        this.#settings.allowBareNamedParameters &&
        (prefix === "$" || prefix === ":" || prefix === "@") &&
        name.slice(1) === key
      )
        return i;
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
    else throw new SQLiteError(`Provided value cannot be bound to SQLite parameter ${index}.`, "ERR_INVALID_ARG_TYPE");
    if (rc !== SQLITE_OK) throw sqliteError(this.#db._handle(), rc);
  }

  #columnNames(stmt: bigint): string[] {
    const names: string[] = [];
    const count = sqxColumnCount(stmt);
    for (let i = 0; i < count; i++) names.push(readText((out) => sqxColumnName(stmt, i, out)));
    return names;
  }

  #row(stmt: bigint, names: string[]): SQLRow {
    // Rows have no prototype, as in Node.
    const row = Object.create(null) as SQLRow;
    for (let i = 0; i < names.length; i++) row[names[i]!] = this.#value(stmt, i);
    return row;
  }

  #value(stmt: bigint, i: number): SQLOutputValue {
    const type = sqxColumnType(stmt, i);
    if (type === SQLITE_INTEGER) {
      const value = sqxColumnInt64(stmt, i);
      if (this.#settings.readBigInts) return value;
      // Node refuses values outside the safe range in both directions.
      // (Node on Linux returns -2^63 itself rounded instead of refusing it,
      // while Node on macOS refuses it; this module refuses it everywhere.)
      if (value > MAX_SAFE || value < -MAX_SAFE)
        throw new SQLiteError(`Value is too large to be represented as a JavaScript number: ${value}`, "ERR_OUT_OF_RANGE");
      return Number(value);
    }
    if (type === SQLITE_FLOAT) return sqxColumnDouble(stmt, i);
    if (type === SQLITE_TEXT) return readText((out) => sqxColumnText(stmt, i, out));
    if (type === SQLITE_BLOB) return readBytes((out) => sqxColumnBlob(stmt, i, out));
    return null;
  }
}

/** What StatementSync.prototype.iterate returns: rows one at a time. The
 * compiled statement is held until the rows run out, return() is called,
 * or a row fails. */
export class StatementIterator implements IterableIterator<SQLRow> {
  #statement: StatementSync;
  #stmt: bigint;
  #names: string[];
  #call: number;
  #done = false;

  /** @internal */
  constructor(statement: StatementSync, stmt: bigint, names: string[], call: number) {
    this.#statement = statement;
    this.#stmt = stmt;
    this.#names = names;
    this.#call = call;
  }

  next(): IteratorResult<SQLRow> {
    if (this.#done) return { done: true, value: null };
    let row: SQLRow | null;
    try {
      row = this.#statement._step(this.#stmt, this.#names, this.#call);
    } catch (error) {
      this.#finish();
      throw error;
    }
    if (row === null) {
      this.#finish();
      return { done: true, value: null };
    }
    return { done: false, value: row };
  }

  return(): IteratorResult<SQLRow> {
    this.#finish();
    return { done: true, value: null };
  }

  [Symbol.iterator](): StatementIterator {
    return this;
  }

  #finish(): void {
    if (this.#done) return;
    this.#done = true;
    this.#statement._finish(this.#stmt);
  }
}
