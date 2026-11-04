# SQL deployment and runtime privileges

Use separate SQL identities and separate AWS Secrets Manager secrets for database
bootstrap/migration and HTTP request handling. The ASG runtime role must read only
its runtime database secret and application signing secret. Giving EC2 access to
the master secret, even if the process later switches SQL users, leaves master
credentials available to a compromised instance.

## 1. Bootstrap through a controlled deployment identity

Run database creation, migrations, and initial administrator bootstrap from an
explicit deployment job or an authorized administrative session with private RDS
connectivity. Use a fresh database for this schema. The migration runner refuses
to silently adopt the old unversioned tables; existing data needs a reviewed data
migration and restore rehearsal.

Configure the bootstrap process with these nonsecret settings:

- `NODE_ENV=production`, `AWS_REGION=ca-central-1`
- `SECRET_ID`: bootstrap database secret ARN; its JSON contains `username`,
  `password`, `host`, and optional `port`. `DB_HOST` can supply the RDS endpoint
  when using an RDS-managed master secret that does not contain `host`.
- `APP_SECRET_ID`: bootstrap application secret ARN containing `jwtSecret` and
  `bootstrapPassword`. Enter values through a secure secret-management workflow.
- `DB_NAME=ERP_DB`, `CREATE_DATABASE=true`, `AUTO_MIGRATE=true`
- `BOOTSTRAP_ADMIN_EMAIL`: the intended initial administrator's corporate email.
- `DB_CA_BUNDLE`: the trusted RDS CA bundle path where required by deployment.

Do not set `DB_RUNTIME_SECRET_ID` during this stage. From `backend/`, invoke the
bootstrap functions directly without starting the HTTP listener:

```sh
node - <<'NODE'
const { loadConfig, connect } = require('./lib/db');
(async () => {
  const config = await loadConfig();
  const pool = await connect(config);
  await pool.close();
  console.log('Database migration and bootstrap completed');
})().catch(error => {
  console.error('Bootstrap failed:', error.code || error.name);
  process.exitCode = 1;
});
NODE
```

Migrations take an exclusive transaction-owned application lock, checksum all
previously applied files, and commit their schema/version changes atomically.
Never edit an applied migration. Add a new versioned file for each schema change.
For later releases, use the deployment identity to run migration with
`CREATE_DATABASE=false`, without the bootstrap email or bootstrap password.
Production demo seeding is disabled.

## 2. Provision the runtime login and grant table access

Use the database administrator's secure credential-management procedure to create
a dedicated SQL login named `erp_app_login`. Generate its password securely and
store it in the runtime database secret; never put it in committed SQL, shell
history, Terraform input files, command arguments, or logs. The grant script does
not create a login or contain a password placeholder.

Connect to the application database using your administrator session, then execute
[`backend/sql/runtime-grants.sql`](../backend/sql/runtime-grants.sql). The script
creates database user `erp_app` and role `erp_runtime`, and grants only explicit
table permissions. Adjust the two user/login names at its beginning if needed.
The role name itself is fixed. Do not grant the runtime user database ownership,
server privileges, schema ownership, `db_datawriter`, or `db_ddladmin`.

| Data | Runtime SQL permissions |
| --- | --- |
| Tenants, users, sessions, warehouses, catalog, balances, customers, orders, order lines, employees | SELECT, INSERT, UPDATE |
| Stock movements, financial ledger, audit, idempotency records | SELECT, INSERT; UPDATE and DELETE denied |
| Migration history | SELECT only; INSERT, UPDATE and DELETE denied |
| Database objects | No DDL; creation and dbo schema alteration denied |

These database permissions limit the damage of a compromised application process.
API permissions still enforce each user's role and tenant on every request; a
shared database user is not an independent SQL row-level security boundary.
Database administrators retain privileged access and require separate operational
audit controls.

## 3. Start the ASG using only runtime secrets

Set `SECRET_ID` to the dedicated runtime database secret, `AUTO_MIGRATE=false`, and
`CREATE_DATABASE=false`. Unset `BOOTSTRAP_ADMIN_EMAIL` and
`DB_RUNTIME_SECRET_ID`. The runtime `APP_SECRET_ID` must contain the signing key
only; remove `bootstrapPassword` after initial bootstrap. Restrict the EC2 IAM
policy to these runtime secret ARNs and remove master/bootstrap secret access.
Use a separate deployment IAM identity for future migrations.

Do not use `DB_CONFIG_JSON`, a default signing key, or embedded database passwords
in production. `DB_RUNTIME_SECRET_ID` is a compatibility option that switches
pools after initialization; it is not a substitute for separating privileges,
since the first connection still uses `SECRET_ID`.

## 4. Verify access before routing traffic

As the runtime user, verify successful reads and permitted writes in a disposable
staging database. Verify attempts to update/delete posted ledger rows, update
migration history, or create tables fail with SQL permission errors. Run application smoke requests under this restricted identity and check readiness
before routing traffic. Run the separate integration suite with an isolated test
administrator: that suite creates and drops its own random database and therefore
cannot run with the restricted application identity.
The grant script is idempotent for the stated dedicated role; review existing
custom grants and inherited role membership separately. No live RDS grant checks
were performed by generating these files.

Retention jobs for expired sessions/idempotency records use a separate maintenance
identity with explicit deletion permission and an approved retention policy.
Posted finance, stock, and audit data are retained; corrections create new audited
entries instead of deleting history.
