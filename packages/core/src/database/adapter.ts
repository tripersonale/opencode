export * as DatabaseAdapter from "./adapter"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import type * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { Effect } from "effect"

const makeSqliteDatabase = EffectDrizzleSqlite.makeWithDefaults()
export type DatabaseShape = Effect.Success<typeof makeSqliteDatabase>

export type DatabaseAdapter = DatabaseShape

function normalizePgRow(row: unknown): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row
  const next: Record<string, unknown> = { ...(row as Record<string, unknown>) }
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "string" && /^-?\d+$/.test(value)) {
      const num = Number(value)
      if (next[key] !== num) {
        next[key] = num
      }
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
    "for",
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
                    return (query: unknown) => txTarget.execute(query).pipe(Effect.map(normalizePgRows))
                  }
                  if (txProp === "get") {
                    return (query: unknown) =>
                      txTarget.execute(query).pipe(
                        Effect.map((rows: ReadonlyArray<unknown>) => normalizePgRow(rows[0])),
                      )
                  }
                  if (txProp === "select" || txProp === "insert" || txProp === "update" || txProp === "delete") {
                    const orig = txTarget[txProp]
                    if (typeof orig === "function") {
                      return function (this: any, ...args: any[]) {
                        return patchEffectQuery(orig.apply(txTarget, args))
                      }
                    }
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

export function makeMysqlAdapter(): DatabaseAdapter {
  const die = <A = never, E = never>(): Effect.Effect<A, E, never> =>
    Effect.die("OPENCODE_DATABASE_DIALECT=mysql is not implemented. See dialect.ts for supported dialects.") as Effect.Effect<A, E, never>

  const stub = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "run") return () => die()
        if (prop === "all") return () => die()
        if (prop === "get") return () => die()
        if (prop === "select") return () => die()
        if (prop === "insert") return () => die()
        if (prop === "update") return () => die()
        if (prop === "delete") return () => die()
        if (prop === "transaction") return () => die()
        return () => die()
      },
    },
  )

  return stub as unknown as DatabaseAdapter
}
