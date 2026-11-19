// The query-builder example README.md shows, built and run by run.sh
// through the package's "scriptc-sqlite/query" export.
import { DatabaseSync } from "scriptc-sqlite";
import { QueryBuilder, gt, integer, same, table, text } from "scriptc-sqlite/query";

const person = table("person", { id: integer(), name: text(), age: integer() });
const pet = table("pet", { id: integer(), ownerId: integer("owner_id"), species: text() });

const db = new DatabaseSync(":memory:");
db.exec(`
  create table person (id integer primary key, name text not null, age integer not null);
  create table pet (id integer primary key, owner_id integer not null references person (id), species text not null);
`);
const q = new QueryBuilder(db);
const ada = q.insertInto(person, { name: "Ada", age: 36 }).run().lastInsertRowid;
q.insertInto(pet, { ownerId: ada, species: "cat" }, { ownerId: ada, species: "owl" }).run();

const rows = q
  .select({ owner: person.c.name, pet: pet.c.species })
  .from(person)
  .innerJoin(pet, same(pet.c.ownerId, "=", person.c.id))
  .where(gt(person.c.age, 30))
  .orderBy(pet.c.species)
  .all();
for (const row of rows) console.log(`${row.owner} has a ${row.pet}`); // row: { owner: string; pet: string }
db.close();
