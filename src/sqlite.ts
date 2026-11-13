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
declare function sqxChangesF64(db: bigint): number;
declare function sqxLastInsertRowidF64(db: bigint): number;
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
declare function sqxColumnSafeInt(stmt: bigint, index: number): number;
declare function sqxColumnNumber(stmt: bigint, index: number): number;
declare function sqxColumnTextTyped(stmt: bigint, index: number, out: Uint8Array): number;
declare function sqxColumnBlobTyped(stmt: bigint, index: number, out: Uint8Array): number;
declare function sqxColumnDouble(stmt: bigint, index: number): number;
declare function sqxColumnText(stmt: bigint, index: number, out: Uint8Array): number;
declare function sqxColumnBlob(stmt: bigint, index: number, out: Uint8Array): number;
declare function sqxVersion(out: Uint8Array): bigint;
declare function sqxRow(stmt: bigint, out: Uint8Array): number;
declare function sqxPackedMode(): number;
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
declare function sqxStepRow(stmt: bigint, out: Uint8Array): number;
declare function sqxSetDispatch(fn: (op: number, id: number, argc: number) => number): void;
declare function sqxCreateFunction(db: bigint, name: string, argc: number, flags: number, id: number): number;
declare function sqxCreateAggregate(
  db: bigint,
  name: string,
  argc: number,
  flags: number,
  id: number,
  window: number,
): number;
// User-defined function callbacks: the shim keeps the current call's
// context and arguments, so these take no pointers (see native/shim.c).
declare function sqxAggSlot(): number;
declare function sqxAggSetSlot(value: number): void;
declare function sqxValueType(index: number): number;
declare function sqxValueInt64(index: number): bigint;
declare function sqxValueDouble(index: number): number;
declare function sqxValueSafeInt(index: number): number;
declare function sqxValueText(index: number, out: Uint8Array): number;
declare function sqxValueBlob(index: number, out: Uint8Array): number;
declare function sqxResultNull(): void;
declare function sqxResultDouble(value: number): void;
declare function sqxResultInt64(value: bigint): void;
declare function sqxResultText(value: string): void;
declare function sqxResultBlob(value: Uint8Array): void;
declare function sqxResultError(message: string): void;

export type SQLInputValue = null | number | bigint | string | Uint8Array | boolean;
export type SQLOutputValue = null | number | bigint | string | Uint8Array;
export type SQLRow = Record<string, SQLOutputValue>;
/** What map() and forEach() take after the callback: values for anonymous
 * parameters, optionally after one object of named ones. */
export type SQLParameters = SQLInputValue | Record<string, SQLInputValue>;

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
const SQLITE_NULL = 5;
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

// Rows are read one value at a time: a call for the type and one for the
// value. SCRIPTC_SQLITE_ROW_READS=packed reads them packed instead (one
// FFI call steps and copies the whole row into rowBuffer; format in
// native/shim.c, sqx_row), so a benchmark can compare the two in one
// binary. Packed reads measured slower: FFI calls are cheap in scriptc
// (a few nanoseconds), and packing walks each row twice in C and again
// in TypeScript. (The C side reads the variable: process.env costs about
// 10 MiB per thread in scriptc 0.4.12.)
let rowBuffer = new Uint8Array(4096);
let rowView = new DataView(rowBuffer.buffer);
const packedRows = sqxPackedMode() === 1;

/** UTF-8 bytes as a string. A new TextDecoder per call is deliberate: in
 * scriptc 0.4.12 decoding through one reused decoder costs about three
 * times as much (it keeps streaming state between calls). */
function utf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

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
  return n <= 0 ? "" : utf8(scratch.subarray(0, n));
}

/** Like readText, but null where the C side answers -1 (no value). */
function readTextOrNull(fetch: (out: Uint8Array) => bigint): string | null {
  const n = fetchInto(fetch);
  if (n < 0) return null;
  return n === 0 ? "" : utf8(scratch.subarray(0, n));
}

function readBytes(fetch: (out: Uint8Array) => bigint): Uint8Array {
  const n = fetchInto(fetch);
  return n <= 0 ? new Uint8Array(0) : scratch.slice(0, n);
}

// The same as readText/readBytes for the hottest reads, written out
// without a callback: a closure per value is measurable in scriptc.
function columnText(stmt: bigint, i: number): string {
  let n = sqxColumnText(stmt, i, scratch);
  if (n > scratch.length) {
    scratch = new Uint8Array(Math.max(n, scratch.length * 2));
    n = sqxColumnText(stmt, i, scratch);
  }
  return n <= 0 ? "" : utf8(scratch.subarray(0, n));
}

