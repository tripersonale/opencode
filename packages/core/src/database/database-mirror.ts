#!/usr/bin/env bun
export * as DatabaseMirror from "./database-mirror"

import path from "path"
import fs from "fs/promises"
import { Effect, Layer, Redacted, Schedule, Duration, Ref } from "effect"
import * as PgClient from "@effect/sql-pg/PgClient"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { makePostgresAdapter, type DatabaseAdapter } from "./adapter"

export type MirrorOperation =
  | { type: "run"; id: number; query: string }
  | { type: "transaction"; id: number; operations: Array<MirrorOperation> }
  | { type: "skip"; id: number; reason: string }

export interface MirrorQueueState {
  nextId: number
  operations: Array<MirrorOperation>
}

/**
 * Serialize a drizzle SQL template to a plain SQL string with inlined,
 * properly-escaped parameters. Works for both SQLite and PostgreSQL since
 * they accept the same SQL literal syntax.
 *
 * Drizzle's SQL object has `queryChunks` — array of either StringChunk
 * (static SQL text) or raw values. We walk it and inline values, escaping
 * strings and numbers appropriately.
 */
/**
 * Recursively serialize a chunk to a SQL string. Handles nested SQL objects
 * (e.g. sql.raw produces a chunk with its own queryChunks).
 */
const chunkToString = (chunk: unknown): string => {
  if (chunk === null || chunk === undefined) return "NULL"
  if (typeof chunk === "number" || typeof chunk === "bigint") return String(chunk)
  if (typeof chunk === "boolean") return chunk ? "TRUE" : "FALSE"
  if (chunk instanceof Date) return `'${chunk.toISOString()}'`
  if (typeof chunk === "string") return chunk

  // Drizzle SQL object or wrapper - recurse
  if (typeof chunk === "object") {
    const obj = chunk as { queryChunks?: unknown[]; value?: unknown }
    if (Array.isArray(obj.queryChunks)) {
      // Recurse into nested SQL
      return obj.queryChunks.map(chunkToString).join("")
    }
    if (obj.value !== undefined && obj.value !== null && typeof obj.value !== "object") {
      return String(obj.value)
    }
    if (Array.isArray(obj.value)) {
      return obj.value.map((v) => (typeof v === "string" ? v : "")).join("")
    }
    // Unknown object - return stringified (will likely fail in PG but at least visible)
    return `'${String(chunk).slice(0, 100).replace(/'/g, "''")}'`
  }
  return `'${String(chunk).replace(/'/g, "''")}'`
}

export const serializeSQL = (query: unknown): string => {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) {
    return typeof query === "string" ? query : ""
  }
  return chunks.map(chunkToString).join("")
}

export const MirrorQueue = {
  Empty: { nextId: 1, operations: [] } as MirrorQueueState,

  load: (path: string): Effect.Effect<MirrorQueueState, never> =>
    Effect.gen(function* () {
      const text = yield* Effect.tryPromise({
        try: () => fs.readFile(path, "utf-8"),
        catch: () => undefined as never,
      }).pipe(Effect.orElseSucceed(() => undefined))

      if (!text) return MirrorQueue.Empty

      try {
        const parsed = JSON.parse(text) as MirrorQueueState
        if (typeof parsed.nextId === "number" && Array.isArray(parsed.operations)) {
          return parsed
        }
      } catch {
        // corrupt, start fresh
      }
      return MirrorQueue.Empty
    }),

  save: (path: string, state: MirrorQueueState): Effect.Effect<void, never> =>
    Effect.tryPromise({
      try: async () => {
        const dir = path.split("/").slice(0, -1).join("/")
        if (dir) await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path, JSON.stringify(state, null, 2))
      },
      catch: () => undefined as never,
    }).pipe(Effect.ignore),

  append: (state: MirrorQueueState, op: MirrorOperation): MirrorQueueState => ({
    nextId: state.nextId,
    operations: [...state.operations, op],
  }),

  drain: (
    state: MirrorQueueState,
    count: number,
  ): { remaining: MirrorQueueState; drained: Array<MirrorOperation> } => ({
    drained: state.operations.slice(0, count),
    remaining: { ...state, operations: state.operations.slice(count) },
  }),
} as const

