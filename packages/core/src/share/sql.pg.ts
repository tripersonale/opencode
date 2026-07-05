import { pgTable, text } from "drizzle-orm/pg-core"
import { SessionTable } from "../session/sql.pg"
import { Timestamps } from "../database/schema.sql.pg"

export const SessionShareTable = pgTable("session_share", {
  session_id: text()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  id: text().notNull(),
  secret: text().notNull(),
  url: text().notNull(),
  ...Timestamps,
})
