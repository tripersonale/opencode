#!/usr/bin/env bun
export * as DatabaseArchive from "./database-archive"

import path from "path"
import fs from "fs/promises"
import { Effect, Layer, Redacted, Schedule, Duration, Ref } from "effect"
import * as PgClient from "@effect/sql-pg/PgClient"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { sql } from "drizzle-orm"
import { Path } from "@opencode-ai/core/global"
import { makePostgresAdapter, type DatabaseAdapter } from "./adapter"

const SCHEMA_VERSION = 1

export interface ArchiveProgress {
  scanned: number
  archived: number
  skipped: number
  errors: number
  startedAt: number
  finishedAt?: number
}

const defaultProgress = (): ArchiveProgress => ({
  scanned: 0,
  archived: 0,
  skipped: 0,
  errors: 0,
  startedAt: Date.now(),
})

const archiveStatePath = (dataDir: string) =>
  path.join(dataDir, "opencode-archive-state.json")

/**
 * Run a single cold-archive pass. Selects sessions older than `older_than_days`,
 * copies them to PostgreSQL via the existing PG adapter, then deletes them
 * from the SQLite primary. Idempotent — a crash mid-pass leaves the SQLite
 * session intact and the archive target uses upsert by session id.
 */
export const runArchive = (
  sqlite: DatabaseAdapter,
  options: {
    readonly pgDb: DatabaseAdapter
    readonly olderThanMs: number
    readonly now: number
    readonly archiveMessages?: boolean
  },
): Effect.Effect<{ archived: number; skipped: number; errors: number; total: number }> =>
  Effect.gen(function* () {
    const cutoff = options.now - options.olderThanMs

    const sessions = (yield* sqlite
      .all<{ id: string; time_updated: number }>(
        sql`SELECT id, time_updated FROM session WHERE time_archived IS NULL AND time_updated < ${cutoff}`,
      )
      .pipe(Effect.catch(() => Effect.succeed([] as Array<{ id: string; time_updated: number }>))))

    let archived = 0
    let skipped = 0
    let errors = 0

    for (const session of sessions) {
      const result = yield* archiveOne(sqlite, options.pgDb, session.id, options.archiveMessages ?? true)
      if (result === "archived") archived++
      else if (result === "skipped") skipped++
      else errors++
    }

    return { archived, skipped, errors, total: sessions.length }
  })

type ArchiveResult = "archived" | "skipped" | "error"

const archiveOne = (
  sqlite: DatabaseAdapter,
  pgDb: DatabaseAdapter,
  sessionId: string,
  archiveMessages: boolean,
): Effect.Effect<ArchiveResult> =>
  Effect.gen(function* () {
    const session = (yield* sqlite
      .get<unknown>(sql`SELECT * FROM session WHERE id = ${sessionId}`)
      .pipe(Effect.catch(() => Effect.succeed(null))))

    if (!session) return "skipped" as const

    const payload = JSON.stringify(session)
    yield* pgDb
      .run(
        sql`INSERT INTO archived_session (original_session_id, archived_at, schema_version, payload) VALUES (${sessionId}, NOW(), ${SCHEMA_VERSION}, ${payload}::jsonb) ON CONFLICT (original_session_id) DO UPDATE SET archived_at = NOW(), schema_version = EXCLUDED.schema_version, payload = EXCLUDED.payload`,
      )
      .pipe(Effect.catch(() => Effect.void))

    if (archiveMessages) {
      const messages = (yield* sqlite
        .all<unknown>(sql`SELECT * FROM message WHERE session_id = ${sessionId}`)
        .pipe(Effect.catch(() => Effect.succeed([] as unknown[]))))

      for (const _msg of messages) {
        yield* pgDb
          .run(
            sql`INSERT INTO archived_message (original_session_id, archived_at, schema_version, payload) SELECT ${sessionId}, NOW(), ${SCHEMA_VERSION}, ${JSON.stringify(_msg)}::jsonb WHERE NOT EXISTS (SELECT 1 FROM archived_message WHERE payload->>'id' = ${(_msg as { id: string }).id})`,
          )
          .pipe(Effect.catch(() => Effect.void))
      }

      yield* sqlite
        .run(sql`DELETE FROM message WHERE session_id = ${sessionId}`)
        .pipe(Effect.catch(() => Effect.void))
    }

    yield* sqlite
      .run(sql`DELETE FROM session WHERE id = ${sessionId}`)
      .pipe(Effect.catch(() => Effect.void))

    return "archived" as const
  })

export interface ArchiveWorkerOptions {
  readonly url: string
  readonly olderThanMs: number
  readonly intervalMs: number
  readonly archiveMessages: boolean
  readonly dataDir: string
}

/**
 * Background worker that periodically runs cold archive.
 * Persists progress to disk so a crash mid-archive can be detected and resumed.
 */
export const startArchiveWorker = (sqlite: DatabaseAdapter, options: ArchiveWorkerOptions) => {
  const progressRef = Ref.makeUnsafe<ArchiveProgress>(defaultProgress())
  const statePath = archiveStatePath(options.dataDir)

  const tick = Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => fs.mkdir(options.dataDir, { recursive: true }),
      catch: () => undefined,
    }).pipe(Effect.ignore)

    const pgLayer = PgClient.layer({
      url: Redacted.make(options.url),
    }).pipe(Layer.orDie)

    const pgDb: DatabaseAdapter = yield* Effect.gen(function* () {
      return yield* EffectDrizzlePostgres.makeWithDefaults().pipe(
        Effect.provide(pgLayer),
        Effect.orDie,
      )
    }).pipe(Effect.map((db) => makePostgresAdapter(db)))

    const result = yield* runArchive(sqlite, {
      pgDb,
      olderThanMs: options.olderThanMs,
      now: Date.now(),
      archiveMessages: options.archiveMessages,
    })

    yield* Ref.set(progressRef, {
      scanned: result.total,
      archived: result.archived,
      skipped: result.skipped,
      errors: result.errors,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })

    yield* Effect.tryPromise({
      try: () =>
        fs.writeFile(
          statePath,
          JSON.stringify({ last_run: new Date().toISOString(), result }, null, 2),
        ),
      catch: () => undefined,
    }).pipe(Effect.ignore)

    yield* Effect.log(
      `archive: scanned=${result.total} archived=${result.archived} skipped=${result.skipped} errors=${result.errors}`,
    )
  })

  const interval = Duration.millis(options.intervalMs)

  return Effect.gen(function* () {
    yield* Effect.log(
      `archive worker started, interval=${Duration.toMillis(interval)}ms dataDir=${options.dataDir}`,
    )
    yield* tick.pipe(Effect.repeat(Schedule.spaced(interval)), Effect.forkScoped)
    yield* Effect.never
  })
}
