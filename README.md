# OpenCode + PostgreSQL

**This is a fork**, not the official OpenCode app.

Upstream: [anomalyco/opencode](https://github.com/anomalyco/opencode) — *the open source AI coding agent*.

We keep a PostgreSQL backend so a shared server can hold thousands of sessions without parking them in a local SQLite file. TRiPersonale runs this fork in production.

If you just want OpenCode on your laptop, install the official project: [opencode.ai](https://opencode.ai).

## Why the fork exists

OpenCode upstream is excellent as a local agent. Its default store is SQLite. That breaks down when:

- several people hit the same server
- sessions must survive host rebuilds
- you already operate PostgreSQL and want one backup path

This repository is that missing piece: same product, durable SQL.

## What we add

| Piece | Role |
| --- | --- |
| `OPENCODE_DATABASE_DIALECT=postgres` | Select the PG adapter |
| `OPENCODE_DATABASE_URL=postgresql://…` | Connection string |
| Drizzle adapter | Same `.get()` / `.all()` / `.run()` API as SQLite |
| Event store | Unique `(aggregate_id, seq)` plus `SELECT … FOR UPDATE` so concurrent writers do not collide |

SQLite still works. Postgres is opt-in.

## Branches

| Branch | Meaning |
| --- | --- |
| `fork-dev` | Tracks `upstream/production` + our PG work. Test here. |
| `fork-stable` | What we deploy after trip-dev is green. |
| `dev` / `production` | Upstream mirrors. Do not treat them as this fork. |

Stable marker: tag `trip-stable-YYYY-MM-DD`.

## Run with PostgreSQL

```bash
git clone https://github.com/tripersonale/opencode-postgresql.git
cd opencode-postgresql
bun install

export OPENCODE_DATABASE_DIALECT=postgres
export OPENCODE_DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/opencode'
bun run packages/opencode/src/index.ts web --port 4097
```

PostgreSQL 16+ (we use 18). The app user needs rights on `session`, `message`, `part`, `event`, `event_sequence`.

## Status

- Public fork of `anomalyco/opencode`
- Maintained by [TRiPersonale](https://github.com/tripersonale)
- Not affiliated with the OpenCode team
- We merge upstream; we do not replace it

## License

Same as upstream. See [LICENSE](./LICENSE).

## Upstream docs

Agents, desktop app, and official installers live on [opencode.ai/docs](https://opencode.ai/docs).
