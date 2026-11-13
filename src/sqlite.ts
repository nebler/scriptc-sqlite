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
declare function sqxRow(stmt: bigint, out: Uint8Array): bigint;
declare function sqxColumnsMode(): number;
declare function sqxGetenv(name: string, out: Uint8Array): bigint;
declare function sqxSerialize(db: bigint, schema: string): bigint;
declare function sqxSerializedTake(out: Uint8Array): void;
declare function sqxDeserialize(db: bigint, schema: string, data: Uint8Array): number;
declare function sqxDbFilename(db: bigint, schema: string, out: Uint8Array): bigint;
declare function sqxBackupOpen(src: bigint, path: string, source: string, target: string): bigint;
declare function sqxBackupOk(backup: bigint): number;
declare function sqxBackupStep(backup: bigint, pages: number): number;
declare function sqxBackupTotal(backup: bigint): number;
declare function sqxBackupRemaining(backup: bigint): number;
declare function sqxBackupErrcode(backup: bigint): number;
declare function sqxBackupErrmsg(backup: bigint, out: Uint8Array): bigint;
declare function sqxBackupFinish(backup: bigint): void;
declare function sqxStepRow(stmt: bigint, out: Uint8Array): bigint;
declare function sqxSetDispatch(
  fn: (op: number, id: bigint, ctx: bigint, argc: number, argv: bigint) => number,
): void;
declare function sqxCreateFunction(db: bigint, name: string, argc: number, flags: number, id: bigint): number;
declare function sqxCreateAggregate(
  db: bigint,
  name: string,
  argc: number,
  flags: number,
  id: bigint,
  window: number,
): number;
declare function sqxAggSlot(ctx: bigint): bigint;
declare function sqxAggSetSlot(ctx: bigint, value: bigint): void;
declare function sqxValueType(argv: bigint, index: number): number;
declare function sqxValueInt64(argv: bigint, index: number): bigint;
declare function sqxValueDouble(argv: bigint, index: number): number;
declare function sqxValueText(argv: bigint, index: number, out: Uint8Array): bigint;
declare function sqxValueBlob(argv: bigint, index: number, out: Uint8Array): bigint;
declare function sqxResultNull(ctx: bigint): void;
declare function sqxResultDouble(ctx: bigint, value: number): void;
declare function sqxResultInt64(ctx: bigint, value: bigint): void;
declare function sqxResultText(ctx: bigint, value: string): void;
declare function sqxResultBlob(ctx: bigint, value: Uint8Array): void;
declare function sqxResultError(ctx: bigint, message: string): void;

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

/** An argument of a user-defined function as the function sees it when it
 * declares fewer than all eight parameters: missing ones are undefined. */
export type SQLFunctionArgument = SQLOutputValue | undefined;

/** The shape `database.function` takes for a function written without
 * parameter types, such as `(a, b) => …`: up to eight parameters.
 *
 * Node declares `(...args: SQLOutputValue[]) => SQLInputValue`, but scriptc
 * 0.4.12 cannot pass a function with fixed parameters where a rest
 * parameter is declared (SC1090), and TypeScript types an unannotated
 * function from the first overload. So this shape comes first. Functions
 * with parameter types, rest parameters (`(...xs: SQLOutputValue[]) => …`)
 * or other return types take the second overload. */
export type SQLFunction = (
  a: SQLFunctionArgument,
  b: SQLFunctionArgument,
  c: SQLFunctionArgument,
  d: SQLFunctionArgument,
  e: SQLFunctionArgument,
  f: SQLFunctionArgument,
  g: SQLFunctionArgument,
  h: SQLFunctionArgument,
) => SQLInputValue;

/** An aggregate's step or inverse written without parameter types:
 * `(accumulator, value) => …`, up to seven values. */