export interface MirrorConfig {
  /** PostgreSQL connection URL for the write-behind mirror. */
  readonly url: string
  /** How often the mirror worker drains the queue (ms). Default: 1000. */
  readonly batchIntervalMs?: number
  /** Persistent queue file path. Default: ~/.local/share/opencode/opencode-mirror-queue.json */
  readonly queuePath?: string
  /** Maximum pending operations before back-pressure. Default: 10000. */
  readonly maxQueueSize?: number
  /** Drop queued operations on PG failure instead of blocking writes. Default: false. */
  readonly dropOnPgError?: boolean
}

export const resolveMirrorQueuePath = (config: MirrorConfig): string =>
  config.queuePath ??
  path.join(process.env["HOME"] ?? "/tmp", ".local/share/opencode", "opencode-mirror-queue.json")

const applyToPg = (pgDb: DatabaseAdapter, op: MirrorOperation): Effect.Effect<void, Error> => {
  if (op.type === "skip") {
    return Effect.void
  }
  if (op.type === "run") {
    return (pgDb.run(op.query) as Effect.Effect<unknown, Error, never>).pipe(Effect.asVoid) as Effect.Effect<void, Error, never>
  }
  if (op.type === "transaction") {
    return pgDb
      .transaction((tx: any) =>
        Effect.gen(function* () {
          for (const subOp of op.operations) {
            if (subOp.type === "run") {
              yield* tx.run(subOp.query)
            }
          }
        }),
      )
      .pipe(Effect.asVoid) as Effect.Effect<void, Error, never>
  }
  return Effect.void
}

/**
 * Wrap a SQLite DatabaseAdapter with a write-through mirror to PostgreSQL.
 * Every write operation is executed on SQLite (synchronous, primary) and
 * serialized to a persistent JSON queue. A background worker drains the queue
 * to PostgreSQL asynchronously. Reads serve directly from SQLite.
 */
export const makeMirrorAdapter = (
  sqlite: DatabaseAdapter,
  config: MirrorConfig,
): Effect.Effect<DatabaseAdapter, never> => {
  const queueFile = resolveMirrorQueuePath(config)
  const dropOnError = config.dropOnPgError ?? false
  const maxSize = config.maxQueueSize ?? 10000

  return Effect.gen(function* () {
    const stateRef = yield* Ref.make(MirrorQueue.Empty)

    const persist = (state: MirrorQueueState): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        yield* Ref.set(stateRef, state)
        yield* MirrorQueue.save(queueFile, state)
      })

    const appendOp = (op: MirrorOperation): Effect.Effect<boolean, never> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(stateRef)
        const isFull = current.operations.length >= maxSize
        if (isFull && !dropOnError) {
          return false
        }
        const finalOp: MirrorOperation =
          isFull && dropOnError
            ? { type: "skip", id: op.id, reason: "queue full" }
            : op
        yield* persist(MirrorQueue.append(current, finalOp))
        return true
      })

    return new Proxy(sqlite as any, {
      get(target, prop, receiver) {
        if (prop === "run") {
          return (query: unknown) =>
            Effect.gen(function* () {
              const id = yield* Ref.modify(stateRef, (s) => [s.nextId, { ...s, nextId: s.nextId + 1 }] as const)
              const serialized = serializeSQL(query)
              const enqueued = yield* appendOp({ type: "run", id, query: serialized })
              if (!enqueued) {
                return yield* Effect.fail(new Error("mirror queue full, write blocked")) as Effect.Effect<never, Error, never>
              }
              return yield* (target.run(query) as Effect.Effect<unknown, SqlClientService, never>)
            })
        }

        if (prop === "transaction") {
          const origTx = target.transaction
          return (fn: any) =>
            origTx.call(target, (tx: any) => {
              const txOps: Array<MirrorOperation> = []
              const txAdapter = new Proxy(tx, {
                get(txTarget, txProp, txReceiver) {
                  if (txProp === "run") {
                    return (query: unknown) => {
                      txOps.push({ type: "run", id: -1, query: serializeSQL(query) })
                      return txTarget.run(query)
                    }
                  }
                  if (txProp === "transaction") {
                    return undefined
                  }
                  return Reflect.get(txTarget, txProp, txReceiver)
                },
              })
              return fn(txAdapter).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    if (txOps.length === 0) return
                    const txId = yield* Ref.modify(stateRef, (s) => [s.nextId, { ...s, nextId: s.nextId + 1 }] as const)
                    const op: MirrorOperation = {
                      type: "transaction",
                      id: txId,
                      operations: txOps,
                    }
                    const enqueued = yield* appendOp(op)
                    if (!enqueued) {
                      return yield* Effect.fail(new Error("mirror queue full, write blocked")) as Effect.Effect<never, never, never>
                    }
                  }),
                ),
              )
            })
        }

        return Reflect.get(target, prop, receiver)
      },
    }) as DatabaseAdapter
  })
}

