# Database Backends

OpenCode supports SQLite (default) and PostgreSQL, with MySQL as a stub.

## Dialects

| Dialect | Status | Driver |
|---------|--------|--------|
| `sqlite` | Default, fully supported | `@effect/sql-sqlite-bun` |
| `postgres` | Fully supported, requires URL | `@effect/sql-pg` |
| `mysql` | Not implemented (returns `Effect.die`) | — |

## Configuration

Database dialect is selected via environment variable:

```bash
# SQLite (default)
unset OPENCODE_DATABASE_DIALECT

# PostgreSQL
export OPENCODE_DATABASE_DIALECT=postgres
export OPENCODE_DATABASE_URL='postgresql://user:pass@host:5432/dbname'

# MySQL (will fail with not-implemented error)
export OPENCODE_DATABASE_DIALECT=mysql
export OPENCODE_DATABASE_URL='mysql://user:pass@host:3306/dbname'
```

The URL is wrapped in `Redacted<string>` immediately after reading from the environment to avoid accidental leaks in logs, errors, or exports.

## DatabaseAdapter

The adapter pattern provides a uniform surface over Drizzle for both SQLite and PostgreSQL:

```typescript
import { makePostgresAdapter, makeSqliteAdapter } from "@opencode-ai/core/database/adapter"

// SQLite — adapter is a no-op identity wrapper
const sqliteDb = makeSqliteAdapter(sqliteDrizzleDb)

// PostgreSQL — adapter adds run/all/get helpers and BIGINT normalization
const pgDb = makePostgresAdapter(pgDrizzleDb)
```

### Behavior

- **SQLite**: adapter is identity, no transformation
- **PostgreSQL**: adapter wraps the Drizzle PG database in a Proxy that:
  - Exposes `run(query)`, `all<T>(query)`, `get<T>(query)` for raw SQL
  - Patches query builders to add the same `.run()`, `.all()`, `.get()` helpers
  - Wraps transactions to expose the same surface on the `tx` object
  - Normalizes BIGINT numeric fields (returned as strings by pg) to JS `number` for fields in the canonical OpenCode schema, plus any column whose value matches `/^-?\d+$/`
- **MySQL**: stub Proxy returns `Effect.die` for every operation

### Transactions

Transactions work identically on both dialects:

```typescript
yield* db.transaction((tx) =>
  Effect.gen(function* () {
    yield* tx.run(sql`INSERT INTO ...`)
    const rows = yield* tx.all<MyType>(sql`SELECT ...`)
  })
)
```

Rollback happens automatically if the Effect fails inside the transaction callback.

## Tests

| File | Coverage |
|------|----------|
| `test/database-adapter.test.ts` | SQLite adapter unit |
| `test/database-adapter-pg.test.ts` | PostgreSQL adapter (BIGINT, tx rollback, query builders) |
| `test/database-migration.test.ts` | Migration application under both dialects |
| `test/mysql-stub.test.ts` | MySQL not-implemented error |

Run tests:

```bash
# SQLite
bun test packages/core/test/database-adapter.test.ts

# PostgreSQL
OPENCODE_DATABASE_DIALECT=postgres \
OPENCODE_DATABASE_URL='postgresql://...' \
  bun test packages/core/test/database-adapter-pg.test.ts
```

## Compliance

- **V30 (ACN Crypto)**: URL values are wrapped in `Redacted<string>` and passed through `PgClient.layer({ url: Redacted.make(url) })`. Never logged, never serialized in plain form.
- **V31 (Post-quantum)**: TLS is delegated to the underlying driver. OpenCode does not terminate TLS itself; document TLS version requirements at deployment.
- **V32 (CER armatura)**: Stub dialects fail fast. No silent fallbacks that could compromise supply-chain visibility.
- **V33 (Dato come asset)**: Connection URL contains credentials. Treat `.env` files containing `OPENCODE_DATABASE_URL` as secrets — do not commit.

## Known Limitations

- MySQL is a stub. Selecting `OPENCODE_DATABASE_DIALECT=mysql` will fail with `Effect.die("OPENCODE_DATABASE_DIALECT=mysql is not implemented")`.
- The Proxy adapter adds runtime overhead. For high-throughput paths, prefer the raw Drizzle API.
- BIGINT normalization is heuristic (regex on string values). If a column legitimately contains a string like `"01"` or `"+42"`, it will be converted to a number.
