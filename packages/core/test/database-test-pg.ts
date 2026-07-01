import { Redacted } from "effect"
import * as PgClient from "@effect/sql-pg/PgClient"
import { Layer } from "effect"

/**
 * Canonical PostgreSQL URL for core package tests.
 *
 * Rules:
 * 1. NEVER fall back to the production database URL.
 * 2. NEVER default to a URL that points at the `opencode` production DB.
 * 3. Use OPENCODE_TEST_DATABASE_URL when provided (CI, local test runners).
 * 4. Default to a dedicated test DB on the local PostgreSQL superuser account.
 *
 * This prevents tests from accidentally touching production data when
 * OPENCODE_DATABASE_URL is set in the environment (e.g. on tripepic).
 */
export const TEST_POSTGRES_URL =
  process.env.OPENCODE_TEST_DATABASE_URL ?? "postgresql://postgres@localhost:5432/opencode_core_test"

export const testPgClientLayer = PgClient.layer({
  url: Redacted.make(TEST_POSTGRES_URL),
}).pipe(Layer.orDie)
