# SQL Server integration testing

Use an isolated SQL Server **Developer Edition** instance. Developer Edition is
licensed for development and testing, not production. The integration suite must
never receive a production connection string: it creates test records and changes
stock and financial balances.

## Local test database

Prerequisites: Docker, Node.js 24, npm, Python 3, at least 4 GiB available memory,
and enough disk space for the SQL Server image. The application uses encrypted
SQL connections. A container's self-signed SQL certificate is accepted **only for
these isolated local tests**; production verifies the RDS certificate chain.

From the repository root, create credentials outside the checkout. The following
generates a random password without printing it or placing it in shell history:

```bash
mkdir -p /tmp/nexus-erp-test
chmod 700 /tmp/nexus-erp-test
python3 - <<'PY'
import json, pathlib, secrets
directory = pathlib.Path('/tmp/nexus-erp-test')
password = secrets.token_urlsafe(36) + '!aA9'
environment = directory / 'sql.env'
connection = directory / 'connection.json'
if environment.exists() or connection.exists():
    raise SystemExit('Existing test credentials found; reuse them or choose another directory.')
environment.write_text('ACCEPT_EULA=Y\nMSSQL_PID=Developer\nMSSQL_SA_PASSWORD=' + password + '\n')
connection.write_text(json.dumps({'host': '127.0.0.1', 'port': 14339,
                                 'username': 'sa', 'password': password}))
environment.chmod(0o600)
connection.chmod(0o600)
PY
docker pull mcr.microsoft.com/mssql/server:2022-CU22-ubuntu-22.04
docker run -d --name nexus-erp-sql-test --memory=4g \
  --env-file /tmp/nexus-erp-test/sql.env \
  -p 127.0.0.1:14339:1433 \
  mcr.microsoft.com/mssql/server:2022-CU22-ubuntu-22.04
docker logs nexus-erp-sql-test
```

Wait until SQL Server reports that it is ready for client connections. Container
startup alone is not a database readiness check. Record and pin the image digest
in your organization's test infrastructure when adopting this recipe.

In Codex managed environments, use the configured local Docker daemon and preserve
the network proxy and certificate trust. The registry download may redirect from
`mcr.microsoft.com` to `centralus.data.mcr.microsoft.com`; both need to be allowed
in environment network settings. A saved settings draft does not apply a runtime
network policy change. Retry after the approved settings have been applied.

## Run checks

```bash
cd backend
npm ci
npm test
node - <<'JS'
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const result = spawnSync('npm', ['run', 'test:integration'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TEST_DB_CONFIG_JSON: fs.readFileSync('/tmp/nexus-erp-test/connection.json', 'utf8'),
    DB_TRUST_CERT: 'true',
    NODE_ENV: 'test'
  }
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
JS
```

Inspect the runner's passed, failed, and skipped counts. Tests requiring SQL
Server skip when their connection configuration is absent; a skipped suite does
not validate transaction behavior. Keep the random local credentials out of
version control, application logs, screenshots, and shared test reports.

When finished, remove only the container and credential directory created above:

```bash
docker rm -f nexus-erp-sql-test
rm /tmp/nexus-erp-test/sql.env /tmp/nexus-erp-test/connection.json
rmdir /tmp/nexus-erp-test
```

## Validation status in the implementation environment

The local Docker daemon was reachable. The SQL Server image pull was blocked by
the network policy at the registry's download hostname. No SQL Server container
was started and no live SQL integration test passed at that stage. The required
domain addition was saved in the environment draft; it requires a runtime settings
update before the database-backed checks can execute. Do not interpret unit-test
success or Terraform validation as evidence of SQL transaction correctness.

## Continuous integration

The `sql-integration` job in `.github/workflows/verify.yml` starts the pinned
SQL Server 2022 CU22 Developer image on a GitHub-hosted runner. It creates a fresh
random SA password in runner-temporary files, verifies SQL readiness with an
actual query, then supplies `TEST_DB_CONFIG_JSON` to the integration runner. The
suite creates a randomly named database and removes only that database in its
cleanup. The job removes its container and credential files even after failures.
No production credentials or GitHub repository secrets are needed.

The suite checks tenant headers and cross-tenant foreign keys, RBAC, idempotent
receipts, concurrent oversell prevention, balanced journals, complete transaction
rollback, HR salary redaction, sales reservation/fulfillment, and session logout.
The CI definition is committed configuration, not evidence that a GitHub Actions
run has completed. Inspect the actual job result before accepting a release.

A repeat check during final implementation found that the download domain was
still absent from the current environment's reported policy. The integration
runner was executed without database configuration and explicitly reported
**0 passed, 1 skipped**. This is an unrun database suite, not a passing SQL check.
