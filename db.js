import { Database } from 'bun:sqlite'

const db = new Database(':memory:', { strict: true })

db.exec(`
  CREATE TABLE kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    exp INTEGER NOT NULL
  )
`)

const stmts = {
  get: db.prepare('SELECT v FROM kv WHERE k=? AND exp>?'),
  set: db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?,?)'),
  del: db.prepare('DELETE FROM kv WHERE k=?'),
  prune: db.prepare('DELETE FROM kv WHERE exp<?'),
  list: db.prepare("SELECT k FROM kv WHERE k GLOB ? AND exp>?"),
}

const TTL_MS = 20 * 60 * 1000

export function get(key) {
  const row = stmts.get.get(key, Date.now())
  return row ? JSON.parse(row.v) : null
}

export function set(key, val, ttl = TTL_MS) {
  stmts.set.run(key, JSON.stringify(val), Date.now() + ttl)
}

export function del(key) {
  stmts.del.run(key)
}

export function list(prefix) {
  return stmts.list.all(prefix + '*', Date.now()).map(r => r.k)
}

export function prune() {
  stmts.prune.run(Date.now())
}

// Prune expired entries every 60s
setInterval(prune, 60_000)
