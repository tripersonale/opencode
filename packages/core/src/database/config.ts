export * as DatabaseConfig from "./config"

import * as Effect from "effect/Effect"
import * as Global from "../global"
import * as InstallationChannel from "../installation/version"
import { isAbsolute, join } from "path"
import type { Dialect } from "./dialect"
import * as DialectModule from "./dialect"

export interface Config {
  readonly dialect: Dialect
  readonly sqliteFilename: string
  readonly postgresUrl?: string
  readonly mysqlUrl?: string
}

export function sqliteDefaultPath() {
  const flag = process.env.OPENCODE_DB
  if (flag) {
    if (flag === ":memory:" || isAbsolute(flag)) return flag
    return join(Global.Path.data, flag)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel.InstallationChannel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "opencode.db")
  return join(
    Global.Path.data,
    `opencode-${InstallationChannel.InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`,
  )
}

export function load(): Config {
  const dialect = DialectModule.detect()

  if (dialect === "postgres") {
    const url = process.env.OPENCODE_DATABASE_URL
    if (!url) {
      throw new Error(
        "OPENCODE_DATABASE_DIALECT=postgres requires OPENCODE_DATABASE_URL to be set",
      )
    }
    return { dialect, sqliteFilename: sqliteDefaultPath(), postgresUrl: url }
  }

  if (dialect === "mysql") {
    const url = process.env.OPENCODE_DATABASE_URL
    if (!url) {
      throw new Error(
        "OPENCODE_DATABASE_DIALECT=mysql requires OPENCODE_DATABASE_URL to be set",
      )
    }
    return { dialect, sqliteFilename: sqliteDefaultPath(), mysqlUrl: url }
  }

  return { dialect, sqliteFilename: sqliteDefaultPath() }
}

export const loadEffect = Effect.sync(load)
