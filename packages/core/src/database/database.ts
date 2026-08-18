export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import * as PgClient from "@effect/sql-pg/PgClient"
import { Context, Effect, Layer, Redacted } from "effect"
import { makeSqliteAdapter, makePostgresAdapter, makeMysqlAdapter, type DatabaseAdapter } from "./adapter"
import { Global } from "../global"
import { DatabaseMigration } from "./migration"
import { makeGlobalNode } from "../effect/app-node"
import * as DatabaseConfig from "./config"

const makeSqliteDatabase = EffectDrizzleSqlite.makeWithDefaults()
const makePostgresDatabase = EffectDrizzlePostgres.makeWithDefaults()

type DatabaseShape = Effect.Success<typeof makeSqliteDatabase>

export interface Interface {
  db: DatabaseAdapter
  config?: DatabaseConfig.Config
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const baseLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* DatabaseConfig.loadEffect

    if (config.dialect === "postgres") {
      if (!config.postgresUrl) {
        return yield* Effect.die("OPENCODE_DATABASE_DIALECT=postgres requires OPENCODE_DATABASE_URL")
      }

      const pgDb = yield* makePostgresDatabase
      const db = makePostgresAdapter(pgDb)

      yield* DatabaseMigration.apply(db, config.dialect)

      return { db, config }
    }

    if (config.dialect === "mysql") {
      if (!config.mysqlUrl) {
        return yield* Effect.die("OPENCODE_DATABASE_DIALECT=mysql requires OPENCODE_DATABASE_URL")
      }
      const db = makeMysqlAdapter()
      yield* DatabaseMigration.apply(db, config.dialect)
      return { db, config }
    }

    const db = makeSqliteAdapter(yield* makeSqliteDatabase)

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

export const layer = baseLayer.pipe(
  Layer.provide(DatabaseConfig.defaultLayer),
) as unknown as Layer.Layer<Service>

// SQLite-specific layer that ignores OPENCODE_DATABASE_DIALECT and always
// builds a SQLite database. Used by layerFromPath and tests that force SQLite.
function sqliteDatabaseLayer(filename: string): Layer.Layer<Service> {
  const config: DatabaseConfig.Config = {
    dialect: "sqlite",
    sqliteFilename: filename,
  }
  return baseLayer.pipe(
    Layer.provide(sqliteLayer({ filename })),
    Layer.provide(Layer.succeed(DatabaseConfig.ConfigService, config)),
  ) as unknown as Layer.Layer<Service>
}

// PostgreSQL-specific layer that ignores OPENCODE_DATABASE_DIALECT.
function postgresDatabaseLayer(url: Redacted.Redacted<string>): Layer.Layer<Service> {
  const config: DatabaseConfig.Config = {
    dialect: "postgres",
    sqliteFilename: DatabaseConfig.sqliteDefaultPath(),
    postgresUrl: url,
  }
  return baseLayer.pipe(
    Layer.provide(PgClient.layer({ url }).pipe(Layer.orDie)),
    Layer.provide(Global.node.implementation as Layer.Layer<Global.Service>),
    Layer.provide(Layer.succeed(DatabaseConfig.ConfigService, config)),
  ) as unknown as Layer.Layer<Service>
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
      Layer.provide(PgClient.layer({ url: config.postgresUrl! }).pipe(Layer.orDie)),
      Layer.provide(Global.node.implementation as Layer.Layer<Global.Service>),
    )
  }
  return layerFromPath(path()).pipe(Layer.provide(Global.node.implementation as Layer.Layer<Global.Service>))
})()

export const defaultLayer = databaseDefaultLayer

// Dynamic node layer used by LayerNode-based composition. It reads the dialect
// at layer-build time so that production can switch to PostgreSQL via env vars.
// Tests that need to force SQLite must use `Database.layerFromPath` directly
// and explicitly provide their own Database.node replacement; this node follows
// the configured dialect.
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.unwrap(
    Effect.sync(() => {
      const config = DatabaseConfig.load()
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
  deps: [] as const,
})

// Test helper: a Database.node replacement that always uses SQLite, regardless
// of OPENCODE_DATABASE_DIALECT. Use this in tests that want to force SQLite.
export function nodeFromPath(filename: string) {
  return makeGlobalNode({ service: Service, layer: sqliteDatabaseLayer(filename), deps: [] as const })
}
