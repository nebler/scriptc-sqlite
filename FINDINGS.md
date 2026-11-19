# Findings to report upstream

Problems found while building scriptc-sqlite, written so each can be sent as an issue: what happens, a minimal program that shows it, and the workaround used here. **Nothing here has been filed.** The owner decides what goes to scriptc (vercel-labs/scriptc) or Node.js, and when.

Versions: scriptc 0.4.12 from npm, Node 24.22.3, Linux arm64. The repro programs build with plain `scriptc build x.ts -o x`.

## For scriptc

### 1. Reading `process.env` costs about 40 MiB of memory (high impact)

A one-line program's peak memory jumps tenfold when it reads one environment variable. The cost is paid in every worker thread that touches `process.env`.

```ts
console.log("hi");                                      // 3.9 MiB peak
console.log("hi", process.env["HOME"] !== undefined);   // 43 MiB peak
```

| Program | Peak memory |
|---|---|
| hello world | 3.9 MiB |
| + `process.env["HOME"]` | **43 MiB** |
| + `process.argv` | 7.1 MiB |
| + a RegExp | 15 MiB |
| + `JSON.parse`/`stringify` | 14 MiB |
| + an `async` function | 12 MiB |
| + `Map` and `Set` | 11 MiB |

- **Seen here:** `threads.mts` (4 workers) went from 151 to 226 MiB because the module read one variable at load time.
- **Workaround:** read variables through C's `getenv` over the FFI (`getEnv()` in this package).
- **Expected:** reading one variable should cost about as much as `process.argv` does.

### 2. A callback that always throws breaks the function's other instantiations (wrong compile errors)

When one call of a generic function passes a body that always throws (TypeScript infers its return type as `never`), a *different*, correct call of the same function fails to compile:

```ts
function tx<T>(body: () => T): T {
  try {
    return body();
  } catch (e) {
    throw e;
  }
}
console.log(tx(() => 42));
try {
  tx(() => {
    throw new Error("no");
  });
} catch (e) {
  console.log((e as Error).message);
}
```

```
error SC1090: 'void' values where 'number' is expected is not supported yet (instantiating 'tx' with <number>)
```

- **Works:** without the `try/catch` in `tx`, or with the throwing body written `(): void => { … }`.
- **Workaround used:** `(): void =>`, documented in the README for `transaction()`.
- **Expected:** the `<number>` instantiation should compile as it does when the throwing call is absent.

### 3. A method can't return another instantiation of its own generic class (blocks Kysely)

```ts
class QB<O> {
  #cols: string[];
  constructor(cols: string[]) { this.#cols = cols; }
  select<K extends string>(k: K): QB<O & { [P in K]: string }> {
    return new QB<O & { [P in K]: string }>([...this.#cols, k]);
  }
  cols(): string { return this.#cols.join(","); }
}
console.log(new QB<{}>([]).select("a").select("b").cols());
```

```
error SC1090: 'QB%…' values where 'QB%…' is expected is not supported yet (instantiating 'select' with <string>)
```

- **Why it matters:** this is how typed query builders carry their row type along a chain. Compiled from its TypeScript sources, Kysely 0.29.9 hits this **174 times** (of 523 errors). The class's fields don't depend on `O`, so the layouts are identical.
- **Workaround here:** a builder whose row type is fixed once by `select()` (`scriptc-sqlite/query`).

### 4. A function with fixed parameters can't go where a rest parameter is declared

```ts
type V = null | number | string;
function register(fn: (...args: V[]) => V): void { console.log(fn(1, 2)); }
register((a, b) => (a as number) + (b as number));
```

```
error SC1090: variadic function values where another signature is expected ('(V, V) => V' into '(...V[]) => V') is not supported yet
```

- **Why it matters:** Node's own declaration of `database.function()` is `(...args: SQLOutputValue[]) => SQLInputValue`, and most callbacks are written `(a, b) => …`.
- **Related refusals met on the way:** a cast from a union of function types to one member (SC2003, also in branches that never run for that type); functions with optional parameters as values (SC1090); a rest function where eight fixed parameters are declared (SC2001, tuple types).
- **Workaround:** overloads, one with eight required `T | undefined` parameters, then one taking `any`.

### 5. Branches that can't run for a type are still compiled for it (blocks Kysely from npm)

