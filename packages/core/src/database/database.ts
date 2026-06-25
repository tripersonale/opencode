export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import * as PgClient from "@effect/sql-pg/PgClient"
import { Context, Effect, Layer, Redacted } from "effect"
import { Global } from "../global"
import { DatabaseMigration } from "./migration"
import { LayerNode } from "../effect/layer-node"
import * as DatabaseConfig from "./config"

const makeSqliteDatabase = EffectDrizzleSqlite.makeWithDefaults()
const makePostgresDatabase = EffectDrizzlePostgres.makeWithDefaults()

type DatabaseShape = Effect.Success<typeof makeSqliteDatabase>

// Provide a SQLite-style surface on PostgreSQL database objects so that the
// existing code base (schema files, migrations, runtime raw queries) can keep
// calling db.run/all/get while we stabilize the adapter. This is a temporary
// compatibility shim until we split SQLite and PostgreSQL services.
function compatPostgresDb(pgDb: EffectDrizzlePostgres.EffectPgDatabase & { $client: unknown }): DatabaseShape {
  if (typeof (pgDb as any).run === "function") {
    return pgDb as unknown as DatabaseShape
  }
  return Object.assign(pgDb, {
    run: (query: unknown) => pgDb.execute(query as never).pipe(Effect.asVoid),
    all: (query: unknown) => pgDb.execute(query as never),
    get: (query: unknown) => pgDb.execute(query as never).pipe(Effect.map((rows: ReadonlyArray<unknown>) => rows[0])),
  }) as unknown as DatabaseShape
}

export interface Interface {
  db: DatabaseShape
  config: DatabaseConfig.Config
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

// Base layer that builds the Database service. Runtime requirements depend on
// the configured dialect (SQLite client or PgClient). We cast to a no-context
// layer because callers provide the concrete client layer via layerFromPath or
// defaultLayer. This preserves the existing test API while allowing PG support.
const baseLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* DatabaseConfig.loadEffect

    if (config.dialect === "postgres") {
      if (!config.postgresUrl) {
        return yield* Effect.die("OPENCODE_DATABASE_DIALECT=postgres requires OPENCODE_DATABASE_URL")
      }

      const pgDb = yield* makePostgresDatabase
      const db = compatPostgresDb(pgDb)

      yield* DatabaseMigration.apply(db, config.dialect)

      return { db, config }
    }

    const db = yield* makeSqliteDatabase

    if (config.dialect === "sqlite") {
      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA synchronous = NORMAL")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* db.run("PRAGMA cache_size = -64000")
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    }

    yield* DatabaseMigration.apply(db, config.dialect)

    return { db, config }
  }).pipe(Effect.orDie),
)

export const layer = baseLayer as unknown as Layer.Layer<Service>

// SQLite-specific layer that ignores OPENCODE_DATABASE_DIALECT and always
// builds a SQLite database. Used by layerFromPath and tests that force SQLite.
function sqliteDatabaseLayer(filename: string): Layer.Layer<Service> {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const envConfig = yield* DatabaseConfig.loadEffect
      const db = yield* makeSqliteDatabase

      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA synchronous = NORMAL")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* db.run("PRAGMA cache_size = -64000")
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")

      yield* DatabaseMigration.apply(db, "sqlite")

      return { db, config: { ...envConfig, dialect: "sqlite" as const, sqliteFilename: filename } }
    }).pipe(
      Effect.provide(sqliteLayer({ filename })),
      Effect.orDie,
    ),
  )
}

// PostgreSQL-specific layer that ignores OPENCODE_DATABASE_DIALECT.
function postgresDatabaseLayer(url: string): Layer.Layer<Service> {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const envConfig = yield* DatabaseConfig.loadEffect
      const pgDb = yield* makePostgresDatabase
      const db = compatPostgresDb(pgDb)

      yield* DatabaseMigration.apply(db, "postgres")

      return { db, config: { ...envConfig, dialect: "postgres" as const, postgresUrl: url } }
    }).pipe(
      Effect.provide(Layer.mergeAll(Global.defaultLayer, PgClient.layer({ url: Redacted.make(url) }).pipe(Layer.orDie))),
      Effect.orDie,
    ),
  )
}

export function layerFromPath(filename: string) {
  return sqliteDatabaseLayer(filename)
}

export function path() {
  return DatabaseConfig.sqliteDefaultPath()
}

// Production default layer: reads dialect from env at module load and composes
// the correct client layer statically. This ensures runtime requirements
// (PgClient / SQLite client) are visible to Layer.mergeAll callers such as
// AppRuntime.
const databaseDefaultLayer = (() => {
  const config = DatabaseConfig.load()
  if (config.dialect === "postgres") {
    if (!config.postgresUrl) {
      throw new Error("OPENCODE_DATABASE_DIALECT=postgres requires OPENCODE_DATABASE_URL")
    }
    return layer.pipe(
      Layer.provide(PgClient.layer({ url: Redacted.make(config.postgresUrl) }).pipe(Layer.orDie)),
      Layer.provide(Global.defaultLayer),
    )
  }
  return layerFromPath(path()).pipe(Layer.provide(Global.defaultLayer))
})()

export const defaultLayer = databaseDefaultLayer

// Dynamic node layer used by LayerNode-based composition. It reads the dialect
// at layer-build time so that production can switch to PostgreSQL via env vars.
// Tests that need to force SQLite must use `Database.layerFromPath` directly
// and explicitly provide their own Database.node replacement; this node follows
// the configured dialect.
export const node = LayerNode.make(
  Layer.unwrap(
    Effect.map(DatabaseConfig.loadEffect, (config) => {
      if (config.dialect === "postgres") {
      if (!config.postgresUrl) {
        return Layer.effect(
          Service,
          Effect.fail("OPENCODE_DATABASE_DIALECT=postgres requires OPENCODE_DATABASE_URL"),
        ) as Layer.Layer<Service>
      }
        return postgresDatabaseLayer(config.postgresUrl)
      }
      return sqliteDatabaseLayer(config.sqliteFilename)
    }),
  ),
  [],
)

// Test helper: a Database.node replacement that always uses SQLite, regardless
// of OPENCODE_DATABASE_DIALECT. Use this in tests that want to force SQLite.
export function nodeFromPath(filename: string) {
  return LayerNode.make(sqliteDatabaseLayer(filename), [])
}