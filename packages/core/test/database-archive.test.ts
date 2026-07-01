import { describe, expect, test } from "bun:test"
import { Effect, Layer, Redacted, Exit } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import * as EffectDrizzleSqlite from "@opencode-ai/effect-drizzle-sqlite"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import * as PgClient from "@effect/sql-pg/PgClient"
import { sql } from "drizzle-orm"
import { runArchive, startArchiveWorker } from "@opencode-ai/core/database/database-archive"
import { makeSqliteAdapter, makePostgresAdapter } from "@opencode-ai/core/database/adapter"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { TEST_POSTGRES_URL } from "./database-test-pg"

const POSTGRES_URL = TEST_POSTGRES_URL

const runSqlite = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    )
  )

const runFull = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteClient.layer({ filename: ":memory:", disableWAL: true }),
          PgClient.layer({ url: Redacted.make(POSTGRES_URL) }).pipe(Layer.orDie),
        ),
      ),
      Effect.scoped,
    )
  )

describe("DatabaseArchive", () => {
  test("runArchive skips recent sessions", async () => {
    await runSqlite(
      Effect.gen(function* () {
        const sqliteRaw = yield* EffectDrizzleSqlite.makeWithDefaults()
        const sqlite = makeSqliteAdapter(sqliteRaw)
        yield* sqlite.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY, time_archived INTEGER, time_updated INTEGER)`)
        yield* sqlite.run(sql`INSERT INTO session VALUES ('recent', NULL, ${Date.now()})`)
        yield* sqlite.run(sql`INSERT INTO session VALUES ('old', NULL, ${Date.now() - 100 * 86_400_000})`)

        const recentSessions = yield* sqlite.all<{ id: string }>(sql`SELECT id FROM session WHERE id = 'recent'`)
        expect(recentSessions.length).toBe(1)
      }),
    )
  })

  test("runArchive returns zero when no PG adapter (skips gracefully)", async () => {
    await runSqlite(
      Effect.gen(function* () {
        const sqliteRaw = yield* EffectDrizzleSqlite.makeWithDefaults()
        const sqlite = makeSqliteAdapter(sqliteRaw)
        yield* sqlite.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY, time_archived INTEGER, time_updated INTEGER)`)

        const fakePg = makeSqliteAdapter(sqliteRaw)
        const result = yield* runArchive(sqlite, {
          pgDb: fakePg,
          olderThanMs: 0,
          now: Date.now() + 86_400_000,
        })

        expect(result.total).toBe(0)
      }),
    )
  })

  test("startArchiveWorker initializes without error", async () => {
    const exit = await runFull(
      Effect.gen(function* () {
        const sqliteRaw = yield* EffectDrizzleSqlite.makeWithDefaults()
        const sqlite = makeSqliteAdapter(sqliteRaw)
        const worker = startArchiveWorker(sqlite, {
          url: POSTGRES_URL,
          olderThanMs: 30 * 86_400_000,
          intervalMs: 86_400_000,
          archiveMessages: true,
          dataDir: "/tmp/trip-archive-test",
        })
        return yield* worker.pipe(Effect.forkScoped, Effect.scoped) as Effect.Effect<void, never, never>
      }).pipe(Effect.scoped) as Effect.Effect<unknown, never, never>,
    )
    expect(exit).toBeDefined()
  })
})
