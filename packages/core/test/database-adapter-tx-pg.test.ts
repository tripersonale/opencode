import { describe, expect, test } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import { sql } from "drizzle-orm"
import { pgTable, bigint, text } from "drizzle-orm/pg-core"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import * as PgClient from "@effect/sql-pg/PgClient"
import { makePostgresAdapter } from "@opencode-ai/core/database/adapter"

const POSTGRES_URL = process.env.OPENCODE_DATABASE_URL ?? "postgresql://trip:trip@localhost:5432/opencode_test"

const pgClientLayer = PgClient.layer({ url: Redacted.make(POSTGRES_URL) }).pipe(Layer.orDie)
const makePg = EffectDrizzlePostgres.makeWithDefaults()

const AdapterTable = pgTable("adapter_pg_tx", {
  id: bigint({ mode: "number" }).primaryKey(),
  name: text(),
})

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(pgClientLayer), Effect.scoped) as Effect.Effect<A, E, never>,
  )

describe("DatabaseAdapter PostgreSQL transaction proxy", () => {
  test("select inside transaction has .get()/.all()/.run() (regression for 503 on /api/project/directories)", async () => {
    await run(
      Effect.gen(function* () {
        const pg = yield* makePg
        const db = makePostgresAdapter(pg)

        yield* db.run(sql`DROP TABLE IF EXISTS adapter_pg_tx`)
        yield* db.run(sql`CREATE TABLE adapter_pg_tx (id BIGINT PRIMARY KEY, name TEXT NOT NULL)`)
        yield* db.run(sql`INSERT INTO adapter_pg_tx (id, name) VALUES (1, 'one'), (2, 'two')`)

        // Pre-fix: this throws ".get is not a function"
        // Post-fix: returns the first row
        const got = yield* db.transaction!((tx) =>
          tx.select().from(AdapterTable).where(sql`id = 1`).get(),
        )
        expect(got).not.toBeNull()
        expect(got!.id).toBe(1)
        expect(got!.name).toBe("one")

        const allRows = yield* db.transaction!((tx) =>
          tx.select().from(AdapterTable).all(),
        )
        expect(allRows.length).toBe(2)
        expect(allRows[0]!.id).toBe(1)
        expect(allRows[1]!.id).toBe(2)

        yield* db.run(sql`DROP TABLE adapter_pg_tx`)
      }),
    )
  })

  test("insert/update/delete inside transaction have patched query builders", async () => {
    await run(
      Effect.gen(function* () {
        const pg = yield* makePg
        const db = makePostgresAdapter(pg)

        yield* db.run(sql`DROP TABLE IF EXISTS adapter_pg_tx`)
        yield* db.run(sql`CREATE TABLE adapter_pg_tx (id BIGINT PRIMARY KEY, name TEXT NOT NULL)`)

        // Pre-fix: this throws ".all is not a function" or similar
        // Post-fix: insert returns void, select returns rows
        yield* db.transaction!((tx) =>
          tx.insert(AdapterTable).values({ id: 1, name: "first" }).run(),
        )

        const all = yield* db.transaction!((tx) =>
          tx.select().from(AdapterTable).all(),
        )
        expect(all.length).toBe(1)
        expect(all[0]!.name).toBe("first")

        // Update
        yield* db.transaction!((tx) =>
          tx.update(AdapterTable).set({ name: "updated" }).where(sql`id = 1`).run(),
        )

        const after = yield* db.transaction!((tx) =>
          tx.select().from(AdapterTable).where(sql`id = 1`).get(),
        )
        expect(after!.name).toBe("updated")

        // Delete
        yield* db.transaction!((tx) =>
          tx.delete(AdapterTable).where(sql`id = 1`).run(),
        )

        const empty = yield* db.transaction!((tx) =>
          tx.select().from(AdapterTable).all(),
        )
        expect(empty.length).toBe(0)

        yield* db.run(sql`DROP TABLE adapter_pg_tx`)
      }),
    )
  })

  test("nested query builders in transaction also have patched methods", async () => {
    await run(
      Effect.gen(function* () {
        const pg = yield* makePg
        const db = makePostgresAdapter(pg)

        yield* db.run(sql`DROP TABLE IF EXISTS adapter_pg_tx`)
        yield* db.run(sql`CREATE TABLE adapter_pg_tx (id BIGINT PRIMARY KEY, name TEXT NOT NULL)`)
        yield* db.run(
          sql`INSERT INTO adapter_pg_tx (id, name) VALUES (1, 'one'), (2, 'two'), (3, 'three')`,
        )

        // Test that chained methods (where, orderBy, etc.) also have patched QB
        // Pre-fix: this throws ".all is not a function" because where() returns
        // a builder without patchEffectQuery
        const filtered = yield* db.transaction!((tx) =>
          tx.select().from(AdapterTable).where(sql`id > 1`).orderBy(sql`id`).all(),
        )
        expect(filtered.length).toBe(2)
        expect(filtered[0]!.id).toBe(2)
        expect(filtered[1]!.id).toBe(3)

        yield* db.run(sql`DROP TABLE adapter_pg_tx`)
      }),
    )
  })
})