A generic function is compiled once per argument type, *including* branches that a type check rules out for that type. In TypeScript code the checks work. In a package's published JavaScript, guards like `isReadonlyArray(x)` or `isOperationNodeSource(x)` are plain functions, so every branch gets compiled for every type:

```
error SC2020: 'string.map' is part of the standard library types but has no scriptc lowering yet (instantiating 'parseTableExpressionOrList' with (string))
```

Kysely 0.29.9 from npm, after removing its three object-model patterns by hand, still stops on 19 of these, in its parsers.

### 6. No variance: `Col<number>` can't go where `Col<number | string | null>` is declared

TypeScript accepts both of these; scriptc compiles each instantiation of a generic class as its own class and refuses to pass one as another:

```ts
type V = null | number | string;
class Col<T> { name = ""; v?: T; }
function names(r: Record<string, Col<V>>): string[] { return Object.keys(r).map((k) => r[k]!.name); }
console.log(names({ a: new Col<number>(), b: new Col<string>() }));
```

```
error SC1090: 'Col%…' values where 'Col%…' is expected is not supported yet
```

The same happens through a subclass, when inference widens one side:

```ts
class Expr<T> { sql = "x"; v?: T; }
class Column<T> extends Expr<T> {}
function same<T>(a: Expr<T>, b: Expr<T>): string { return a.sql + b.sql; }
console.log(same(new Column<number>(), new Column<number | null>()));
```

```
error SC1090: using a 'Column%…' instance as the unrelated class 'Expr%…' (neither class extends the other, and class identity is nominal in compiled code) is not supported yet
```

- **Workarounds here:** a non-generic base class for code that walks columns at run time; records passed as `unknown` and cast inside the function; and `same<A, B extends A | null>` with two type parameters, so nothing is widened.
- **Not a problem:** passing a plain subclass instance where its non-generic base class is expected works.

### 7. Smaller limits met

- **Class fields typed `Record<string, unknown>[]`** are refused (SC1090).
- **A mapped type over a class's type parameter** (`RowOf<S>[]` returned inside `class Select<S>`) is refused (SC2009). The same type computed in a generic method's return type works.
- **`stmt.get() as Shape | undefined`** is refused (SC2003); `as Shape` works.
- **Interfaces:** a non-generic class seen through a generic interface (`new Impl() as unknown as QB<{}>`) works in the simplest case, but not when the factory is generic or method types differ (SC2002, and SC1090 "calls of the generic method … through this receiver").

### 8. Packaging and toolchain

- **SC2013:** a TypeScript package copied into `node_modules` (a plain `npm install` from the registry) is refused: "ships no own .d.ts declaration surface". Only `file:`/workspace links compile. So a library like this one can't be published to npm as usual. The workaround here is a starter that downloads the package into `vendor/`.
- **Linking with Zig as the C compiler:**
  - scriptc passes `-target aarch64-unknown-linux-gnu`, which `zig cc` refuses ("UnknownOperatingSystem"), and `-lgcc_eh`, which Zig doesn't ship (its counterpart is `-lunwind`). A wrapper rewriting both works.
  - `--sanitize` can't work with Zig at all: it has no AddressSanitizer runtime.

  Accepting Zig's triple form, or documenting the needed flags, would make machines without LLVM usable.
- **npm's `allowScripts` blocks scriptc's `postinstall`** (`scripts/install-native.mjs`). Builds worked without it here, but it's unclear whether that's intended.

## For Node.js

### An aggregate's exception is lost when it has a `result` function (data-losing)

```js
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(":memory:");
db.exec("create table t (x); insert into t values (1), (2), (3), (4)");
db.aggregate("bad", {
  start: 0,
  step: (acc, x) => { if (x === 4) throw new Error("step on 4"); return acc + x; },
  result: (acc) => acc,
});
console.log(db.prepare("select bad(x) s from t").get()); // undefined: no error, no row
console.log(db.prepare("select bad(x) s from t").all()); // undefined, not even an array
```

- **What happens:** with `result` present, the step's exception disappears: `get()` and even `all()` return `undefined`. Without `result`, or with `inverse` (as a window function), the exception is thrown as it should be.
- **Cause (from `src/node_sqlite.cc`):** SQLite still calls `xFinal` after the step fails. Node then calls `result` while the step's exception is pending, and the exception is lost.
- **Version:** seen in Node 24.22.3.
- **This package** throws the step's exception (`pool.mts` checks it).
