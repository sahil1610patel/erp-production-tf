# API development and operation

Node.js 24 LTS is required. Install dependencies with `npm ci`, run `npm test` for security and HTTP tests, and `npm run test:integration` for real SQL Server tests. Integration tests require explicit `TEST_DB_CONFIG_JSON`, create a random test database and drop only that database. See [SQL testing](../docs/SQL_TESTING.md).

`server.js` owns startup, bounded connection retries, secret refresh, readiness and graceful shutdown. `lib/app.js` defines REST handlers; `lib/security.js` owns cryptographic and input validation; `lib/transactions.js` implements stock locking, idempotency, balanced journals and audit writes. `lib/migrate.js` applies immutable numbered SQL migrations under a database application lock. Migrations reject the old unversioned schema; use an explicit data migration to adopt legacy production data.

## Configuration

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `production` enables enforced TLS certificate validation and disables local credentials/demo seeding |
| `AWS_REGION` | `ca-central-1` default |
| `SECRET_ID` | SQL secret ARN; JSON `username`, `password`, optional `host`/`port` |
| `DB_HOST`, `DB_PORT`, `DB_NAME` | SQL endpoint, port (1433), database (`ERP_DB`) |
| `APP_SECRET_ID` | Application secret ARN; JSON `jwtSecret` (at least32 bytes), optional bootstrapPassword |
| `DB_CA_BUNDLE` | Trusted RDS CA PEM file |
| `PORT` | HTTP listen port, default5000 |
| `AUTO_MIGRATE` | Set `false` for least-privilege steady-state operation |
| `CREATE_DATABASE` | Set `true` only for authorized bootstrap |
| `BOOTSTRAP_ADMIN_EMAIL` | Enables initial user bootstrap only when configured and no users exist |
| `ENABLE_DEMO_SEED` | Development-only, opt-in `true`; production rejects it |
| `DEMO_PASSWORD` | Operator-provided development password; never included in source or UI |
| `DB_CONFIG_JSON` | Development-only SQL connection JSON using username/password/host/port |
| `JWT_SECRET`, `BOOTSTRAP_PASSWORD` | Local development alternatives when APP_SECRET_ID is absent |
| `DB_TRUST_CERT` | Development-only `true` for local self-signed SQL container certificates |

Do not save secret values in tracked files, command arguments, logs or shell history. Runtime EC2 retrieves Secrets Manager credentials with its instance role. The supported production path uses **only** the runtime SQL secret on API instances and disables migrations/bootstrap. `DB_RUNTIME_SECRET_ID` is an optional compatibility hook that changes the query pool after bootstrap; it does not remove access to bootstrap credentials and should not be used as the production privilege boundary. See [SQL privileges](../docs/SQL_ACCESS.md).

A development-only secret file outside the checkout can be used with Node's `--env-file` flag. Start with `node --env-file=/secure/local/erp.env server.js`. Set `AUTO_MIGRATE=true` and `CREATE_DATABASE=true` only for an isolated developer database whose creation you authorize. Demo seeding creates `admin@demo.erp`, `operator@demo.erp`, and `auditor@demo.erp`; all use the configured DEMO_PASSWORD. Production contains no default shared password.

The process returns `/health` for liveness and `/api/ready` or `/api/health` for SQL readiness. Failed secret access is retried before listening; failed database startup leaves readiness unavailable. Database credentials refresh periodically; active transactions drain before old pools close. Every mutation is tenant-authorized. API tokens are validated against durable sessions, and logout/user-role changes revoke sessions.

See [API reference](../docs/API.md) for endpoints, payloads, role/tenant headers and retry semantics. List endpoints expose bounded recent movement/journal/order windows; use dedicated reporting/export queries for complete historical financial reports rather than interpreting the dashboard window as an all-time ledger.
