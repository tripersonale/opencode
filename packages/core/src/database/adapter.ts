export * as DatabaseAdapter from "./adapter"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import type * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { Effect } from "effect"

const makeSqliteDatabase = EffectDrizzleSqlite.makeWithDefaults()
export type DatabaseShape = Effect.Success<typeof makeSqliteDatabase>

export type DatabaseAdapter = DatabaseShape

const numericPgFields = new Set([
  "active",
  "admitted_seq",
  "baseline_seq",
  "count",
  "position",
  "revision",
  "seq",
  "time_archived",
  "time_completed",
  "time_created",
  "time_updated",
  "time_initialized",
  "time_used",
  "tokens_cache_read",
  "tokens_cache_write",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
])

function normalizePgRow(row: unknown): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row
  const next: Record<string, unknown> = { ...(row as Record<string, unknown>) }
  for (const [key, value] of Object.entries(next)) {
    if (numericPgFields.has(key) && typeof value === "string" && /^-?\d+$/.test(value)) {
      next[key] = Number(value)
    }
  }
  return next
}

function normalizePgRows(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows
  return rows.map(normalizePgRow)
}

function patchEffectQuery(qb: any): any {
  if (!qb || typeof qb !== "object") return qb
  if (!("get" in qb)) {
    qb.get = () => qb.pipe(Effect.map((rows: ReadonlyArray<unknown>) => normalizePgRow(rows[0])))
  }
  if (!("all" in qb)) {
    qb.all = () => qb.pipe(Effect.map(normalizePgRows))
  }
  if (!("run" in qb)) {
    qb.run = () => qb.pipe(Effect.asVoid)
  }
  for (const method of [
    "from",
    "where",
    "values",
    "set",
    "returning",
    "onConflictDoUpdate",
    "onConflictDoNothing",
    "innerJoin",
    "leftJoin",
    "rightJoin",
    "orderBy",
    "limit",
    "offset",
    "groupBy",
    "having",
  ]) {
    const orig = qb[method]
    if (typeof orig === "function" && !orig.__opencodePgCompatPatched) {
      const wrapped = function (this: any, ...args: any[]) {
        return patchEffectQuery(orig.apply(this, args))
      }
      ;(wrapped as any).__opencodePgCompatPatched = true
      qb[method] = wrapped
    }
  }
  return qb
}

export function makeSqliteAdapter(db: DatabaseShape): DatabaseAdapter {
  return db
}

export function makePostgresAdapter(
  pgDb: EffectDrizzlePostgres.EffectPgDatabase & { $client: unknown },
): DatabaseAdapter {
  const execute = (pgDb as any).execute.bind(pgDb)

  return new Proxy(pgDb as any, {
    get(target, prop, receiver) {
      if (prop === "run") {
        return (query: unknown) => execute(query).pipe(Effect.asVoid)
      }
      if (prop === "all") {
        return (query: unknown) => execute(query).pipe(Effect.map(normalizePgRows))
      }
      if (prop === "get") {
        return (query: unknown) =>
          execute(query).pipe(Effect.map((rows: ReadonlyArray<unknown>) => normalizePgRow(rows[0])))
      }

      if (prop === "select" || prop === "insert" || prop === "update" || prop === "delete") {
        const orig = target[prop]
        if (typeof orig === "function") {
          return function (this: any, ...args: any[]) {
            return patchEffectQuery(orig.apply(target, args))
          }
        }
      }

      if (prop === "transaction") {
        const origTransaction = target.transaction
        if (typeof origTransaction === "function") {
          return function (this: any, fn: any) {
            return origTransaction.call(target, (tx: any) => {
              const txAdapter = new Proxy(tx, {
                get(txTarget, txProp, txReceiver) {
                  if (txProp === "run") {
                    return (query: unknown) => txTarget.execute(query).pipe(Effect.asVoid)
                  }
                  if (txProp === "all") {
                    return (query: unknown) => txTarget.execute(query)
                  }
                  if (txProp === "get") {
                    return (query: unknown) =>
                      txTarget.execute(query).pipe(Effect.map((rows: ReadonlyArray<unknown>) => rows[0]))
                  }
                  return Reflect.get(txTarget, txProp, txReceiver)
                },
              })
              return fn(txAdapter)
            })
          }
        }
      }

      return Reflect.get(target, prop, receiver)
    },
  }) as DatabaseAdapter
}
