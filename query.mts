// The typed query builder (src/query.ts), run unchanged under Node (on
// node:sqlite) and as a scriptc binary; run.sh compares the two outputs
// byte for byte. typeErrors() at the end is never called: it holds code
// that must not compile, each line marked @ts-expect-error, so a build
// fails if the builder ever stops refusing one of them.
import { DatabaseSync } from "#sqlite";
import {
  QueryBuilder,
  and,
  avg,
  between,
  blob,
  count,
  eq,
  ge,
  gt,
  inList,
  integer,
  isNotNull,
  isNull,
  le,
  like,
  lt,
  max,
  min,
  ne,
  not,
  nullable,
  or,
  orNull,
  raw,
  real,
  same,
  sum,
  table,
  text,
  exists,
  inSelect,
  scalar,
} from "./src/query.ts";

type Value = null | number | bigint | string | Uint8Array | undefined;

function show(value: Value): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number") return `num ${value}`;
  if (typeof value === "bigint") return `big ${value}n`;
  if (typeof value === "string") return `str ${JSON.stringify(value)}`;
  let hex = "";
  for (let i = 0; i < value.length; i++) hex += value[i]!.toString(16).padStart(2, "0");
  return `blob [${hex}]`;
}

function showRows(rows: unknown[]): string {
  return rows
    .map((row) => {
      const r = row as Record<string, Value>;
      return `{ ${Object.keys(r).map((k) => `${k}=${show(r[k])}`).join(", ")} }`;
    })
    .join(" ");
}

function attempt(label: string, body: () => string): void {
  try {
    console.log(`${label}: ${body()}`);
  } catch (error) {
    const e = error as { message: string; code?: string };
    console.log(`${label}: error ${e.code ?? "(no code)"} ${JSON.stringify(e.message)}`);
  }
}

const person = table("person", {
  id: integer(),
  name: text(),
  age: integer(),
  email: nullable(text()),
  score: real(),
});
const pet = table("pet", {
  id: integer(),
  ownerId: integer("owner_id"),
  species: text(),
  photo: nullable(blob()),
});
const odd = table('odd "table"', { value: text('the "value"') });

const db = new DatabaseSync(":memory:");
db.exec(`
  create table person (id integer primary key, name text not null unique, age integer not null, email text,
                       score real not null default 0);
  create table pet (id integer primary key, owner_id integer not null references person (id),
                    species text not null, photo blob);
  create table "odd ""table""" ("the ""value""" text);
`);
const q = new QueryBuilder(db);

// ── insert ───────────────────────────────────────────────────────────────
const ins = q.insertInto(person, { name: "Ada", age: 36, email: "ada@example.com", score: 9.5 });
console.log(`insert sql: ${ins.toSQL().sql} | params ${ins.toSQL().params.length}`);
attempt("insert", () => JSON.stringify(ins.run()));
attempt("insert, several rows", () =>
  JSON.stringify(
    q
      .insertInto(
        person,
        { name: "Grace", age: 45, email: null, score: 7 },
        { name: "Linus", age: 20, email: "linus@example.com", score: 5.25 },
        { name: "Zoë 🙂", age: 30, email: null, score: 8 },
      )
      .run(),
  ),
);
attempt("insert, returning", () =>
  showRows(
    q
      .insertInto(
        pet,
        { ownerId: 1, species: "cat", photo: new Uint8Array([0, 1, 255]) },
        { ownerId: 1, species: "owl", photo: null },
        { ownerId: 2, species: "dog", photo: new Uint8Array(0) },
      )
      .returning({ id: pet.c.id, species: pet.c.species, owner: pet.c.ownerId })
      .all(),
  ),
);
attempt("insert, odd names", () => {
  q.insertInto(odd, { value: 'say "hi"' }).run();
  return showRows(q.selectAll(odd).all());
});
attempt("insert, no values", () => JSON.stringify(q.insertInto(person).run()));
attempt("insert, rows with different columns", () =>
  JSON.stringify(q.insertInto(person, { name: "A", age: 1 }, { name: "B", score: 1 }).run()),
);
attempt("insert, constraint", () => JSON.stringify(q.insertInto(person, { name: "Ada", age: 1 }).run()));

