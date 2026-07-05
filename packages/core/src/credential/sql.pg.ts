import { integer, pgTable, text, boolean, jsonb } from "drizzle-orm/pg-core"
import { Timestamps } from "../database/schema.sql.pg"
import type { IntegrationSchema } from "../integration/schema"
import type { Credential } from "../credential"

export const CredentialTable = pgTable("credential", {
  id: text().$type<Credential.ID>().primaryKey(),
  integration_id: text().$type<IntegrationSchema.ID>(),
  label: text().notNull(),
  value: jsonb().$type<Credential.Info>().notNull(),
  connector_id: text(),
  method_id: text(),
  active: boolean(),
  ...Timestamps,
})
