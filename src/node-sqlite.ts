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
