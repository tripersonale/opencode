export * as ConfigDatabase from "./database"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("ConfigV2.Database")({
  dialect: Schema.Union([Schema.Literal("sqlite"), Schema.Literal("postgres"), Schema.Literal("mysql")])
    .pipe(Schema.optional)
    .annotate({
      description: "Database dialect: sqlite, postgres, or mysql. Defaults to sqlite.",
    }),
  url: Schema.String.pipe(Schema.optional).annotate({
    description: "Connection URL for postgres or mysql dialect.",
  }),
  sqlite_filename: Schema.String.pipe(Schema.optional).annotate({
    description: "SQLite database filename. Defaults to opencode.db in the data directory.",
  }),
}) {}