// ── select ───────────────────────────────────────────────────────────────
attempt("selectAll", () => showRows(q.selectAll(person).orderBy(person.c.id).all()));
attempt("select, aliases", () =>
  showRows(q.select({ who: person.c.name, years: person.c.age }).from(person).orderBy(person.c.age, "desc").all()),
);
const conditions: [string, ReturnType<typeof eq>][] = [
  ["eq", eq(person.c.name, "Grace")],
  ["ne", ne(person.c.name, "Grace")],
  ["lt", lt(person.c.age, 30)],
  ["le", le(person.c.age, 30)],
  ["gt", gt(person.c.score, 7)],
  ["ge", ge(person.c.score, 7)],
  ["and", and(gt(person.c.age, 25), lt(person.c.age, 40))],
  ["or", or(eq(person.c.name, "Ada"), eq(person.c.age, 20))],
  ["not", not(eq(person.c.name, "Ada"))],
  ["empty and", and()],
  ["empty or", or()],
  ["inList", inList(person.c.age, [20, 45, 99])],
  ["empty inList", inList(person.c.age, [])],
  ["isNull", isNull(person.c.email)],
  ["isNotNull", isNotNull(person.c.email)],
  ["like", like(person.c.name, "%a%")],
  ["like, unicode", like(person.c.name, "Zoë%")],
  ["between", between(person.c.age, 30, 40)],
  ["same", same(person.c.age, ">", raw<number>("35"))],
];
for (const [label, condition] of conditions) {
  attempt(`where ${label}`, () =>
    q
      .select({ name: person.c.name })
      .from(person)
      .where(condition)
      .orderBy(person.c.name)
      .all()
      .map((r) => r.name)
      .join(", ") || "(none)",
  );
}
attempt("two where calls", () =>
  q.select({ name: person.c.name }).from(person).where(gt(person.c.age, 25)).where(isNull(person.c.email)).all().map((r) => r.name).join(", "),
);
attempt("limit and offset", () =>
  q.select({ name: person.c.name }).from(person).orderBy(person.c.id).limit(2).offset(1).all().map((r) => r.name).join(", "),
);
attempt("offset alone", () =>
  q.select({ name: person.c.name }).from(person).orderBy(person.c.id).offset(3).all().map((r) => r.name).join(", "),
);
attempt("distinct", () => showRows(q.select({ owner: pet.c.ownerId }).distinct().from(pet).orderBy(pet.c.ownerId).all()));
attempt("first", () => {
  const ada = q.select({ age: person.c.age }).from(person).where(eq(person.c.name, "Ada")).first();
  const nobody = q.select({ age: person.c.age }).from(person).where(eq(person.c.name, "nobody")).first();
  return `${ada === undefined ? "none" : ada.age + 1} ${nobody === undefined ? "none" : nobody.age}`;
});
attempt("typed rows", () => {
  let out = "";
  for (const r of q.select({ name: person.c.name, age: person.c.age, email: person.c.email }).from(person).orderBy(person.c.id).all())
    out += `${r.name.toUpperCase()}:${r.age * 2}:${r.email === null ? "-" : r.email.length} `;
  return out;
});

// ── joins ────────────────────────────────────────────────────────────────
const owners = q
  .select({ owner: person.c.name, pet: pet.c.species, photo: pet.c.photo })
  .from(person)
  .innerJoin(pet, same(pet.c.ownerId, "=", person.c.id))
  .where(ne(pet.c.species, "fish"))
  .orderBy(person.c.name)
  .orderBy(pet.c.species);
console.log(`join sql: ${owners.toSQL().sql}`);
attempt("inner join", () => showRows(owners.all()));
attempt("left join", () =>
  showRows(
    q
      .select({ owner: person.c.name, pet: orNull(pet.c.species) })
      .from(person)
      .leftJoin(pet, same(pet.c.ownerId, "=", person.c.id))
      .orderBy(person.c.id)
      .orderBy(pet.c.id)
      .all(),
  ),
);