function columnBlob(stmt: bigint, i: number): Uint8Array {
  let n = sqxColumnBlob(stmt, i, scratch);
  if (n > scratch.length) {
    scratch = new Uint8Array(Math.max(n, scratch.length * 2));
    n = sqxColumnBlob(stmt, i, scratch);
  }
  return n <= 0 ? new Uint8Array(0) : scratch.slice(0, n);
}

function valueText(i: number): string {
  let n = sqxValueText(i, scratch);
  if (n > scratch.length) {
    scratch = new Uint8Array(Math.max(n, scratch.length * 2));
    n = sqxValueText(i, scratch);
  }
  return n <= 0 ? "" : utf8(scratch.subarray(0, n));
}

function valueBlob(i: number): Uint8Array {
  let n = sqxValueBlob(i, scratch);
  if (n > scratch.length) {
    scratch = new Uint8Array(Math.max(n, scratch.length * 2));
    n = sqxValueBlob(i, scratch);
  }
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

/** A user function or aggregate. The callbacks are cast to AnyCall once,
 * here, rather than on every call: a cast from unknown to a function type
 * costs scriptc 0.4.12 about as much as the call itself. */
interface Registered {
  bigints: boolean;
  fn: AnyCall;
  start: unknown;
  inverse: AnyCall | null;
  result: AnyCall | null;
}

/** One aggregate group's state, found through the slot number the shim
 * keeps in SQLite's aggregate context. */
interface Group {
  value: unknown;
  window: boolean;
}

const registered: Map<number, Registered> = new Map();
const groups: Map<number, Group> = new Map();
let nextFunctionId = 0;
let nextGroupId = 0;
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
  // Only when set: this runs once per row, and writing an unknown is not free.
  if (!callbackFailed) return;
  callbackFailed = false;
  callbackError = undefined;
}

function dispatch(op: number, id: number, argc: number): number {
  if (op === OP_DESTROY) {
    registered.delete(id);
    return 1;
  }
  callbackDepth++;
  try {
    return dispatchCall(op, id, argc);
  } finally {
    callbackDepth--;
  }
}

