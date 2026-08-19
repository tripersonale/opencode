# OpenCode + PostgreSQL

**This is a fork**, not the official OpenCode app.

Upstream: [anomalyco/opencode](https://github.com/anomalyco/opencode) — *the open source AI coding agent*.

The real reason for this fork is **multi-access**: more than one client talking to the same OpenCode store at once. First came the Telegram bot. Then other surfaces (web UI, more bots, more hosts) had to share those sessions. SQLite is a single-writer file. PostgreSQL is the store that lets them coexist.

TRiPersonale runs this fork in production.

If you just want OpenCode on your laptop, install the official project: [opencode.ai](https://opencode.ai).

## Why the fork exists

Upstream OpenCode is a local agent with a SQLite store. That is fine for one UI on one machine. It is not fine when a Telegram bot and a browser (and later more clients) must read and write the same sessions.

That is the fork: same product, one database, many accessors.

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