// ── expressions and grouping ─────────────────────────────────────────────
attempt("aggregates", () =>
  showRows(
    q
      .select({ n: count(), emails: count(person.c.email), total: sum(person.c.age), mean: avg(person.c.score),
                youngest: min(person.c.age), last: max(person.c.name) })
      .from(person)
      .all(),
  ),
);
attempt("aggregates, no rows", () =>
  showRows(q.select({ n: count(), total: sum(person.c.age), first: min(person.c.name) }).from(person).where(eq(person.c.age, -1)).all()),
);
attempt("group by, having", () =>
  showRows(
    q
      .select({ owner: person.c.name, pets: count(pet.c.id) })
      .from(person)
      .innerJoin(pet, same(pet.c.ownerId, "=", person.c.id))
      .groupBy(person.c.name)
      .having(gt(count(pet.c.id), 1))
      .all(),
  ),
);
attempt("raw expressions", () =>
  showRows(
    q
      .select({
        name: person.c.name,
        letters: raw<number>(`length(${person.c.name.sql})`),
        shout: raw<string>("upper(?) || ?", ["hey ", "!"]),
      })
      .from(person)
      .where(gt(raw<number>(`length(${person.c.name.sql})`), 4))
      .orderBy(raw<number>(`length(${person.c.name.sql})`), "desc")
      .all(),
  ),
);
db.function("lower_name", { deterministic: true }, (s) => String(s).toLowerCase());
attempt("a user function in a query", () =>
  showRows(q.select({ i: raw<string>(`lower_name(${person.c.name.sql})`) }).from(person).orderBy(person.c.id).all()),
);
attempt("select without from", () => showRows(q.select({ one: raw<number>("1"), text: raw<string>("?", ["x"]) }).all()));

// ── update, delete ───────────────────────────────────────────────────────
const upd = q.update(person, { age: 37, email: null }).where(eq(person.c.name, "Ada"));
console.log(`update sql: ${upd.toSQL().sql} | params ${upd.toSQL().params.length}`);
attempt("update", () => JSON.stringify(upd.run()));
attempt("update, returning", () =>
  showRows(q.update(person, { score: 10 }).where(gt(person.c.age, 40)).returning({ name: person.c.name, score: person.c.score }).all()),
);
attempt("update, nothing matches", () => JSON.stringify(q.update(person, { score: 1 }).where(eq(person.c.name, "nobody")).run()));
attempt("update, no values", () => JSON.stringify(q.update(person, {}).run()));
attempt("delete, returning", () =>
  showRows(q.deleteFrom(pet).where(eq(pet.c.species, "owl")).returning({ id: pet.c.id, species: pet.c.species }).all()),
);
attempt("delete", () => JSON.stringify(q.deleteFrom(pet).where(eq(pet.c.ownerId, 2)).run()));

// ── transactions ─────────────────────────────────────────────────────────
const names = (): string => q.select({ name: person.c.name }).from(person).orderBy(person.c.id).all().map((r) => r.name).join(", ");
attempt("transaction, commit", () => {
  const id = q.transaction(() => q.insertInto(person, { name: "Tx", age: 1 }).run().lastInsertRowid);
  return `id ${id}: ${names()} | open ${db.isTransaction}`;
});
attempt("transaction, rollback", () => {
  try {
    // ": void": a body that always throws is typed never, and scriptc 0.4.12
    // then miscompiles the other instantiations of transaction() (NOTES.md).
    q.transaction((): void => {
      q.insertInto(person, { name: "Gone", age: 1 }).run();
      throw new Error("changed my mind");
    });
  } catch (error) {
    return `${(error as Error).message}: ${names()} | open ${db.isTransaction}`;
  }
  return "no error";
});
attempt("transaction, nested", () => {
  q.transaction(() => {
    q.insertInto(person, { name: "Outer", age: 2 }).run();
    try {
      q.transaction(() => {
        q.insertInto(person, { name: "Inner", age: 3 }).run();
        q.insertInto(person, { name: "Outer", age: 4 }).run(); // UNIQUE fails
      });
    } catch (error) {
      console.log(`  inner failed: ${(error as { code: string }).code}`);
    }
    q.transaction(() => q.insertInto(person, { name: "Inner 2", age: 5 }).run());
  });
  return `${names()} | open ${db.isTransaction}`;
});

db.close();

