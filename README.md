# Nexus Enterprise ERP

An AWS Canada Central ERP implementation with tenant-scoped inventory, warehouse movements, double-entry journals, sales, customers, payroll directory, and audit history. The application uses Express, SQL Server, React 18 and Terraform.

This repository contains deployable code and automated checks, not a certification of production readiness. Validate it in a non-production AWS account, review the controls and operational prerequisites below, and complete load, recovery, and penetration testing before a production launch.

## Layout

```text
terraform/            AWS infrastructure, variables, outputs and security
backend/              API, authentication, database migrations and tests
frontend/index.html   React SPA source; runtime Babel supported for development
tooling/              Pinned React, Babel and Tailwind build dependencies
scripts/              Release packaging and verification
docs/                 Deployment and operational guidance
erp-production-tf/    Original implementation and existing state; legacy reference
```

Use the root-level implementation for new deployments. The original nested directory is retained to preserve the existing infrastructure state and migration reference. **Do not apply both configurations to the same infrastructure.** Existing tracked state can contain database credentials. Restrict repository access, rotate exposed credentials, and handle history cleanup and state migration as a coordinated operation. `.gitignore` prevents new state files from being added; it cannot remove state from Git history.

## Development

Use Node.js 24 LTS, Terraform 1.14.5, Python 3 and `zip`. Dependencies are committed through npm lockfiles and the Terraform provider lockfile.

```sh
npm ci --prefix backend
npm ci --prefix tooling
npm --prefix backend test
npm --prefix tooling run build
terraform -chdir=terraform init -backend=false
terraform -chdir=terraform validate
```

Run the complete local verification with `PATH=/workspace/setup/bin:$PATH bash scripts/verify.sh`. The generated release lives in `dist/`.

See [deployment](docs/DEPLOYMENT.md) for database setup, secure secrets, AWS rollout and rollback. See [architecture and controls](docs/ARCHITECTURE.md) for boundaries and operational limitations. Test results from this coding session are recorded in [validation](docs/VALIDATION.md).

The source SPA uses React 18 with Babel Standalone. The release builder compiles JSX ahead of time, generates Tailwind CSS, and bundles local pinned React scripts. Deployed pages make no third-party CDN calls and do not require `unsafe-eval`. This retains the single HTML application source while avoiding a runtime compiler in production.

## Roles and tenant scope

| Capability | ADMIN | OPERATOR | AUDITOR |
| --- | --- | --- | --- |
| Tenant selection | All tenants | Own tenant | Own tenant |
| Catalog management | Write | Read | Read |
| Stock movements | Write | Write | Read |
| Sales orders | Write | Create / fulfill | Read |
| Financial journals | Post / read | Read | Read |
| HR compensation | Write / read | Redacted | Redacted |
| Audit trail | Read | Read | Read |

Every authenticated API request carries `Authorization: Bearer …` and `X-Tenant-Id`. A role switcher on the login page selects an account, never grants a role. Demo identities are development-only; production requires provisioned users and secure credentials. Financial postings and stock ledgers are durable records: corrections use compensating entries rather than destructive edits.

## Deployment boundary

The HTTPS edge is public; application instances and SQL Server are private. CloudFront sends API traffic to an ALB over TLS and static traffic to S3 using Origin Access Control. This is an edge/private workload architecture. No corporate on-premises VPN or Direct Connect circuit is provisioned; add those explicitly when connecting an existing corporate network.

No AWS infrastructure is created by repository tests or release packaging. `terraform plan/apply`, uploading releases, and instance refreshes are explicit operator actions documented in the deployment guide.
