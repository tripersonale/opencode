import { describe, expect, test } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import { sql } from "drizzle-orm"
import { pgTable, bigint, text } from "drizzle-orm/pg-core"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import * as PgClient from "@effect/sql-pg/PgClient"
import { makePostgresAdapter } from "@opencode-ai/core/database/adapter"

const POSTGRES_URL = process.env.OPENCODE_TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/opencode_test"

const pgClientLayer = PgClient.layer({ url: Redacted.make(POSTGRES_URL) }).pipe(Layer.orDie)
const makePg = EffectDrizzlePostgres.makeWithDefaults()

const AdapterTable = pgTable("adapter_pg_qb", {
  id: bigint({ mode: "number" }).primaryKey(),
  name: text(),
})

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(pgClientLayer), Effect.scoped) as Effect.Effect<A, E, never>,
  )

describe("DatabaseAdapter PostgreSQL", () => {
  test("pg adapter normalizes BIGINT numeric fields to JS numbers", async () => {
    await run(
      Effect.gen(function* () {
        const pg = yield* makePg
        const db = makePostgresAdapter(pg)
        yield* db.run(sql`DROP TABLE IF EXISTS adapter_pg_test`)
        yield* db.run(sql`CREATE TABLE adapter_pg_test (id BIGINT PRIMARY KEY, time_created BIGINT NOT NULL)`)
        yield* db.run(sql`INSERT INTO adapter_pg_test VALUES (1, 1700000000000)`)

        const row = yield* db.get<{ id: number; time_created: number }>(
          sql`SELECT id, time_created FROM adapter_pg_test WHERE id = 1`,
        )

        expect(row).not.toBeNull()
        expect(row!.id).toBe(1)
        expect(typeof row!.id).toBe("number")
        expect(row!.time_created).toBe(1700000000000)
        expect(typeof row!.time_created).toBe("number")

        yield* db.run(sql`DROP TABLE adapter_pg_test`)
      }),
    )
  })

  test("pg adapter all() returns array with normalized rows", async () => {
    await run(
      Effect.gen(function* () {
        const pg = yield* makePg
        const db = makePostgresAdapter(pg)
        yield* db.run(sql`DROP TABLE IF EXISTS adapter_pg_multi`)
        yield* db.run(sql`CREATE TABLE adapter_pg_multi (seq BIGINT, position BIGINT, label TEXT)`)
        yield* db.run(sql`INSERT INTO adapter_pg_multi VALUES (1, 100, 'a'), (2, 200, 'b'), (3, 300, 'c')`)

        const rows = yield* db.all<{ seq: number; position: number; label: string }>(
          sql`SELECT seq, position, label FROM adapter_pg_multi ORDER BY seq`,
        )

        expect(rows).toHaveLength(3)
        expect(rows[0].seq).toBe(1)
        expect(rows[1].position).toBe(200)
        expect(typeof rows[2].seq).toBe("number")

        yield* db.run(sql`DROP TABLE adapter_pg_multi`)
      }),
    )
  })

  test("pg adapter non-numeric fields remain as-is", async () => {
    await run(
      Effect.gen(function* () {
        const pg = yield* makePg
        const db = makePostgresAdapter(pg)
        yield* db.run(sql`DROP TABLE IF EXISTS adapter_pg_text`)
        yield* db.run(sql`CREATE TABLE adapter_pg_text (name TEXT, flag BOOLEAN)`)
        yield* db.run(sql`INSERT INTO adapter_pg_text VALUES ('hello', true)`)

        const row = yield* db.get<{ name: string; flag: boolean }>(
          sql`SELECT name, flag FROM adapter_pg_text`,
        )

        expect(row).not.toBeNull()
        expect(row!.name).toBe("hello")
        expect(row!.flag).toBe(true)

        yield* db.run(sql`DROP TABLE adapter_pg_text`)
      }),
    )
  })

  test("pg adapter transaction proxies tx with run/all/get", async () => {
    await run(
      Effect.gen(function* () {
        const pg = yield* makePg
        const db = makePostgresAdapter(pg)
        yield* db.run(sql`DROP TABLE IF EXISTS adapter_pg_tx`)
        yield* db.run(sql`CREATE TABLE adapter_pg_tx (id BIGINT PRIMARY KEY)`)

        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`INSERT INTO adapter_pg_tx VALUES (1)`)
            const rows = yield* tx.all<{ id: number }>(sql`SELECT * FROM adapter_pg_tx`)
            expect(rows).toHaveLength(1)
            expect(typeof rows[0].id).toBe("number")
          }),
        )

        yield* db.run(sql`DROP TABLE adapter_pg_tx`)
      }),
    )
  })

  test("pg adapter transaction rollback discards inserts", async () => {
    await run(
      Effect.gen(function* () {
        const pg = yield* makePg
        const db = makePostgresAdapter(pg)
        yield* db.run(sql`DROP TABLE IF EXISTS adapter_pg_rollback`)
        yield* db.run(sql`CREATE TABLE adapter_pg_rollback (id BIGINT PRIMARY KEY)`)

        const outcome = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.run(sql`INSERT INTO adapter_pg_rollback VALUES (1)`)
              yield* Effect.fail("intentional rollback")
            }),
          )
          .pipe(Effect.exit)

        expect(outcome._tag).toBe("Failure")

        const rows = yield* db.all<{ id: number }>(sql`SELECT * FROM adapter_pg_rollback`)
        expect(rows).toHaveLength(0)

        yield* db.run(sql`DROP TABLE adapter_pg_rollback`)
      }),
    )
  })

  test("pg adapter select query builder with pgTable returns rows", async () => {
    await run(
      Effect.gen(function* () {
        const pg = yield* makePg
        const db = makePostgresAdapter(pg)
        yield* db.run(sql`DROP TABLE IF EXISTS adapter_pg_qb`)
        yield* db.run(sql`CREATE TABLE adapter_pg_qb (id BIGINT PRIMARY KEY, name TEXT)`)
        yield* db.run(sql`INSERT INTO adapter_pg_qb VALUES (1, 'first'), (2, 'second')`)

        const rows = yield* db.select().from(AdapterTable).where(sql`id > 1`).all()

        expect(rows).toHaveLength(1)
        expect(rows[0]).toEqual({ id: 2, name: "second" })
        expect(typeof rows[0].id).toBe("number")

        yield* db.run(sql`DROP TABLE adapter_pg_qb`)
      }),
    )
  })
})