export type SQLAggregateStep = (
  accumulator: SQLInputValue,
  a: SQLFunctionArgument,
  b: SQLFunctionArgument,
  c: SQLFunctionArgument,
  d: SQLFunctionArgument,
  e: SQLFunctionArgument,
  f: SQLFunctionArgument,
  g: SQLFunctionArgument,
) => SQLInputValue;

export interface FunctionOptions {
  deterministic?: boolean;
  directOnly?: boolean;
  useBigIntArguments?: boolean;
  varargs?: boolean;
}

export interface AggregateOptions extends FunctionOptions {
  start: SQLInputValue | (() => SQLInputValue);
  step: SQLAggregateStep;
  result?: (accumulator: SQLInputValue) => SQLInputValue;
  inverse?: SQLAggregateStep;
}

/** Aggregate options whose functions have parameter types or rest
 * parameters, which SQLAggregateStep does not take (see SQLFunction). */
export interface AnyAggregateOptions extends FunctionOptions {
  start: any;
  step: any;
  result?: any;
  inverse?: any;
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

// Rows are read packed: one FFI call steps the statement and copies every
// value of the row into rowBuffer (format in native/shim.c, sqx_row).
// SCRIPTC_SQLITE_ROW_READS=columns reads them the day-1 way instead, one or
// two calls per value, so a benchmark can compare the two in one binary.
// (The C side reads the variable: process.env costs about 10 MiB per
// thread in scriptc 0.4.12.)
let rowBuffer = new Uint8Array(4096);
const packedRows = sqxColumnsMode() === 0;
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

// ── User-defined functions ─────────────────────────────────────────────
//
// SQLite calls a user function from inside sqlite3_step, long after the
// call that registered it, so the shim holds one retained FFI callback per
// thread, `dispatch` below, and passes it the function's id and SQLite's
// context and argument pointers. Functions are kept here by id, per thread,
// like everything else in this module.
//
// An exception in user code must never leave `dispatch`: a scriptc callback
// that throws returns 0 to C and the exception only resumes once the outer
// native call returns. So `dispatch` catches everything, keeps the
// exception, and tells the shim to fail the SQL function. The call that
// stepped the statement then throws that exception instead of SQLite's
// error, as node:sqlite does.

const OP_FUNC = 0;
const OP_STEP = 1;
const OP_INVERSE = 2;
const OP_VALUE = 3;
const OP_FINAL = 4;
const OP_DESTROY = 5;
const SQLITE_DETERMINISTIC = 0x800;
const SQLITE_DIRECTONLY = 0x80000;

type AnyCall = (...args: unknown[]) => unknown;

interface Registered {
  bigints: boolean;
  fn: unknown;
  start: unknown;
  inverse: unknown;
  result: unknown;
}

/** One aggregate group's state, found through the slot number the shim
 * keeps in SQLite's aggregate context. */
interface Group {
  value: unknown;
  window: boolean;
}

const registered: Map<bigint, Registered> = new Map();
const groups: Map<bigint, Group> = new Map();
let nextFunctionId = 0n;
let nextGroupId = 0n;
let dispatchSet = false;
let callbackFailed = false;
let callbackError: unknown = undefined;
/** User code running inside a SQLite callback right now (deserialize
 * refuses then, as in Node). */
let callbackDepth = 0;

/** The error a failed step or exec throws: the exception a user function
 * threw, if one did, else SQLite's. */
function stepError(db: bigint, rc: number): unknown {
  if (callbackFailed) {
    const error = callbackError;
    callbackFailed = false;
    callbackError = undefined;
    return error;
  }
  return sqliteError(db, rc);
}

/** Forget an exception left by a callback whose failure SQLite ignored
 * (an aggregate finalized while a statement was reset). */
function clearCallbackError(): void {
  callbackFailed = false;
  callbackError = undefined;
}

function dispatch(op: number, id: bigint, ctx: bigint, argc: number, argv: bigint): number {
  if (op === OP_DESTROY) {
    registered.delete(id);
    return 1;
  }
  callbackDepth++;
  try {
    return dispatchCall(op, id, ctx, argc, argv);
  } finally {
    callbackDepth--;
  }
}

function dispatchCall(op: number, id: bigint, ctx: bigint, argc: number, argv: bigint): number {
  try {
    const entry = registered.get(id);
    if (entry === undefined) {
      sqxResultError(ctx, "user-defined function is no longer defined");
      return 1;
    }
    if (op === OP_FUNC) {
      setResult(ctx, (entry.fn as AnyCall)(...functionArguments(argc, argv, entry.bigints)));
      return 1;
    }
    const slot = groupSlot(ctx, entry);
    if (slot < 0n) return 1;
    const group = groups.get(slot)!;
    if (op === OP_STEP || op === OP_INVERSE) {
      const args = functionArguments(argc, argv, entry.bigints);
      const fn = op === OP_STEP ? entry.fn : entry.inverse;
      group.value = (fn as AnyCall)(group.value, ...args);
      return 1;
    }
    // OP_VALUE or OP_FINAL. Node gives no result from xFinal once the
    // aggregate ran as a window function; SQLite never uses it then.
    if (op === OP_VALUE) group.window = true;
    else if (group.window) {
      groups.delete(slot);
      return 1;
    }
    try {
      setResult(ctx, entry.result !== undefined ? (entry.result as AnyCall)(group.value) : group.value);
    } finally {
      if (op === OP_FINAL) groups.delete(slot);
    }
    return 1;
  } catch (error) {
    // The first exception wins: once a step fails, SQLite still finalizes
    // the group, and a result function that throws too must not hide the
    // cause. (Node 24 loses the step's exception when the aggregate has a
    // result function: get() and all() return undefined; see NOTES.md.)
    if (!callbackFailed) {
      callbackFailed = true;
      callbackError = error;
    }
    return 0;
  }
}

/** The slot of the group SQLite is aggregating, set up with the start
 * value on first use; -1 after setting an error result. */
function groupSlot(ctx: bigint, entry: Registered): bigint {
  const slot = sqxAggSlot(ctx);
  if (slot !== 0n) {
    if (slot < 0n) sqxResultError(ctx, "out of memory");
    return slot;
  }
  const start = typeof entry.start === "function" ? (entry.start as AnyCall)() : entry.start;
  const created = ++nextGroupId;
  groups.set(created, { value: start, window: false });
  sqxAggSetSlot(ctx, created);
  return created;
}

function functionArguments(argc: number, argv: bigint, bigints: boolean): SQLOutputValue[] {
  const args: SQLOutputValue[] = [];
  for (let i = 0; i < argc; i++) {
    const type = sqxValueType(argv, i);
    if (type === SQLITE_INTEGER) {
      const value = sqxValueInt64(argv, i);
      if (bigints) args.push(value);
      else if (value > MAX_SAFE || value < -MAX_SAFE)
        throw new SQLiteError(`Value is too large to be represented as a JavaScript number: ${value}`, "ERR_OUT_OF_RANGE");
      else args.push(Number(value));
    } else if (type === SQLITE_FLOAT) args.push(sqxValueDouble(argv, i));
    else if (type === SQLITE_TEXT) args.push(readText((out) => sqxValueText(argv, i, out)));
    else if (type === SQLITE_BLOB) args.push(readBytes((out) => sqxValueBlob(argv, i, out)));
    else args.push(null);
  }
  return args;
}

/** A user function's return value as the SQL result, by Node's rules:
 * null and undefined → NULL, number → REAL, string → TEXT, Uint8Array →
 * BLOB, bigint → INTEGER. Anything else (booleans too) is an SQL error. */
function setResult(ctx: bigint, value: unknown): void {
  if (value === null || value === undefined) sqxResultNull(ctx);
  else if (typeof value === "number") sqxResultDouble(ctx, value);
  else if (typeof value === "string") sqxResultText(ctx, value);
  else if (value instanceof Uint8Array) sqxResultBlob(ctx, value);
  else if (typeof value === "bigint") {
    if (value < INT64_MIN || value > INT64_MAX) sqxResultError(ctx, "BigInt value is too large for SQLite");
    else sqxResultInt64(ctx, value);
  } else if (value instanceof Promise) sqxResultError(ctx, "Asynchronous user-defined functions are not supported");
  else sqxResultError(ctx, "Returned JavaScript value cannot be converted to a SQLite value");
}

/** @internal For tests: user functions this thread keeps, and aggregate
 * groups in progress. */
export function _userFunctionState(): { functions: number; groups: number } {
  return { functions: registered.size, groups: groups.size };
}

/** Registers `dispatch` with the shim, once per thread. */
function ensureDispatch(): void {
  if (dispatchSet) return;
  sqxSetDispatch(dispatch);
  dispatchSet = true;
}

function functionLength(fn: unknown): number {
  return (fn as AnyCall).length;
}

function checkBoolean(name: string, value: boolean | undefined): void {
  if (value !== undefined && typeof value !== "boolean")
    throw new SQLiteError(`The "options.${name}" argument must be a boolean.`, "ERR_INVALID_ARG_TYPE");
}

/** An environment variable, or undefined. Not part of node:sqlite: in
 * scriptc 0.4.12, reading process.env makes a program use tens of MiB
 * more memory (a hello-world goes from 4 to 43 MiB); this reads it through
 * C's getenv instead. Under Node, use process.env. */
export function getEnv(name: string): string | undefined {
  const value = readTextOrNull((out) => sqxGetenv(name, out));
  return value === null ? undefined : value;
}

/** The SQLite version compiled into this program, such as "3.54.1". */
function schemaName(dbName: string | undefined): string {
  if (dbName === undefined) return "main";
  if (typeof dbName !== "string") throw new SQLiteError('The "dbName" argument must be a string.', "ERR_INVALID_ARG_TYPE");
  return dbName;
}

export interface BackupOptions {
  /** Pages copied per round (default 100). */
  rate?: number;
  /** The schema copied from (default "main"). */
  source?: string;
  /** The schema written to in the destination (default "main"). */
  target?: string;
  /** Called between rounds while pages remain. */
  progress?: (progress: { totalPages: number; remainingPages: number }) => void;
}

/** Copies `sourceDb` into the database file at `path` while it stays
 * usable, as Node's `backup`: `rate` pages per round, the event loop
 * runs between rounds, and the promise gives the number of pages. Node
 * copies on its thread pool; here each round runs on this thread. */
export function backup(sourceDb: DatabaseSync, path: string, options?: BackupOptions): Promise<number> {
  const db = sourceDb._handle();
  if (typeof path !== "string")
    throw new SQLiteError('The "path" argument must be a string, Uint8Array, or URL without null bytes.', "ERR_INVALID_ARG_TYPE");
  const o: BackupOptions = options ?? {};
  let rate = 100;
  if (o.rate !== undefined) {
    if (typeof o.rate !== "number" || !Number.isInteger(o.rate) || o.rate > 2147483647 || o.rate < -2147483648)
      throw new SQLiteError('The "options.rate" argument must be an integer.', "ERR_INVALID_ARG_TYPE");
    if (o.rate <= 0)
      throw new SQLiteError('The "options.rate" argument must be a positive integer.', "ERR_OUT_OF_RANGE");
    rate = o.rate;
  }
  if (o.source !== undefined && typeof o.source !== "string")
    throw new SQLiteError('The "options.source" argument must be a string.', "ERR_INVALID_ARG_TYPE");
  if (o.target !== undefined && typeof o.target !== "string")
    throw new SQLiteError('The "options.target" argument must be a string.', "ERR_INVALID_ARG_TYPE");
  if (o.progress !== undefined && typeof o.progress !== "function")
    throw new SQLiteError('The "options.progress" argument must be a function.', "ERR_INVALID_ARG_TYPE");
  return runBackup(db, path, rate, o.source ?? "main", o.target ?? "main", o.progress);
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function backupError(handle: bigint): SQLiteError {
  const errcode = sqxBackupErrcode(handle);
  const error = new SQLiteError(readText((out) => sqxBackupErrmsg(handle, out)), "ERR_SQLITE_ERROR");
  error.errcode = errcode;
  error.errstr = readText((out) => sqxErrstr(errcode, out));
  return error;
}

async function runBackup(
  db: bigint,
  path: string,
  rate: number,
  source: string,
  target: string,
  progress: ((progress: { totalPages: number; remainingPages: number }) => void) | undefined,
): Promise<number> {
  await nextTurn();
  const handle = sqxBackupOpen(db, path, source, target);
  if (handle === NULL_HANDLE) throw sqliteError(NULL_HANDLE, 7); // SQLITE_NOMEM
  try {
    if (sqxBackupOk(handle) === 0) throw backupError(handle);
    for (;;) {
      const rc = sqxBackupStep(handle, rate);
      if (rc !== SQLITE_OK && rc !== SQLITE_DONE && rc !== SQLITE_BUSY && rc !== SQLITE_LOCKED)
        throw sqliteError(NULL_HANDLE, rc);
      const total = sqxBackupTotal(handle);
      const remaining = sqxBackupRemaining(handle);
      if (remaining !== 0) {
        if (progress !== undefined) progress({ totalPages: total, remainingPages: remaining });
        await nextTurn();
        continue;
      }
      if (rc !== SQLITE_DONE) throw backupError(handle);
      return total;
    }
  } finally {
    sqxBackupFinish(handle);
  }
}

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
    this.#finalizeAll();
    sqxClose(db);
    this.#db = NULL_HANDLE;
  }

