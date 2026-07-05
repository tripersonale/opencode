import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeMysqlAdapter } from "@opencode-ai/core/database/adapter"

describe("DatabaseAdapter MySQL stub", () => {
  test("run() yields not-implemented error", async () => {
    const db = makeMysqlAdapter()
    const exit = await Effect.runPromise(Effect.exit(db.run("SELECT 1")))
    expect(exit._tag).toBe("Failure")
  })

  test("all() yields not-implemented error", async () => {
    const db = makeMysqlAdapter()
    const exit = await Effect.runPromise(Effect.exit(db.all("SELECT 1")))
    expect(exit._tag).toBe("Failure")
  })

  test("get() yields not-implemented error", async () => {
    const db = makeMysqlAdapter()
    const exit = await Effect.runPromise(Effect.exit(db.get("SELECT 1")))
    expect(exit._tag).toBe("Failure")
  })

  test("select() chain yields not-implemented error", async () => {
    const db = makeMysqlAdapter()
    const exit = await Effect.runPromise(Effect.exit(db.select() as unknown as Effect.Effect<unknown, never, never>))
    expect(exit._tag).toBe("Failure")
  })

  test("transaction() yields not-implemented error", async () => {
    const db = makeMysqlAdapter()
    const exit = await Effect.runPromise(Effect.exit(db.transaction(() => Effect.void)))
    expect(exit._tag).toBe("Failure")
  })
})
