export * as ConfigDatabase from "./database"

import { Schema } from "effect"

const Dialect = Schema.Union([
  Schema.Literal("sqlite"),
  Schema.Literal("postgres"),
  Schema.Literal("mysql"),
])

export const MirrorConfig = Schema.Struct({
  url: Schema.String,
  batch_interval_ms: Schema.optional(Schema.Number),
  queue_path: Schema.optional(Schema.String),
  max_queue_size: Schema.optional(Schema.Number),
  drop_on_pg_error: Schema.optional(Schema.Boolean),
})

export const ArchiveConfig = Schema.Struct({
  url: Schema.String,
  older_than_days: Schema.optional(Schema.Number),
  interval_ms: Schema.optional(Schema.Number),
  archive_messages: Schema.optional(Schema.Boolean),
})

export class Info extends Schema.Class<Info>("ConfigV2.Database")({
  dialect: Schema.optional(Dialect),
  url: Schema.optional(Schema.String),
  sqlite_filename: Schema.optional(Schema.String),
  mirror: Schema.optional(MirrorConfig),
  archive: Schema.optional(ArchiveConfig),
}) {}
