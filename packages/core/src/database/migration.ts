export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import sqliteSchema from "./schema.gen"
import pgSchema from "./schema.gen.pg"
import type { Dialect } from "./dialect"

// The Service always exposes a SQLite-shaped database object. For PostgreSQL
// the underlying driver is PG but we add SQLite-style run/all/get helpers so
// existing migrations and schema files keep working while the adapter is being
// stabilized. See database.ts for the DB wrapper.
type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]

const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

// Provide a SQLite-style surface on PostgreSQL transaction objects so that
// schema files and TS migrations can keep calling tx.run/all/get.
function compatTx(tx: any, dialect: Dialect): Transaction {
  if (dialect === "postgres" && typeof tx.run !== "function") {
    return Object.assign(tx, {
      run: (query: unknown) => tx.execute(query).pipe(Effect.asVoid),
      all: (query: unknown) => tx.execute(query),
      get: (query: unknown) => tx.execute(query).pipe(Effect.map((rows: ReadonlyArray<unknown>) => rows[0])),
    })
  }
  return tx as Transaction
}

function listTablesQuery(dialect: Dialect) {
  if (dialect === "postgres") {
    return sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'`
  }
  return sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
}

function drizzleMigrationTableQuery(dialect: Dialect) {
  if (dialect === "postgres") {
    return sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${"__drizzle_migrations"}`
  }
  return sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`
}

function seedMigrationQuery(dialect: Dialect) {
  if (dialect === "postgres") {
    return sql`
      INSERT INTO ${sql.identifier("migration")} (id, time_completed)
      SELECT name, ${Date.now()}
      FROM ${sql.identifier("__drizzle_migrations")}
      WHERE name IS NOT NULL
      ON CONFLICT (id) DO NOTHING
    `
  }
  return sql`
    INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
    SELECT name, ${Date.now()}
    FROM ${sql.identifier("__drizzle_migrations")}
    WHERE name IS NOT NULL
  `
}

function createMigrationTableQuery(dialect: Dialect) {
  if (dialect === "postgres") {
    return sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed BIGINT NOT NULL)`
  }
  return sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`
}

function insertMigrationQuery(dialect: Dialect, migration: Migration) {
  if (dialect === "postgres") {
    return sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()}) ON CONFLICT (id) DO NOTHING`
  }
  return sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`
}

export function apply(db: Database, dialect: Dialect) {
  return lock.withPermit(
    Effect.gen(function* () {
      const schema = dialect === "postgres" ? pgSchema : sqliteSchema
      const tables = yield* db.all<{ name: string }>(listTablesQuery(dialect))
      if (tables.some((table) => table.name === "session")) return yield* applyOnly(db, migrations, dialect)
      if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const wrappedTx = compatTx(tx, dialect)
          yield* schema.up(wrappedTx)
          yield* wrappedTx.run(createMigrationTableQuery(dialect))
          yield* Effect.forEach(migrations, (migration) =>
            wrappedTx.run(insertMigrationQuery(dialect, migration)),
          )
        }),
      )
    }),
  ) as Effect.Effect<void, unknown, never>
}

export function applyOnly(db: Database, input: Migration[], dialect: Dialect) {
  return Effect.gen(function* () {
    yield* db.run(createMigrationTableQuery(dialect))
    let completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      if (
        yield* db.get(drizzleMigrationTableQuery(dialect))
      ) {
        yield* db.run(seedMigrationQuery(dialect))
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const wrappedTx = compatTx(tx, dialect)
          yield* migration.up(wrappedTx)
          yield* wrappedTx.run(insertMigrationQuery(dialect, migration))
        }),
      )
    }
  }) as Effect.Effect<void, unknown, never>
}