// ── tables from declarations, aliases, subqueries, upserts ───────────────
{
  const d = new DatabaseSync(":memory:");
  const b = new QueryBuilder(d);
  const deptColumns = () => ({
    id: integer().primaryKey(),
    name: text().unique(),
    budget: real().defaultTo(1000),
  });
  const dept = table("dept", deptColumns());
  const employeeColumns = () => ({
    id: integer().primaryKey(),
    name: text(),
    email: text().unique(),
    deptId: integer("dept_id").references(dept.c.id, "cascade"),
    managerId: nullable(integer("manager_id")),
    note: nullable(text().defaultTo("it's new")),
    badge: nullable(blob()),
  });
  const employee = table("employee", employeeColumns());
  const manager = table("employee", employeeColumns(), "manager");
  const membership = table("membership", { deptId: integer("dept_id"), employeeId: integer("employee_id") });

  for (const ddl of [
    b.createTable(dept),
    b.createTable(employee, { ifNotExists: true }),
    b.createTable(membership, { primaryKey: [membership.c.deptId, membership.c.employeeId] }),
    b.createIndex("employee_by_dept", employee, [employee.c.deptId, employee.c.name]),
    b.createIndex("employee_email", employee, [employee.c.email], { unique: true, ifNotExists: true }),
  ]) {
    console.log(`ddl: ${ddl.toSQL().sql}`);
    attempt("  run", () => {
      ddl.run();
      return "ok";
    });
  }
  attempt("schema as SQLite keeps it", () =>
    (d.prepare("select sql from sqlite_schema where type = 'table' order by name").all() as { sql: string }[]).map((r) => r.sql).join(" ;; "),
  );
  attempt("defaults and constraints", () => {
    b.insertInto(dept, { name: "Research" }, { name: "Sales" }).run();
    b.insertInto(employee, { name: "Ada", email: "ada@x", deptId: 1 }).run();
    b.insertInto(employee, { name: "Grace", email: "grace@x", deptId: 1, managerId: 1 }, { name: "Linus", email: "linus@x", deptId: 2, managerId: 1 }).run();
    b.insertInto(employee, { name: "Zoë", email: "zoe@x", deptId: 2, managerId: 3, badge: new Uint8Array([7]) }).run();
    return showRows(b.selectAll(dept).orderBy(dept.c.id).all()) + " | " + showRows(b.selectAll(employee).orderBy(employee.c.id).all());
  });
  attempt("not null from the declaration", () => JSON.stringify(b.insertInto(employee, { email: "nameless@x", deptId: 1 }).run()));
  attempt("foreign key from the declaration", () => JSON.stringify(b.insertInto(employee, { name: "X", email: "x@x", deptId: 99 }).run()));

  // A self-join through an alias.
  attempt("self-join", () =>
    showRows(
      b
        .select({ who: employee.c.name, boss: orNull(manager.c.name) })
        .from(employee)
        .leftJoin(manager, same(manager.c.id, "=", employee.c.managerId))
        .orderBy(employee.c.id)
        .all(),
    ),
  );
  console.log(`self-join sql: ${b.select({ who: employee.c.name }).from(employee).innerJoin(manager, same(manager.c.id, "=", employee.c.managerId)).toSQL().sql}`);

  // Subqueries.
  attempt("inSelect", () =>
    b
      .select({ name: dept.c.name })
      .from(dept)
      .where(inSelect(dept.c.id, b.select({ d: employee.c.deptId }).from(employee).where(like(employee.c.name, "L%"))))
      .all()
      .map((r) => r.name)
      .join(", "),
  );
  attempt("exists, correlated", () =>
    b
      .select({ name: employee.c.name })
      .from(employee)
      .where(exists(b.select({ one: raw<number>("1") }).from(manager).where(same(manager.c.managerId, "=", employee.c.id))))
      .orderBy(employee.c.id)
      .all()
      .map((r) => r.name)
      .join(", "),
  );
  attempt("not exists", () =>
    b
      .select({ name: employee.c.name })
      .from(employee)
      .where(not(exists(b.select({ one: raw<number>("1") }).from(manager).where(same(manager.c.managerId, "=", employee.c.id)))))
      .orderBy(employee.c.id)
      .all()
      .map((r) => r.name)
      .join(", "),
  );
  attempt("scalar, correlated, with a parameter", () =>
    showRows(
      b
        .select({
          dept: dept.c.name,
          people: scalar(b.select({ n: count() }).from(employee).where(same(employee.c.deptId, "=", dept.c.id))),
          longNames: scalar(
            b.select({ n: count() }).from(employee).where(and(same(employee.c.deptId, "=", dept.c.id), gt(raw<number>(`length(${employee.c.name.sql})`), 4))),
          ),
          none: scalar(b.select({ x: employee.c.name }).from(employee).where(eq(employee.c.name, "nobody"))),
        })
        .from(dept)
        .orderBy(dept.c.id)
        .all(),
    ),
  );

  // Upserts.
  attempt("upsert, do nothing", () =>
    JSON.stringify(b.insertInto(dept, { name: "Research", budget: 5 }, { name: "Legal", budget: 5 }).onConflictDoNothing(dept.c.name).run()),
  );
  attempt("upsert, do nothing on any constraint", () =>
    JSON.stringify(b.insertInto(dept, { id: 1, name: "Other" }).onConflictDoNothing().run()),
  );
  attempt("upsert, do update, returning", () =>
    showRows(
      b
        .insertInto(dept, { name: "Sales", budget: 2500 }, { name: "Support", budget: 300 })
        .onConflictDoUpdate([dept.c.name], [dept.c.budget])
        .returning({ id: dept.c.id, name: dept.c.name, budget: dept.c.budget })
        .all(),
    ),
  );
  attempt("after upserts", () => showRows(b.selectAll(dept).orderBy(dept.c.id).all()));
  console.log(`upsert sql: ${b.insertInto(dept, { name: "A" }).onConflictDoUpdate([dept.c.name], [dept.c.budget, dept.c.name]).toSQL().sql}`);

  // Misuse.
  attempt("where on an insert", () => JSON.stringify(b.insertInto(dept, { name: "B" }).where(eq(dept.c.id, 1)).run()));
  attempt("upsert on an update", () => JSON.stringify(b.update(dept, { budget: 1 }).onConflictDoNothing().run()));
  attempt("do update without columns", () => JSON.stringify(b.insertInto(dept, { name: "C" }).onConflictDoUpdate([dept.c.name], []).run()));
  attempt("writing through an alias", () => JSON.stringify(b.update(manager, { name: "x" }).run()));
  attempt("columns reused in a second table", () => {
    table("again", employee.c);
    return "declared";
  });
  attempt("drop table", () => {
    b.dropTable(membership).run();
    b.dropTable(membership, { ifExists: true }).run();
    return `${b.dropTable(membership, { ifExists: true }).toSQL().sql} | tables ${(d.prepare("select count(*) n from sqlite_schema where type = 'table'").get() as { n: number }).n}`;
  });
  d.close();
}
console.log("done");

