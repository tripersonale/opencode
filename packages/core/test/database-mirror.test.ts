import { describe, expect, test } from "bun:test"
import { Effect, Layer, Redacted, Fiber } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import * as EffectDrizzleSqlite from "@opencode-ai/effect-drizzle-sqlite"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import * as PgClient from "@effect/sql-pg/PgClient"
import { sql } from "drizzle-orm"
import { makeSqliteAdapter, makePostgresAdapter } from "@opencode-ai/core/database/adapter"
import {
  makeMirrorAdapter,
  startMirrorWorker,
  loadMirrorQueue,
  saveMirrorQueue,
  MirrorQueue,
  resolveMirrorQueuePath,
  type MirrorQueueState,
} from "@opencode-ai/core/database/database-mirror"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const POSTGRES_URL = process.env.OPENCODE_TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/opencode_test"

const runSqlite = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const TEST_QUEUE = "/tmp/trip-mirror-test-queue.json"

describe("DatabaseMirror", () => {
  test("MirrorQueue: append and drain", async () => {
    let state: MirrorQueueState = MirrorQueue.Empty
    state = MirrorQueue.append(state, { type: "run", id: 1, query: "INSERT INTO x VALUES (1)" })
    state = MirrorQueue.append(state, { type: "run", id: 2, query: "INSERT INTO x VALUES (2)" })
    expect(state.operations.length).toBe(2)
    expect(state.nextId).toBe(1)

    const drained = MirrorQueue.drain(state, 1)
    expect(drained.drained.length).toBe(1)
    expect(drained.remaining.operations.length).toBe(1)
  })

  test("MirrorQueue: persist and load roundtrip", async () => {
    let state: MirrorQueueState = MirrorQueue.Empty
    state = MirrorQueue.append(state, { type: "run", id: 42, query: "TEST" })
    await Effect.runPromise(saveMirrorQueue(TEST_QUEUE, state))
    const loaded = await Effect.runPromise(loadMirrorQueue(TEST_QUEUE))
    expect(loaded.operations.length).toBe(1)
    expect(loaded.operations[0]).toEqual({ type: "run", id: 42, query: "TEST" })
  })

  test("resolveMirrorQueuePath returns default if not specified", () => {
    const p = resolveMirrorQueuePath({ url: "postgresql://x" })
    expect(p).toContain("opencode-mirror-queue.json")
  })

  test("makeMirrorAdapter: enqueues run queries", async () => {
    await runSqlite(
      Effect.gen(function* () {
        const sqliteRaw = yield* EffectDrizzleSqlite.makeWithDefaults()
        const sqlite = makeSqliteAdapter(sqliteRaw)
        yield* sqlite.run(sql`CREATE TABLE m_test (id INTEGER PRIMARY KEY)`)
        yield* sqlite.run(sql`INSERT INTO m_test VALUES (1)`)

        const mirrored = yield* makeMirrorAdapter(sqlite, {
          url: POSTGRES_URL,
          queuePath: TEST_QUEUE,
        })

        yield* saveMirrorQueue(TEST_QUEUE, MirrorQueue.Empty)
        yield* (mirrored.run(sql`INSERT INTO m_test VALUES (2)`) as Effect.Effect<void, unknown, SqlClientService>)

        const queue = yield* loadMirrorQueue(TEST_QUEUE)
        expect(queue.operations.length).toBeGreaterThanOrEqual(1)
        const hasInsert = queue.operations.some(
          (op) => op.type === "run" && op.query.includes("INSERT INTO m_test VALUES (2)"),
        )
        expect(hasInsert).toBe(true)

        const count = yield* sqlite.get<{ n: number }>(sql`SELECT count(*) AS n FROM m_test`)
        expect(count?.n).toBe(2)
      }),
    )
  })

  test("makeMirrorAdapter: enqueues transaction ops as single tx op", async () => {
    await runSqlite(
      Effect.gen(function* () {
        const sqliteRaw = yield* EffectDrizzleSqlite.makeWithDefaults()
        const sqlite = makeSqliteAdapter(sqliteRaw)
        yield* sqlite.run(sql`CREATE TABLE m_tx (id INTEGER PRIMARY KEY, name TEXT)`)

        const mirrored = yield* makeMirrorAdapter(sqlite, {
          url: POSTGRES_URL,
          queuePath: TEST_QUEUE,
        })

        yield* saveMirrorQueue(TEST_QUEUE, MirrorQueue.Empty)

        yield* (mirrored.transaction((tx: any) =>
            Effect.gen(function* () {
              yield* (tx.run(sql`INSERT INTO m_tx VALUES (1, 'a')`) as Effect.Effect<void, unknown, SqlClientService>)
              yield* (tx.run(sql`INSERT INTO m_tx VALUES (2, 'b')`) as Effect.Effect<void, unknown, SqlClientService>)
            }),
) as Effect.Effect<unknown, unknown, SqlClientService>)

        const queue = yield* loadMirrorQueue(TEST_QUEUE)
        const txOps = queue.operations.filter((op) => op.type === "transaction")
        expect(txOps.length).toBe(1)
        const txOp = txOps[0] as { type: "transaction"; operations: Array<{ type: string; query: string }> }
        expect(txOp.operations.length).toBe(2)
      }),
    )
  })

  test("startMirrorWorker initializes and drains an empty queue without error", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* saveMirrorQueue(TEST_QUEUE, MirrorQueue.Empty)
        const workerFiber = yield* Effect.forkScoped(
          startMirrorWorker({
            url: POSTGRES_URL,
            queuePath: TEST_QUEUE,
            batchIntervalMs: 50,
          }),
        )
        yield* Effect.sleep("100 millis")
        yield* Fiber.interrupt(workerFiber)
      }).pipe(
        Effect.provide(PgClient.layer({ url: Redacted.make(POSTGRES_URL) }).pipe(Layer.orDie)),
        Effect.scoped,
      ),
    )
  })
})
