// Under Node, "#sqlite" is Node's own node:sqlite (see package.json), plus
// this module's additions to StatementSync (map, forEach and the column
// reader), written over iterate() with array rows so that a program gives
// the same output under Node as compiled.
import { DatabaseSync, StatementSync, backup } from "node:sqlite";

export { DatabaseSync, StatementSync, backup };

type Value = null | number | bigint | string | Uint8Array;

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function kind(value: Value): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "bigint") return "a number";
  if (typeof value === "string") return "text";
  return "a blob";
}

export class Columns {
  #row: Value[] = [];
  #live = true;

  _set(row: Value[]): void {
    this.#row = row;
  }

  _end(): void {
    this.#live = false;
  }

  get length(): number {
    this.#check();
    return this.#row.length;
  }

  #check(): void {
    if (!this.#live) throw codedError("row is no longer available: read columns inside the callback", "ERR_INVALID_STATE");
  }

  #at(i: number): Value {
    this.#check();
    if ((i | 0) !== i || i < 0 || i >= this.#row.length)
      throw codedError(`Column index ${i} is out of range: the row has ${this.#row.length} columns`, "ERR_OUT_OF_RANGE");
    return this.#row[i] as Value;
  }

  number(i: number): number {
    const value = this.#at(i);
    if (typeof value === "number") return value;
    if (typeof value === "bigint") {
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER))
        throw codedError(`Value is too large to be represented as a JavaScript number: ${value}`, "ERR_OUT_OF_RANGE");
      return Number(value);
    }
    throw codedError(`Column ${i} holds ${kind(value)}, not a number`, "ERR_SQLITE_COLUMN_TYPE");
  }

  text(i: number): string {
    const value = this.#at(i);
    if (typeof value === "string") return value;
    throw codedError(`Column ${i} holds ${kind(value)}, not text`, "ERR_SQLITE_COLUMN_TYPE");
  }

  blob(i: number): Uint8Array {
    const value = this.#at(i);
    if (value instanceof Uint8Array) return value;
    throw codedError(`Column ${i} holds ${kind(value)}, not a blob`, "ERR_SQLITE_COLUMN_TYPE");
  }

  textBytes(i: number): Uint8Array {
    const value = this.#at(i);
    if (typeof value === "string") return new TextEncoder().encode(value);
    throw codedError(`Column ${i} holds ${kind(value)}, not text`, "ERR_SQLITE_COLUMN_TYPE");
  }

  isNull(i: number): boolean {
    return this.#at(i) === null;
  }

  value(i: number): Value {
    return this.#at(i);
  }
}

type Statement = {
  iterate(...params: unknown[]): IterableIterator<unknown>;
  setReturnArrays(enabled: boolean): void;
};

function each(statement: Statement, params: unknown[], fn: (row: Columns) => void): void {
  const row = new Columns();
  statement.setReturnArrays(true);
  try {
    for (const values of statement.iterate(...params)) {
      row._set(values as Value[]);
      fn(row);
    }
  } finally {
    row._end();
    statement.setReturnArrays(false);
  }
}

const proto = StatementSync.prototype as unknown as Record<string, unknown>;
proto.map = function <T>(this: Statement, read: (row: Columns) => T, ...params: unknown[]): T[] {
  const out: T[] = [];
  each(this, params, (row) => {
    out.push(read(row));
  });
  return out;
};
proto.forEach = function (this: Statement, fn: (row: Columns) => void, ...params: unknown[]): void {
  each(this, params, fn);
};

// db.numberFunction: function() with every argument checked to be a number.
type NumberFunction = (...args: number[]) => number;

function numberArgument(value: unknown, i: number): number {
  if (typeof value === "number") return value;
  throw codedError(`Argument ${i} holds ${kind(value as Value)}, not a number`, "ERR_INVALID_ARG_TYPE");
}

(DatabaseSync.prototype as unknown as Record<string, unknown>).numberFunction = function (
  this: { function(name: string, options: object, fn: unknown): void },
  name: string,
  fn: NumberFunction,
  options?: { deterministic?: boolean; directOnly?: boolean },
): void {
  const o: Record<string, boolean> = {};
  if (options !== undefined && options.deterministic !== undefined) o.deterministic = options.deterministic;
  if (options !== undefined && options.directOnly !== undefined) o.directOnly = options.directOnly;
  // node:sqlite takes the SQL argument count from the function's length,
  // so the wrapper keeps fn's.
  const n = typeof fn === "function" ? fn.length : 0;
  const wrappers: unknown[] = [
    () => fn(),
    (a: unknown) => fn(numberArgument(a, 0)),
    (a: unknown, b: unknown) => fn(numberArgument(a, 0), numberArgument(b, 1)),
    (a: unknown, b: unknown, c: unknown) => fn(numberArgument(a, 0), numberArgument(b, 1), numberArgument(c, 2)),
    (a: unknown, b: unknown, c: unknown, d: unknown) =>
      fn(numberArgument(a, 0), numberArgument(b, 1), numberArgument(c, 2), numberArgument(d, 3)),
  ];
  this.function(name, o, typeof fn === "function" ? wrappers[Math.min(n, 4)] : fn);
};

// stmt.runMany: run() once per row with the values the callback set.
export class Parameters {
  #values: Value[] = [];
  #live = true;

  _reset(): void {
    this.#values = [];
  }

  _values(): Value[] {
    const out = this.#values;
    for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = null;
    return out;
  }

  _end(): void {
    this.#live = false;
  }

  #set(i: number, value: Value): void {
    if (!this.#live) throw codedError("parameters are no longer available: set them inside the callback", "ERR_INVALID_STATE");
    if ((i | 0) !== i || i < 0) throw codedError(`Parameter position ${i} is not valid`, "ERR_OUT_OF_RANGE");
    this.#values[i] = value;
  }

  number(i: number, value: number): void {
    this.#set(i, value);
  }

  text(i: number, value: string): void {
    this.#set(i, value);
  }

  blob(i: number, value: Uint8Array): void {
    this.#set(i, value);
  }

  bigint(i: number, value: bigint): void {
    if (value < -(2n ** 63n) || value > 2n ** 63n - 1n) {
      this.#set(i, null);
      throw codedError("BigInt value is too large to bind.", "ERR_INVALID_ARG_VALUE");
    }
    this.#set(i, value);
  }

  null(i: number): void {
    this.#set(i, null);
  }
}

proto.runMany = function (
  this: { run(...values: unknown[]): { changes: number | bigint } },
  count: number,
  bind: (i: number, params: Parameters) => void,
): number {
  const params = new Parameters();
  let changes = 0;
  try {
    for (let i = 0; i < count; i++) {
      params._reset();
      bind(i, params);
      changes += Number(this.run(...params._values()).changes);
    }
  } finally {
    params._end();
  }
  return changes;
};