/** Never called: each marked line must be a type error. */
export function typeErrors(): void {
  // @ts-expect-error: a string compared with an integer column
  eq(person.c.age, "thirty");
  // @ts-expect-error: an integer column compared with a text column
  same(person.c.age, "=", pet.c.species);
  // @ts-expect-error: a string inserted into an integer column
  q.insertInto(person, { age: "old" });
  // @ts-expect-error: no such column
  q.insertInto(person, { nickname: "x" });
  // @ts-expect-error: null into a column that is not nullable()
  q.update(person, { name: null });
  // @ts-expect-error: like() on an integer column
  like(person.c.age, "1%");
  const rows = q.select({ n: person.c.name, e: person.c.email }).from(person).all();
  // @ts-expect-error: a column that was not selected
  console.log(rows[0]!.age);
  // @ts-expect-error: text read as a number
  const n: number = rows[0]!.n;
  // @ts-expect-error: a nullable column read as never null
  const e: string = rows[0]!.e;
  console.log(n, e);
  // @ts-expect-error: a foreign key to a column of another type
  integer().references(text());
  // @ts-expect-error: a default of the wrong type
  integer().defaultTo("zero");
  // @ts-expect-error: a subquery selecting text, compared with an integer
  inSelect(person.c.age, q.select({ n: person.c.name }).from(person));
  // @ts-expect-error: a value where a column is expected
  q.insertInto(person, { name: "x" }).onConflictDoNothing("name");
}