  /** The file of the database, or null for an in-memory or temporary
   * one. `dbName` is the schema: "main" (the default), "temp", or an
   * attached name. */
  location(dbName?: string): string | null {
    const db = this.#handle();
    return readTextOrNull((out) => sqxDbFilename(db, schemaName(dbName), out));
  }

  /** The whole database as bytes, as SQLite would write it to a file. */
  serialize(dbName?: string): Uint8Array {
    const db = this.#handle();
    const size = Number(sqxSerialize(db, schemaName(dbName)));
    if (size < 0) throw sqliteError(db, sqxErrcode(db));
    const out = new Uint8Array(size);
    sqxSerializedTake(out);
    return out;
  }

  /** Replaces the database (or schema `options.dbName`) with `buffer`,
   * which serialize() gave. Statements prepared before are finalized, as
   * in Node. */
  deserialize(buffer: Uint8Array, options?: { dbName?: string }): void {
    const db = this.#handle();
    if (callbackDepth > 0) throw stateError("database cannot be deserialized while in a callback");
    if (!(buffer instanceof Uint8Array))
      throw new SQLiteError('The "buffer" argument must be a Uint8Array.', "ERR_INVALID_ARG_TYPE");
    if (buffer.length === 0)
      throw new SQLiteError('The "buffer" argument must not be empty.', "ERR_INVALID_ARG_VALUE");
    const name = schemaName(options === undefined ? undefined : options.dbName);
    this.#finalizeAll();
    this.#generation++;
    const rc = sqxDeserialize(db, name, buffer);
    if (rc !== SQLITE_OK) throw sqliteError(db, rc);
  }

