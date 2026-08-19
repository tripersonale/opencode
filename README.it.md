# OpenCode + PostgreSQL

**Questo è un fork**, non l’app ufficiale OpenCode.

Upstream: [anomalyco/opencode](https://github.com/anomalyco/opencode) — *l’agente di coding AI open source*.

Il motivo vero del fork è il **multi-accesso**: più client sullo stesso store OpenCode. Prima il bot Telegram. Poi altre superfici (web UI, altri bot, altri host) dovevano condividere quelle sessioni. SQLite è un file a un solo writer. PostgreSQL è il deposito che li fa convivere.

TRiPersonale lo usa in produzione.

Se ti serve OpenCode sul portatile, installa il progetto ufficiale: [opencode.ai](https://opencode.ai).

## Perché esiste il fork

OpenCode upstream è un agente locale con store SQLite. Va bene per una UI su una macchina. Non va bene quando un bot Telegram e un browser (e poi altri client) devono leggere e scrivere le stesse sessioni.

Questo è il fork: stesso prodotto, un database, tanti accessi.

## Cosa aggiungiamo

| Pezzo | Ruolo |
| --- | --- |
| `OPENCODE_DATABASE_DIALECT=postgres` | Attiva l’adapter PG |
| `OPENCODE_DATABASE_URL=postgresql://…` | Stringa di connessione |
| Adapter Drizzle | Stessa API `.get()` / `.all()` / `.run()` di SQLite |
| Event store | Unique `(aggregate_id, seq)` e `SELECT … FOR UPDATE` così i writer concorrenti non si pestano |

SQLite resta disponibile. Postgres è opt-in.

## Branch

| Branch | Significato |
| --- | --- |
| `fork-dev` | Segue `upstream/production` + il lavoro PG. Si testa qui. |
| `fork-stable` | Quello che deployamo dopo trip-dev verde. |
| `dev` / `production` | Specchi upstream. Non sono questo fork. |

Marcatore stabile: tag `trip-stable-YYYY-MM-DD`.

## Avvio con PostgreSQL

```bash
git clone https://github.com/tripersonale/opencode-postgresql.git
cd opencode-postgresql
bun install

export OPENCODE_DATABASE_DIALECT=postgres
export OPENCODE_DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/opencode'
bun run packages/opencode/src/index.ts web --port 4097
```

PostgreSQL 16+ (noi usiamo 18). L’utente app deve poter scrivere su `session`, `message`, `part`, `event`, `event_sequence`.

## Stato

- Fork pubblico di `anomalyco/opencode`
- Manutenzione [TRiPersonale](https://github.com/tripersonale)
- Nessuna affiliazione con il team OpenCode
- Facciamo merge da upstream; non lo sostituiamo

## Licenza

Come upstream. Vedi [LICENSE](./LICENSE).

## Documentazione upstream

Agenti, app desktop e installer ufficiali: [opencode.ai/docs](https://opencode.ai/docs).
