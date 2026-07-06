import { describe, test, expect } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import * as PgClient from "@effect/sql-pg/PgClient"
import { sql } from "drizzle-orm"
import { makePostgresAdapter } from "@opencode-ai/core/database/adapter"
import { serializeSQL, loadMirrorQueue, saveMirrorQueue } from "@opencode-ai/core/database/database-mirror"
import { $ } from "bun"

const URL = "postgresql://trip:trip@localhost:5432/opencode_test"
const TABLE = "mirror_e2e_v12"
const QUEUE = "/tmp/mirror-e2e-v12-queue.json"

const pgLayer = PgClient.layer({ url: Redacted.make(URL) }).pipe(Layer.orDie)
const runPg = (eff: any) => Effect.runPromise(eff.pipe(Effect.provide(pgLayer), Effect.scoped) as any)

async function psql(cmd: string) {
  await $`PGPASSWORD=trip psql -h localhost -U trip -d opencode_test -c ${cmd}`.quiet()
}

describe("DatabaseMirror end-to-end", () => {
  test("serializeSQL with inline values", () => {
    const q1 = sql`INSERT INTO x VALUES (1, 'one')`
    const result = serializeSQL(q1)
    expect(result).toBe("INSERT INTO x VALUES (1, 'one')")
  })

  test("serializeSQL handles sql.raw table names", () => {
    const q2 = sql`INSERT INTO ${sql.raw("my_table")} VALUES (1, 'one')`
    const result = serializeSQL(q2)
    expect(result).toBe("INSERT INTO my_table VALUES (1, 'one')")
  })

  test("serializeSQL handles sql.raw nested", () => {
    const q3 = sql`DROP TABLE IF EXISTS ${sql.raw("foo")}`
    const result = serializeSQL(q3)
    expect(result).toBe("DROP TABLE IF EXISTS foo")
  })

  test(
    "write-behind mirror: queue drains to PostgreSQL",
    async () => {
      await psql(`DROP TABLE IF EXISTS ${TABLE}`)
      await psql(`CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, value TEXT)`)

      const q1 = sql`INSERT INTO ${sql.raw(TABLE)} VALUES (1, 'one')`
      const q2 = sql`INSERT INTO ${sql.raw(TABLE)} VALUES (2, 'two')`
      const q3 = sql`INSERT INTO ${sql.raw(TABLE)} VALUES (3, 'three')`

      await runPg(Effect.gen(function* () {
        yield* saveMirrorQueue(QUEUE, {
          nextId: 4,
          operations: [
            { type: "run", id: 1, query: serializeSQL(q1) },
            { type: "run", id: 2, query: serializeSQL(q2) },
            { type: "run", id: 3, query: serializeSQL(q3) },
          ],
        })

        const queue = yield* loadMirrorQueue(QUEUE)
        expect(queue.operations.length).toBe(3)

        const pgDb = yield* EffectDrizzlePostgres.makeWithDefaults()
        const pg = makePostgresAdapter(pgDb as any)

        for (const op of queue.operations) {
          if (op.type === "run") {
            yield* pg.run(sql.raw(op.query))
          }
        }

        const count = yield* pg.get(sql`SELECT count(*) AS n FROM ${sql.raw(TABLE)}`)
        expect(Number((count as any)?.n)).toBe(3)

        const rows = yield* pg.all(sql`SELECT * FROM ${sql.raw(TABLE)} ORDER BY id`)
        expect(rows.length).toBe(3)
        expect((rows[0] as any).id).toBe(1)
        expect((rows[0] as any).value).toBe("one")
        expect((rows[2] as any).id).toBe(3)
        expect((rows[2] as any).value).toBe("three")
      }))

      await psql(`DROP TABLE IF EXISTS ${TABLE}`)
    },
    { timeout: 30000 },
  )
})