  #finalizeAll(): void {
    for (const handles of this.#pool.values()) for (const stmt of handles) sqxFinalize(stmt);
    for (const stmt of this.#lent) sqxFinalize(stmt);
    this.#pool = new Map();
    this.#pooled = 0;
    this.#lent = new Set();
  }

  [Symbol.dispose](): void {
    if (this.#db !== NULL_HANDLE) this.close();
  }

  exec(sql: string): void {
    const db = this.#handle();
    clearCallbackError();
    const rc = sqxExec(db, sql);
    if (rc !== SQLITE_OK) throw stepError(db, rc);
  }

  /** Defines or replaces the SQL function `name`, as in Node. Unless
   * `varargs` is set, SQL must call it with exactly `fn.length` arguments.
   * See SQLFunction for why there are two signatures. */
  function(name: string, fn: SQLFunction): void;
  function(name: string, options: FunctionOptions, fn: SQLFunction): void;
  function(name: string, fn: any): void;
  function(name: string, options: FunctionOptions, fn: any): void;
  function(name: string, second: unknown, third?: unknown): void {
    const db = this.#handle();
    if (typeof name !== "string")
      throw new SQLiteError('The "name" argument must be a string.', "ERR_INVALID_ARG_TYPE");
    const fn: unknown = third === undefined ? second : third;
    let options: FunctionOptions = {};
    if (third !== undefined) {
      if (second === null || typeof second !== "object")
        throw new SQLiteError('The "options" argument must be an object.', "ERR_INVALID_ARG_TYPE");
      options = second as FunctionOptions;
    }
    checkBoolean("useBigIntArguments", options.useBigIntArguments);
    checkBoolean("varargs", options.varargs);
    checkBoolean("deterministic", options.deterministic);
    checkBoolean("directOnly", options.directOnly);
    if (typeof fn !== "function")
      throw new SQLiteError('The "function" argument must be a function.', "ERR_INVALID_ARG_TYPE");
    const argc = options.varargs === true ? -1 : functionLength(fn);
    let flags = 0;
    if (options.deterministic === true) flags |= SQLITE_DETERMINISTIC;
    if (options.directOnly === true) flags |= SQLITE_DIRECTONLY;
    ensureDispatch();
    const id = ++nextFunctionId;
    registered.set(id, {
      bigints: options.useBigIntArguments === true,
      fn,
      start: undefined,
      inverse: undefined,
      result: undefined,
    });
    // On failure SQLite drops the function, which removes it from
    // `registered` again.
    const rc = sqxCreateFunction(db, name, argc, flags, id);
    if (rc !== SQLITE_OK) throw sqliteError(db, rc);
  }

  /** Defines or replaces the aggregate `name`, as in Node; with `inverse`
   * it is also a window function. Like Node, this ignores `deterministic`. */
  aggregate(name: string, options: AggregateOptions): void;
  aggregate(name: string, options: AnyAggregateOptions): void;
  aggregate(name: string, options: unknown): void {
    const db = this.#handle();
    const o = options as AnyAggregateOptions;
    const start: unknown = o.start;
    const step: unknown = o.step;
    const result: unknown = o.result;
    const inverse: unknown = o.inverse;
    if (start === undefined)
      throw new SQLiteError(
        'The "options.start" argument must be a function or a primitive value.',
        "ERR_INVALID_ARG_TYPE",
      );
    if (typeof step !== "function")
      throw new SQLiteError('The "options.step" argument must be a function.', "ERR_INVALID_ARG_TYPE");
    checkBoolean("useBigIntArguments", o.useBigIntArguments);
    checkBoolean("varargs", o.varargs);
    checkBoolean("directOnly", o.directOnly);
    if (inverse !== undefined && typeof inverse !== "function")
      throw new SQLiteError('The "options.inverse" argument must be a function.', "ERR_INVALID_ARG_TYPE");
    // Node's count: the step's parameters after the accumulator, or the
    // inverse's if it takes more, and at least 0.
    let argc = -1;
    if (o.varargs !== true) {
      argc = functionLength(step) - 1;
      const other = inverse !== undefined ? functionLength(inverse) : functionLength(step);
      argc = Math.max(argc, other - 1, 0);
    }
    ensureDispatch();
    const id = ++nextFunctionId;
    registered.set(id, {
      bigints: o.useBigIntArguments === true,
      fn: step,
      start,
      inverse,
      result: typeof result === "function" ? result : undefined,
    });
    const flags = o.directOnly === true ? SQLITE_DIRECTONLY : 0;
    const rc = sqxCreateAggregate(db, name, argc, flags, id, inverse !== undefined ? 1 : 0);
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
      if (rc !== SQLITE_DONE) throw stepError(db, rc);
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
      const row = this.#next(stmt, []);
      return row === null ? undefined : row;
    } finally {
      this.#db._release(this.#sql, stmt);
    }
  }

  all(...params: unknown[]): SQLRow[] {
    const stmt = this.#start(params);
    try {
      const rows: SQLRow[] = [];
      const names: string[] = [];
      for (let row = this.#next(stmt, names); row !== null; row = this.#next(stmt, names)) rows.push(row);
      return rows;
    } finally {
      this.#db._release(this.#sql, stmt);
    }
  }

  iterate(...params: unknown[]): StatementIterator {
    const stmt = this.#start(params);
    try {
      return new StatementIterator(this, stmt, [], this.#calls);
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
    clearCallbackError();
    return this.#next(stmt, names);
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
    clearCallbackError();
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

  /** Steps: the next row, or null when there are no more. `names` starts
   * empty and is filled when the first row arrives: a pooled statement
   * whose table changed (ALTER TABLE) is recompiled by SQLite during that
   * step, and only then has its new columns. */
  #next(stmt: bigint, names: string[]): SQLRow | null {
    if (!packedRows) {
      const rc = sqxStep(stmt);
      if (rc === SQLITE_ROW) {
        if (names.length === 0) for (const n of this.#columnNames(stmt)) names.push(n);
        return this.#row(stmt, names);
      }
      if (rc !== SQLITE_DONE) throw stepError(this.#db._handle(), rc);
      return null;
    }
    // Keep the buffer this call used: a user function that runs a query
    // during the step may replace rowBuffer meanwhile.
    let buffer = rowBuffer;
    let n = Number(sqxStepRow(stmt, buffer));
    if (n < 0) {
      const rc = -1 - n;
      if (rc !== SQLITE_DONE) throw stepError(this.#db._handle(), rc);
      return null;
    }
    if (n > buffer.length) {
      buffer = new Uint8Array(Math.max(n, buffer.length * 2));
      rowBuffer = buffer;
      n = Number(sqxRow(stmt, buffer));
    }
    if (names.length === 0) for (const name of this.#columnNames(stmt)) names.push(name);
    return this.#unpack(buffer, names);
  }

  #unpack(buffer: Uint8Array, names: string[]): SQLRow {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    // Rows have no prototype, as in Node.
    const row = Object.create(null) as SQLRow;
    let at = 0;
    for (let i = 0; i < names.length; i++) {
      const type = buffer[at]!;
      at++;
      let value: SQLOutputValue = null;
      if (type === SQLITE_INTEGER) {
        if (this.#settings.readBigInts) value = view.getBigInt64(at, true);
        else {
          // Exact as a number while the high word is within ±2^21.
          const high = view.getInt32(at + 4, true);
          const n = high * 4294967296 + view.getUint32(at, true);
          if (high < -0x200000 || high >= 0x200000 || n < -Number.MAX_SAFE_INTEGER) {
            const big = view.getBigInt64(at, true);
            throw new SQLiteError(`Value is too large to be represented as a JavaScript number: ${big}`, "ERR_OUT_OF_RANGE");
          }
          value = n;
        }
        at += 8;
      } else if (type === SQLITE_FLOAT) {
        value = view.getFloat64(at, true);
        at += 8;
      } else if (type === SQLITE_TEXT || type === SQLITE_BLOB) {
        const length = view.getUint32(at, true);
        at += 4;
        if (type === SQLITE_TEXT) value = length === 0 ? "" : decoder.decode(buffer.subarray(at, at + length));
        else value = buffer.slice(at, at + length);
        at += length;
      }
      row[names[i]!] = value;
    }
    return row;
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
