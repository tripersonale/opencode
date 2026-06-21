import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { AbsolutePath, Location, Model, OpenCode, Session, Tool } from "@opencode-ai/core/public"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(OpenCode.layer)

describe("public native OpenCode API", () => {
  it.effect("exposes only the intentional Session capabilities", () =>
    Effect.gen(function* () {
      const opencode = yield* OpenCode.Service

      expect(Object.keys(opencode).sort()).toEqual(["sessions", "tools"])

      expect(Object.keys(opencode.sessions).sort()).toEqual([
        "context",
        "create",
        "events",
        "get",
        "interrupt",
        "list",
        "message",
        "messages",
        "prompt",
        "switchModel",
      ])
      expect(Session.ID.create()).toStartWith("ses_")
      expect(Session.MessageID.create()).toStartWith("msg_")
      expect(yield* opencode.sessions.list()).toBeArray()
      yield* opencode.tools.register({
        public_tool: Tool.make({
          description: "Public tool",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.succeed({ ok: true }),
        }),
      })
    }),
  )

  it.effect("switches to an available model and variant", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      try {
        yield* writeProvider(tmp.path)
        const opencode = yield* OpenCode.Service
        const sessionID = Session.ID.make("ses_public_switch_available")
        const model = ref({ variant: "fast" })
        yield* opencode.sessions.create({
          id: sessionID,
          location: Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }),
        })

        yield* opencode.sessions.switchModel({ sessionID, model })

        expect((yield* opencode.sessions.get(sessionID)).model).toEqual(model)
      } finally {
        yield* Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.ignore)
      }
    }),
  )

  it.effect("rejects missing and Location-disabled models without changing the Session", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => Promise.all([tmpdir(), tmpdir()]))
      const [available, disabled] = dirs
      try {
        yield* writeProvider(available.path)
        yield* writeProvider(disabled.path, true)
        const opencode = yield* OpenCode.Service
        const availableID = Session.ID.make("ses_public_switch_exact_available")
        const disabledID = Session.ID.make("ses_public_switch_exact_disabled")
        yield* opencode.sessions.create({
          id: availableID,
          location: Location.Ref.make({ directory: AbsolutePath.make(available.path) }),
        })
        yield* opencode.sessions.create({
          id: disabledID,
          location: Location.Ref.make({ directory: AbsolutePath.make(disabled.path) }),
        })

        yield* opencode.sessions.switchModel({ sessionID: availableID, model: ref({ variant: "default" }) })
        const disabledError = yield* opencode.sessions
          .switchModel({ sessionID: disabledID, model: ref() })
          .pipe(Effect.flip)
        const missingError = yield* opencode.sessions
          .switchModel({ sessionID: disabledID, model: ref({ id: "missing" }) })
          .pipe(Effect.flip)

        expect(disabledError).toBeInstanceOf(Session.ModelUnavailableError)
        expect(missingError).toBeInstanceOf(Session.ModelUnavailableError)
        expect((yield* opencode.sessions.get(availableID)).model).toEqual(ref({ variant: "default" }))
        expect((yield* opencode.sessions.get(disabledID)).model).toBeUndefined()
      } finally {
        yield* Effect.promise(() => Promise.all(dirs.map((d) => d[Symbol.asyncDispose]()))).pipe(Effect.ignore)
      }
    }),
  )

  it.effect("rejects an unavailable variant without changing the Session", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      try {
        yield* writeProvider(tmp.path)
        const opencode = yield* OpenCode.Service
        const sessionID = Session.ID.make("ses_public_switch_variant")
        const selected = ref({ variant: "fast" })
        yield* opencode.sessions.create({
          id: sessionID,
          location: Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }),
        })
        yield* opencode.sessions.switchModel({ sessionID, model: selected })

        const error = yield* opencode.sessions
          .switchModel({ sessionID, model: ref({ variant: "unknown" }) })
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(Session.VariantUnavailableError)
        expect((yield* opencode.sessions.get(sessionID)).model).toEqual(selected)
      } finally {
        yield* Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.ignore)
      }
    }),
  )

  it.effect("preserves the typed not-found error for a missing Session", () =>
    Effect.gen(function* () {
      const opencode = yield* OpenCode.Service
      const sessionID = Session.ID.make("ses_public_switch_missing")
      const error = yield* opencode.sessions
        .switchModel({
          sessionID,
          model: Schema.decodeUnknownSync(Model.Ref)({ id: "claude-sonnet-4-5", providerID: "anthropic" }),
        })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(Session.NotFoundError)
      if (error instanceof Session.NotFoundError) expect(error.sessionID).toBe(sessionID)
    }),
  )
})

const ref = (input: { id?: string; variant?: string } = {}) =>
  Schema.decodeUnknownSync(Model.Ref)({
    id: input.id ?? "chat",
    providerID: "public-test",
    variant: input.variant,
  })

const writeProvider = (directory: string, disabled = false) =>
  Effect.promise(() =>
    fs.writeFile(
      path.join(directory, "opencode.json"),
      JSON.stringify({
        providers: {
          "public-test": {
            name: "Public test",
            api: { type: "native", settings: {} },
            models: {
              chat: {
                disabled,
                variants: [{ id: "fast" }],
              },
            },
          },
        },
      }),
    ),
  )
