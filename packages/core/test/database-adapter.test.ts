import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { makeSqliteAdapter } from "@opencode-ai/core/database/adapter"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

describe("DatabaseAdapter", () => {
  test("sqlite adapter exposes run/all/get helpers", async () => {
    await run(
      Effect.gen(function* () {
        const raw = yield* EffectDrizzleSqlite.makeWithDefaults()
        const db = makeSqliteAdapter(raw)
        yield* db.run(sql`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)`)
        yield* db.run(sql`INSERT INTO test VALUES (1, 'hello')`)
        const rows = yield* db.all<{ id: number; name: string }>(sql`SELECT * FROM test`)
        expect(rows).toEqual([{ id: 1, name: "hello" }])
        const row = yield* db.get<{ id: number; name: string }>(sql`SELECT * FROM test WHERE id = 1`)
        expect(row).toEqual({ id: 1, name: "hello" })
      }),
    )
  })

  test("sqlite adapter transaction proxies tx", async () => {
    await run(
      Effect.gen(function* () {
        const raw = yield* EffectDrizzleSqlite.makeWithDefaults()
        const db = makeSqliteAdapter(raw)
        yield* db.run(sql`CREATE TABLE tx (id INTEGER PRIMARY KEY)`)
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`INSERT INTO tx VALUES (1)`)
            const rows = yield* tx.all<{ id: number }>(sql`SELECT * FROM tx`)
            expect(rows).toEqual([{ id: 1 }])
          }),
        )
      }),
    )
  })
})