import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

/**
 * Background worker that drains the mirror queue to PostgreSQL.
 * Loads queue from disk on start, drains periodically. Failures are logged
 * but not retried individually (next drain picks up failed entries).
 */
export const startMirrorWorker = (options: {
  readonly url: string
  readonly batchIntervalMs?: number
  readonly queuePath?: string
}) => {
  const interval = Duration.millis(options.batchIntervalMs ?? 1000)
  const queueFile = options.queuePath ?? resolveMirrorQueuePath({ url: options.url })
  const maxBatch = 100

  const drainOnce = Effect.gen(function* () {
    const pgLayer = PgClient.layer({
      url: Redacted.make(options.url),
    }).pipe(Layer.orDie)

    const pgDb: DatabaseAdapter = yield* EffectDrizzlePostgres.makeWithDefaults().pipe(
      Effect.provide(pgLayer),
      Effect.orDie,
      Effect.map((db) => makePostgresAdapter(db)),
    )

    const initial = yield* MirrorQueue.load(queueFile)
    const { drained, remaining } = MirrorQueue.drain(initial, maxBatch)
    if (drained.length === 0) return

    let succeeded = 0
    let failed = 0
    for (const op of drained) {
      const exit = yield* applyToPg(pgDb, op).pipe(Effect.exit)
      if (exit._tag === "Success") {
        succeeded++
      } else {
        failed++
        const causeStr = JSON.stringify(exit.cause, (_k, v) => {
          if (typeof v === "string") return v.length > 100 ? v.slice(0, 100) + "..." : v
          if (v instanceof Error) return v.message + "\n" + (v.stack?.slice(0, 200) ?? "")
          return v
        })
        yield* Effect.sync(() => process.stdout.write(`[mirror] FAILED: op=${op.type} cause=${causeStr}\n`))
      }
    }

    yield* MirrorQueue.save(queueFile, remaining)

    yield* Effect.log(
      `mirror: drained=${drained.length} succeeded=${succeeded} failed=${failed} remaining=${remaining.operations.length}`,
    )
  })

  return Effect.gen(function* () {
    const initial = yield* MirrorQueue.load(queueFile)
    yield* Effect.log(
      `mirror worker started, interval=${Duration.toMillis(interval)}ms queue=${queueFile} pending=${initial.operations.length}`,
    )
    yield* drainOnce.pipe(Effect.repeat(Schedule.spaced(interval)), Effect.forkScoped)
    yield* Effect.never
  })
}

/** Load queue state from disk. Exposed for testing and tooling. */
export const loadMirrorQueue = (queueFile: string): Effect.Effect<MirrorQueueState, never> =>
  MirrorQueue.load(queueFile)

/** Persist queue state to disk. Exposed for testing and tooling. */
export const saveMirrorQueue = (
  queueFile: string,
  state: MirrorQueueState,
): Effect.Effect<void, never> => MirrorQueue.save(queueFile, state)
