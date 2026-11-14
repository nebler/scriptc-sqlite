// The benchmark workloads in Go on mattn/go-sqlite3 (cgo, SQLite compiled
// in, like this package). See ../sqlite-bench.mts for the workloads and
// checksums.
//
//	go-bench <workload> <database> [N]
package main

import (
	"database/sql"
	"fmt"
	"os"
	"strconv"
	"unicode/utf8"

	sqlite3 "github.com/mattn/go-sqlite3"
)

const filler = "ünïcødé ✓ the quick brown fox jumps over the lazy dog 0123456789 abcdefghijklmnop"

func body(i int) string { return "row " + strconv.Itoa(i) + " " + filler }

func init() {
	sql.Register("sqlite3_bench", &sqlite3.SQLiteDriver{
		ConnectHook: func(c *sqlite3.SQLiteConn) error {
			return c.RegisterFunc("twice", func(x int64) int64 { return x * 2 }, true)
		},
	})
}

func open(path string, readOnly bool) *sql.DB {
	dsn := "file:" + path
	if readOnly {
		dsn += "?mode=ro"
	}
	db, err := sql.Open("sqlite3_bench", dsn)
	check(err)
	db.SetMaxOpenConns(1)
	return db
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func version(path string) string {
	db := open(path, false)
	defer db.Close()
	var v string
	check(db.QueryRow("select sqlite_version()").Scan(&v))
	return v
}

func startup(path string) string {
	db := open(path, true)
	defer db.Close()
	var c, s int64
	check(db.QueryRow("select count(*), sum(length(body)) from notes where id <= 100").Scan(&c, &s))
	return fmt.Sprintf("%d %d", c, s)
}

func insert(path string, n int) string {
	db := open(path, false)
	defer db.Close()
	_, err := db.Exec("pragma journal_mode = wal; pragma synchronous = normal")
	check(err)
	_, err = db.Exec("create table t (id integer primary key, n integer, r real, body text)")
	check(err)
	tx, err := db.Begin()
	check(err)
	add, err := tx.Prepare("insert into t (n, r, body) values (?, ?, ?)")
	check(err)
	for i := 1; i <= n; i++ {
		_, err = add.Exec(int64(i), float64(i)*0.5, body(i))
		check(err)
	}
	check(add.Close())
	check(tx.Commit())
	var c, s, l int64
	check(db.QueryRow("select count(*), sum(n), sum(length(body)) from t").Scan(&c, &s, &l))
	return fmt.Sprintf("%d %d %d", c, s, l)
}

func read(path string) string {
	db := open(path, true)
	defer db.Close()
	rows, err := db.Query("select n, r, body from t")
	check(err)
	var count, sumN, chars int64
	var sumR float64
	for rows.Next() {
		var n int64
		var r float64
		var b string
		check(rows.Scan(&n, &r, &b))
		count++
		sumN += n
		sumR += r
		chars += int64(utf8.RuneCountInString(b))
	}
	check(rows.Err())
	return fmt.Sprintf("%d %d %d %d", count, sumN, int64(sumR*2), chars)
}

func text(path string) string {
	db := open(path, true)
	defer db.Close()
	rows, err := db.Query("select body, data from t2")
	check(err)
	var count, chars, bytes, sum int64
	for rows.Next() {
		var b string
		var d []byte
		check(rows.Scan(&b, &d))
		count++
		chars += int64(utf8.RuneCountInString(b))
		bytes += int64(len(d))
		sum += int64(d[0]) + int64(d[len(d)>>1]) + int64(d[len(d)-1])
	}
	check(rows.Err())
	return fmt.Sprintf("%d %d %d %d", count, chars, bytes, sum)
}

func udf(path string) string {
	db := open(path, true)
	defer db.Close()
	var s int64
	check(db.QueryRow("select cast(sum(twice(n)) as integer) from t").Scan(&s))
	return strconv.FormatInt(s, 10)
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: go-bench <workload> <database> [N]")
		os.Exit(2)
	}
	workload, path := os.Args[1], os.Args[2]
	n := 0
	if len(os.Args) > 3 {
		n, _ = strconv.Atoi(os.Args[3])
	}
	switch workload {
	case "version":
		fmt.Println(version(path))
	case "startup":
		fmt.Println(startup(path))
	case "insert":
		fmt.Println(insert(path, n))
	case "read":
		fmt.Println(read(path))
	case "text":
		fmt.Println(text(path))
	case "udf":
		fmt.Println(udf(path))
	default:
		fmt.Fprintf(os.Stderr, "unknown workload %q\n", workload)
		os.Exit(2)
	}
}
