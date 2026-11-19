# My SQLite app

A [scriptc](https://scriptc.dev) program with SQLite compiled in: one executable that needs nothing installed where it runs. Made from the [scriptc-sqlite](https://github.com/nebler/scriptc-sqlite) starter.

```console
$ npx degit nebler/scriptc-sqlite/template my-app
$ cd my-app
$ node setup.mjs          # fetches scriptc-sqlite into vendor/ and installs
$ npm run build           # the first build also compiles SQLite (about a minute)
$ ./build/app add "write the README"
added 1
$ ./build/app list
[ ] 1  write the README
```

You need Node 24, network access for the setup, and what scriptc needs to link: clang on Linux, Xcode's command-line tools on macOS.

- `src/main.ts` is the program: tables are declared with `table()`, created by a migration, and queried with the typed query builder. See scriptc-sqlite's README for all of it (`vendor/scriptc-sqlite/README.md`).
- `setup.mjs` downloads the `main` branch; `SCRIPTC_SQLITE_REF=<tag or commit> node setup.mjs` pins a version.