function dispatchCall(op: number, id: number, argc: number): number {
  try {
    const entry = registered.get(id);
    if (entry === undefined) {
      sqxResultError("user-defined function is no longer defined");
      return 1;
    }
    if (op === OP_FUNC) {
      setResult(callFunction(entry.fn, argc, entry.bigints));
      return 1;
    }
    const slot = groupSlot(entry);
    if (slot < 0) return 1;
    const group = groups.get(slot)!;
    if (op === OP_STEP || op === OP_INVERSE) {
      const fn = op === OP_STEP ? entry.fn : entry.inverse!;
      group.value = callStep(fn, group.value, argc, entry.bigints);
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
      setResult(entry.result !== null ? entry.result(group.value) : group.value);
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
function groupSlot(entry: Registered): number {
  const slot = sqxAggSlot();
  if (slot !== 0) {
    if (slot < 0) sqxResultError("out of memory");
    return slot;
  }
  const start = typeof entry.start === "function" ? (entry.start as AnyCall)() : entry.start;
  const created = ++nextGroupId;
  groups.set(created, { value: start, window: false });
  sqxAggSetSlot(created);
  return created;
}

function functionArgument(i: number, bigints: boolean): SQLOutputValue {
  const type = sqxValueType(i);
  if (type === SQLITE_INTEGER) {
    if (bigints) return sqxValueInt64(i);
    const value = sqxValueSafeInt(i);
    if (value !== value) {
      const big = sqxValueInt64(i);
      throw new SQLiteError(`Value is too large to be represented as a JavaScript number: ${big}`, "ERR_OUT_OF_RANGE");
    }
    return value;
  }
  if (type === SQLITE_FLOAT) return sqxValueDouble(i);
  if (type === SQLITE_TEXT) return valueText(i);
  if (type === SQLITE_BLOB) return valueBlob(i);
  return null;
}

function functionArguments(argc: number, bigints: boolean): SQLOutputValue[] {
  const args: SQLOutputValue[] = [];
  for (let i = 0; i < argc; i++) args.push(functionArgument(i, bigints));
  return args;
}

/** fn(...arguments) without building and spreading an array for the
 * common small counts (a spread call is several times slower in scriptc). */
function callFunction(fn: AnyCall, argc: number, bigints: boolean): unknown {
  if (argc === 0) return fn();
  if (argc === 1) return fn(functionArgument(0, bigints));
  if (argc === 2) return fn(functionArgument(0, bigints), functionArgument(1, bigints));
  if (argc === 3)
    return fn(functionArgument(0, bigints), functionArgument(1, bigints), functionArgument(2, bigints));
  return fn(...functionArguments(argc, bigints));
}

/** fn(state, ...arguments), likewise. */
function callStep(fn: AnyCall, state: unknown, argc: number, bigints: boolean): unknown {
  if (argc === 0) return fn(state);
  if (argc === 1) return fn(state, functionArgument(0, bigints));
  if (argc === 2) return fn(state, functionArgument(0, bigints), functionArgument(1, bigints));
  return fn(state, ...functionArguments(argc, bigints));
}

/** A user function's return value as the SQL result, by Node's rules:
 * null and undefined → NULL, number → REAL, string → TEXT, Uint8Array →
 * BLOB, bigint → INTEGER. Anything else (booleans too) is an SQL error. */
function setResult(value: unknown): void {
  if (value === null || value === undefined) sqxResultNull();
  else if (typeof value === "number") sqxResultDouble(value);
  else if (typeof value === "string") sqxResultText(value);
  else if (value instanceof Uint8Array) sqxResultBlob(value);
  else if (typeof value === "bigint") {
    if (value < INT64_MIN || value > INT64_MAX) sqxResultError("BigInt value is too large for SQLite");
    else sqxResultInt64(value);
  } else if (value instanceof Promise) sqxResultError("Asynchronous user-defined functions are not supported");
  else sqxResultError("Returned JavaScript value cannot be converted to a SQLite value");
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

/** Whether a database's statements are still valid: close() and
 * deserialize() finalize them and replace the token, so a column reader
 * checks one field instead of calling into the database per read. */
class Liveness {
  alive = true;
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
  // The most recently released statement, outside the map: a statement
  // run in a loop comes back here and is taken again with one string
  // comparison, instead of map operations that hash its SQL. Counted in
  // #pooled; always the newest idle statement.
  #hotSql = "";
  #hotStmt: bigint = NULL_HANDLE;
  #pooled = 0;
  /** Compiled statements a call or an iterator holds right now. */
  // Statements lent out right now (run, get, all, an open iterator), for
  // close() and deserialize() to finalize. An array, not a set: they come
  // back almost always in reverse order, so giving one back is a pop()
  // rather than hashing a bigint twice per run(). (Not sqlite3_next_stmt
  // in C: extensions such as FTS5 keep statements of their own on the
  // connection and finalize those themselves.)
  #lent: bigint[] = [];
  #liveness = new Liveness();

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
    this.#liveness.alive = false;
    this.#liveness = new Liveness();
    if (this.#hotStmt !== NULL_HANDLE) sqxFinalize(this.#hotStmt);
    for (const handles of this.#pool.values()) for (const stmt of handles) sqxFinalize(stmt);
    for (const stmt of this.#lent) sqxFinalize(stmt);
    this.#pool = new Map();
    this.#hotStmt = NULL_HANDLE;
    this.#hotSql = "";
    this.#pooled = 0;
    this.#lent = [];
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
      fn: fn as AnyCall,
      start: undefined,
      inverse: null,
      result: null,
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
      fn: step as AnyCall,
      start,
      inverse: inverse !== undefined ? (inverse as AnyCall) : null,
      result: typeof result === "function" ? (result as AnyCall) : null,
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
    this._release(sql, stmt, this.#generation);
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

  /** @internal The token that close() and deserialize() invalidate. */
  _liveness(): Liveness {
    return this.#liveness;
  }

  /** @internal Throws as _handleFor does, without returning the handle
   * (a bigint): statements check this once per row. */
  _checkGeneration(generation: number): void {
    if (generation !== this.#generation || this.#db === NULL_HANDLE) throw finalizedError();
  }

  /** @internal Borrow a compiled statement for `sql`. */
  _acquire(sql: string): bigint {
    const db = this.#handle();
    if (this.#hotStmt !== NULL_HANDLE && this.#hotSql === sql) {
      const hot = this.#hotStmt;
      this.#hotStmt = NULL_HANDLE;
      this.#pooled--;
      this.#lent.push(hot);
      return hot;
    }
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
    this.#lent.push(stmt);
    return stmt;
  }

  /** @internal Give a borrowed statement back: reset, bindings cleared,
   * kept for reuse unless the pool is full. */
  /** @internal Gives back a statement from _acquire. `generation` is the
   * one the caller checked before acquiring it. */
  _release(sql: string, stmt: bigint, generation: number): void {
    // Finalized meanwhile by close() or deserialize().
    if (generation !== this.#generation || this.#db === NULL_HANDLE) return;
    const lent = this.#lent;
    let at = lent.length - 1;
    while (at >= 0 && lent[at] !== stmt) at--;
    if (at < 0) return;
    if (at === lent.length - 1) lent.pop();
    else lent.splice(at, 1);
    sqxReset(stmt);
    // The newest idle statement goes in the hot slot; the one there before
    // moves to the map, as the newest entry there.
    const hot = this.#hotStmt;
    const hotSql = this.#hotSql;
    this.#hotStmt = stmt;
    this.#hotSql = sql;
    this.#pooled++;
    if (hot !== NULL_HANDLE) {
      const idle = this.#pool.get(hotSql);
      if (idle !== undefined) {
        // Move the key to the newest end.
        this.#pool.delete(hotSql);
        idle.push(hot);
        this.#pool.set(hotSql, idle);
      } else this.#pool.set(hotSql, [hot]);
    }
    if (this.#pooled > POOL_LIMIT) {
      // Drop the oldest idle statement (never the hot one: the map then
      // holds all the others).
      for (const [oldSql, handles] of this.#pool) {
        sqxFinalize(handles.shift()!);
        this.#pooled--;
        if (handles.length === 0) this.#pool.delete(oldSql);
        break;
      }
    }
  }

  /** @internal For tests: compiled statements kept or lent right now. */
  _statementCount(): number {
    return this.#pooled + this.#lent.length;
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
  // The indexes of the anonymous parameters ("?", "?NNN"), in order, found
  // once: the same SQL always has the same parameters, whichever pooled
  // statement runs it, so bind() need not ask SQLite for names per call.
  #anonymous: number[] | null = null;
  #paramCount = -1;

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
      this.#db._release(this.#sql, stmt, this.#generation);
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
      this.#db._release(this.#sql, stmt, this.#generation);
    }
  }

  run(...params: unknown[]): StatementResultingChanges {
    const stmt = this.#start(params);
    try {
      const db = this.#db._handle();
      let rc = sqxStep(stmt);
      while (rc === SQLITE_ROW) rc = sqxStep(stmt);
      if (rc !== SQLITE_DONE) throw stepError(db, rc);
      if (this.#settings.readBigInts) return { changes: sqxChanges(db), lastInsertRowid: sqxLastInsertRowid(db) };
      return { changes: sqxChangesF64(db), lastInsertRowid: sqxLastInsertRowidF64(db) };
    } finally {
      this.#db._release(this.#sql, stmt, this.#generation);
    }
  }

  get(...params: unknown[]): SQLRow | undefined {
    const stmt = this.#start(params);
    try {
      const row = this.#next(stmt, []);
      return row === null ? undefined : row;
    } finally {
      this.#db._release(this.#sql, stmt, this.#generation);
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
      this.#db._release(this.#sql, stmt, this.#generation);
    }
  }

  /** Runs the statement and returns `read(row)` for every row it gives,
   * reading columns by index with their types (`row.number(0)`,
   * `row.text(1)`, ...). Not in node:sqlite. No row object is built, so
   * returning an object literal of a declared type is far faster than
   * all() and a cast: the compiler knows its shape. `row` is only valid
   * inside the call. */
  map<T>(read: (row: Columns) => T, ...params: SQLParameters[]): T[] {
    const out: T[] = [];
    const stmt = this.#start(params as unknown[]);
    const call = this.#calls;
    const row = new Columns(stmt, this.#db._liveness(), this.#settings.readBigInts);
    try {
      let rc = sqxStep(stmt);
      if (rc === SQLITE_ROW) row._ready(sqxColumnCount(stmt));
      while (rc === SQLITE_ROW) {
        out.push(read(row));
        this.#afterRow(call);
        rc = sqxStep(stmt);
      }
      if (rc !== SQLITE_DONE) throw stepError(this.#db._handle(), rc);
      return out;
    } finally {
      row._end();
      this.#db._release(this.#sql, stmt, this.#generation);
    }
  }

  /** Like map(), but only calls `fn(row)` for every row. */
  forEach(fn: (row: Columns) => void, ...params: SQLParameters[]): void {
    const stmt = this.#start(params as unknown[]);
    const call = this.#calls;
    const row = new Columns(stmt, this.#db._liveness(), this.#settings.readBigInts);
    try {
      let rc = sqxStep(stmt);
      if (rc === SQLITE_ROW) row._ready(sqxColumnCount(stmt));
      while (rc === SQLITE_ROW) {
        fn(row);
        this.#afterRow(call);
        rc = sqxStep(stmt);
      }
      if (rc !== SQLITE_DONE) throw stepError(this.#db._handle(), rc);
    } finally {
      row._end();
      this.#db._release(this.#sql, stmt, this.#generation);
    }
  }

  /** Between rows of map() and forEach(): as an iterator, they stop if the
   * database closed or this statement ran again meanwhile (Node's rule). */
  #afterRow(call: number): void {
    this.#check();
    if (call !== this.#calls) throw stateError("iterator was invalidated");
  }

  iterate(...params: unknown[]): StatementIterator {
    const stmt = this.#start(params);
    try {
      return new StatementIterator(this, stmt, [], this.#calls);
    } catch (error) {
      this.#db._release(this.#sql, stmt, this.#generation);
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
    this.#db._release(this.#sql, stmt, this.#generation);
  }

  #check(): void {
    if (this.#closed) throw finalizedError();
    this.#db._checkGeneration(this.#generation);
  }

  #start(params: unknown[]): bigint {
    this.#check();
    this.#calls++;
    clearCallbackError();
    const stmt = this.#db._acquire(this.#sql);
    try {
      this.#bind(stmt, params);
    } catch (error) {
      this.#db._release(this.#sql, stmt, this.#generation);
      throw error;
    }
    this.#lastParams = params;
    return stmt;
  }

  #bind(stmt: bigint, params: unknown[]): void {
    let first = 0;
    let count = this.#paramCount;
    if (count < 0) {
      count = sqxParamCount(stmt);
      this.#paramCount = count;
    }
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
    // order, skipping named ones, as node:sqlite does. Values beyond them
    // go to the indexes after the last parameter, where SQLite reports
    // the range error.
    if (first >= params.length) return;
    let anonymous = this.#anonymous;
    if (anonymous === null) {
      anonymous = [];
      for (let index = 1; index <= count; index++) if (paramName(stmt, index).startsWith("?")) anonymous.push(index);
      this.#anonymous = anonymous;
    }
    for (let i = first; i < params.length; i++) {
      const k = i - first;
      this.#bindOne(stmt, k < anonymous.length ? anonymous[k]! : count + 1 + (k - anonymous.length), params[i]);
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
    let n = sqxStepRow(stmt, buffer);
    if (n < 0) {
      const rc = -1 - n;
      if (rc !== SQLITE_DONE) throw stepError(this.#db._handle(), rc);
      return null;
    }
    if (n > buffer.length) {
      buffer = new Uint8Array(Math.max(n, buffer.length * 2));
      rowBuffer = buffer;
      rowView = new DataView(buffer.buffer);
      n = sqxRow(stmt, buffer);
    }
    if (names.length === 0) for (const name of this.#columnNames(stmt)) names.push(name);
    return this.#unpack(buffer, buffer === rowBuffer ? rowView : new DataView(buffer.buffer), names);
  }

  #unpack(buffer: Uint8Array, view: DataView, names: string[]): SQLRow {
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
        if (type === SQLITE_TEXT) value = length === 0 ? "" : utf8(buffer.subarray(at, at + length));
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
      if (this.#settings.readBigInts) return sqxColumnInt64(stmt, i);
      // Node refuses values outside the safe range in both directions.
      // (Node on Linux returns -2^63 itself rounded instead of refusing it,
      // while Node on macOS refuses it; this module refuses it everywhere.)
      const value = sqxColumnSafeInt(stmt, i);
      if (value !== value) {
        const big = sqxColumnInt64(stmt, i);
        throw new SQLiteError(`Value is too large to be represented as a JavaScript number: ${big}`, "ERR_OUT_OF_RANGE");
      }
      return value;
    }
    if (type === SQLITE_FLOAT) return sqxColumnDouble(stmt, i);
    if (type === SQLITE_TEXT) return columnText(stmt, i);
    if (type === SQLITE_BLOB) return columnBlob(stmt, i);
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

/** The kind of value a column holds, for column type errors: Node gives
 * the same JavaScript value for INTEGER and REAL, so both are "a number". */
function columnKind(type: number): string {
  if (type === SQLITE_INTEGER || type === SQLITE_FLOAT) return "a number";
  if (type === SQLITE_TEXT) return "text";
  if (type === SQLITE_BLOB) return "a blob";
  return "null";
}

function columnTypeError(i: number, type: number, wanted: string): SQLiteError {
  return new SQLiteError(`Column ${i} holds ${columnKind(type)}, not ${wanted}`, "ERR_SQLITE_COLUMN_TYPE");
}

/** The current row of StatementSync.map() or forEach(), read by column
 * index. Each read checks the column's type and throws
 * ERR_SQLITE_COLUMN_TYPE when it does not match (no silent conversion);
 * columns that are not read are never converted. Valid only inside the
 * callback. */
export class Columns {
  #stmt: bigint;
  #liveness: Liveness;
  #bigints: boolean;
  #count = 0;
  #live = true;

  /** @internal */
  constructor(stmt: bigint, liveness: Liveness, bigints: boolean) {
    this.#stmt = stmt;
    this.#liveness = liveness;
    this.#bigints = bigints;
  }

  /** @internal The first row arrived: its column count is now known. */
  _ready(count: number): void {
    this.#count = count;
  }

  /** @internal The rows are done; later reads throw. */
  _end(): void {
    this.#live = false;
  }

  /** The number of columns. */
  get length(): number {
    this.#alive();
    return this.#count;
  }

  #alive(): void {
    if (!this.#live) throw stateError("row is no longer available: read columns inside the callback");
    if (!this.#liveness.alive) throw finalizedError();
  }

  /** Throws unless the row can be read and i is one of its columns. */
  #check(i: number): void {
    this.#alive();
    if ((i | 0) !== i || i < 0 || i >= this.#count)
      throw new SQLiteError(`Column index ${i} is out of range: the row has ${this.#count} columns`, "ERR_OUT_OF_RANGE");
  }

  /** An INTEGER or REAL column as a number. Integers beyond ±(2^53 - 1)
   * throw ERR_OUT_OF_RANGE, as node:sqlite does. */
  number(i: number): number {
    this.#check(i);
    const value = sqxColumnNumber(this.#stmt, i);
    if (value === value) return value;
    const type = sqxColumnType(this.#stmt, i);
    if (type !== SQLITE_INTEGER) throw columnTypeError(i, type, "a number");
    const big = sqxColumnInt64(this.#stmt, i);
    throw new SQLiteError(`Value is too large to be represented as a JavaScript number: ${big}`, "ERR_OUT_OF_RANGE");
  }

  /** A TEXT column as a string. */
  text(i: number): string {
    this.#check(i);
    let n = sqxColumnTextTyped(this.#stmt, i, scratch);
    if (n < 0) throw columnTypeError(i, sqxColumnType(this.#stmt, i), "text");
    if (n > scratch.length) {
      scratch = new Uint8Array(Math.max(n, scratch.length * 2));
      n = sqxColumnTextTyped(this.#stmt, i, scratch);
    }
    return n === 0 ? "" : utf8(scratch.subarray(0, n));
  }

  /** A BLOB column as a new Uint8Array. */
  blob(i: number): Uint8Array {
    this.#check(i);
    let n = sqxColumnBlobTyped(this.#stmt, i, scratch);
    if (n < 0) throw columnTypeError(i, sqxColumnType(this.#stmt, i), "a blob");
    if (n > scratch.length) {
      scratch = new Uint8Array(Math.max(n, scratch.length * 2));
      n = sqxColumnBlobTyped(this.#stmt, i, scratch);
    }
    return n === 0 ? new Uint8Array(0) : scratch.slice(0, n);
  }

  /** Whether column i is NULL. */
  isNull(i: number): boolean {
    this.#check(i);
    return sqxColumnType(this.#stmt, i) === SQLITE_NULL;
  }

  /** Column i as all() would give it (respecting readBigInts). */
  value(i: number): SQLOutputValue {
    this.#check(i);
    const type = sqxColumnType(this.#stmt, i);
    if (type === SQLITE_INTEGER) return this.#bigints ? sqxColumnInt64(this.#stmt, i) : this.number(i);
    if (type === SQLITE_FLOAT) return sqxColumnDouble(this.#stmt, i);
    if (type === SQLITE_TEXT) return columnText(this.#stmt, i);
    if (type === SQLITE_BLOB) return columnBlob(this.#stmt, i);
    return null;
  }
}
