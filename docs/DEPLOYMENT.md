# Deployment and rollout

Run these steps in a reviewed AWS account in **ca-central-1**. SQL Server Standard Multi-AZ, dual NAT, ALB, WAF and EC2 incur ongoing charges. This guide does not deploy or migrate the legacy stack automatically.

## 1. Prepare identity, DNS, certificates and state

Use AWS IAM Identity Center or a CI workload identity with a deployment role; do not commit access keys. Confirm the account with `aws sts get-caller-identity`. Terraform needs permission to provision the resources in `terraform/`; the API instance role is provisioned separately with scoped runtime permissions.

Choose an owned origin hostname such as `erp-origin.example.com`. Obtain and DNS-validate an ACM certificate covering that hostname in ca-central-1. The hostname will point to the ALB; CloudFront uses HTTPS to this origin. The browser entry point can initially use the generated CloudFront hostname. A branded browser hostname additionally requires a us-east-1 ACM certificate and CloudFront aliases, which must be added before configuring that hostname.

Create an application secret in AWS Secrets Manager, ca-central-1, using the console secure value editor. JSON keys:

- `jwtSecret`: at least 32 cryptographically random bytes, represented as a long random string.
- `bootstrapPassword`: a unique strong password (12–128 characters) for the initial admin, stored through your approved password management process.

Record only its ARN in Terraform. RDS manages the database master secret and rotation; do not copy its password into tfvars. Use the bootstrap admin to create real users, and retire bootstrap credentials according to your identity policy. Use a separate database runtime identity and migration identity as described in the backend configuration before production operations.

Configure an encrypted remote state backend **before creating resources**, using an independently managed S3 bucket with public access blocked, versioning, KMS encryption and restricted IAM. A backend configuration has the form:

```hcl
terraform {
  backend "s3" {}
}
```

Place that block in an operator-owned `terraform/backend.tf` and supply non-secret bucket/key/region values with `terraform init -backend-config=...`. Use `use_lockfile = true` with a compatible Terraform version. Preserve and securely back up existing state before migration. Never run two state files against the same resources. Terraform state includes the CloudFront origin header secret and must be treated as sensitive.

## 2. Install and validate

```sh
npm ci --prefix backend
npm ci --prefix tooling
npm --prefix backend test
npm --prefix tooling run build
terraform -chdir=terraform init
terraform -chdir=terraform validate
cp terraform/terraform.tfvars.example terraform/deployment.tfvars
```

Edit `deployment.tfvars` with your origin domain, issued origin certificate ARN, Route53 zone ID if applicable, app secret ARN, a real bootstrap admin email, reviewed SQL Server engine version, and deployment parameters. Set `desired_capacity = 0` for initial provisioning. Do not include secret values. Run SQL integration tests separately as described in [SQL testing](SQL_TESTING.md).

## 3. Provision the foundation and upload the release

```sh
terraform -chdir=terraform plan -var-file=deployment.tfvars -out=bootstrap.tfplan
terraform -chdir=terraform apply bootstrap.tfplan
```

Review plans before applying. Initial provisioning creates the VPC, RDS, S3, ALB, CloudFront and ASG with zero instances. Confirm origin DNS points to the `alb_dns_name` output if Route53 management was omitted. Wait for ACM validation and CloudFront propagation.

Use an immutable backend key for every release. The following commands derive names from Terraform outputs and a locally computed digest:

```sh
ERP_REGION=ca-central-1
ERP_BACKEND_BUCKET=$(terraform -chdir=terraform output -raw backend_bucket)
ERP_FRONTEND_BUCKET=$(terraform -chdir=terraform output -raw frontend_bucket)
ERP_SHA=$(cut -d' ' -f1 dist/backend.zip.sha256)
ERP_RELEASE_KEY="releases/$ERP_SHA/backend.zip"
aws s3 cp dist/backend.zip "s3://$ERP_BACKEND_BUCKET/$ERP_RELEASE_KEY" --region "$ERP_REGION"
aws s3 sync dist/frontend/ "s3://$ERP_FRONTEND_BUCKET/" --region "$ERP_REGION" --exclude index.html --cache-control 'public,max-age=300'
aws s3 cp dist/frontend/index.html "s3://$ERP_FRONTEND_BUCKET/index.html" --region "$ERP_REGION" --content-type text/html --cache-control 'no-cache'
```

Do not overwrite a backend release key. The instance downloads exactly that key and verifies its SHA-256 before extracting. Frontend vendor filenames are stable, so the short TTL and deployment invalidation are deliberate; do not mark these stable names immutable.

Update `deployment.tfvars`: set `backend_release_key` to `ERP_RELEASE_KEY`, `backend_release_sha256` to `ERP_SHA`, and `desired_capacity = 2`. For this initial database provisioning only, enable `bootstrap_database = true`. Then:

```sh
terraform -chdir=terraform plan -var-file=deployment.tfvars -out=release.tfplan
terraform -chdir=terraform apply release.tfplan
```

Terraform updates the launch template; the ASG configuration initiates rolling refresh on supported changes. Inspect the refresh before launching another one. New instances install Node, verify the release, install frozen production dependencies, configure the service, and retrieve secrets with their IAM role. Schema initialization is serialized across instances; incompatible schema changes require an explicit migration/rollback plan.

## 4. Restrict the runtime database identity

The bootstrap phase temporarily permits application instances to retrieve the RDS master secret and apply schema migrations. It is a setup phase, not the production steady state.

Using an approved SQL administration connection, create a dedicated application login/user and grant the scoped table permissions in [SQL access](SQL_ACCESS.md). Store its username/password in a separate Secrets Manager secret; keep its password out of terminal history and Git. Set `runtime_db_secret_arn` to that ARN and set `bootstrap_database = false`, then review and apply the plan. Refresh all instances so every process uses the restricted identity. Remove `bootstrapPassword` from the runtime application signing secret after setup. Verify the instance role no longer grants access to the RDS master secret and confirm the application can read/write authorized ERP records but cannot create/drop tables or alter posted ledgers. Perform subsequent migrations as a separate controlled maintenance operation with a migration identity.

## 5. Validate the rollout

Inspect CloudWatch logs, ALB target health and ASG instance refresh status. Request the deployed `/api/health` readiness endpoint and require a connected database. Sign in with the configured initial admin. Select the correct tenant and verify:

1. An operator can record a receipt and create a sales order but cannot edit HR salaries or delete catalog items.
2. An auditor sees redacted employee records and cannot mutate data.
3. A foreign tenant header and foreign item/warehouse IDs are rejected.
4. Receipt and shipment requests create balanced GL journals; insufficient stock rolls back all writes.
5. HTML origin errors produce the diagnostic banner; normal API errors remain JSON.

A `200` from a liveness route proves only process health. Confirm database readiness independently. Run business tests on an isolated test company/database, never against production inventory.

## 6. Subsequent releases and rollback

Repeat the build, tests and immutable S3 upload, then apply the new release key/hash. Update frontend assets and invalidate the distribution:

```sh
ERP_DISTRIBUTION=$(terraform -chdir=terraform output -raw cloudfront_distribution_id)
aws cloudfront create-invalidation --distribution-id "$ERP_DISTRIBUTION" --paths '/*'
ERP_ASG=$(terraform -chdir=terraform output -raw autoscaling_group_name)
aws autoscaling describe-instance-refreshes --auto-scaling-group-name "$ERP_ASG" --region ca-central-1
```

If a manual refresh is required and no refresh is active:

```sh
aws autoscaling start-instance-refresh --auto-scaling-group-name "$ERP_ASG" --region ca-central-1 --preferences '{"MinHealthyPercentage":100,"MaxHealthyPercentage":150,"InstanceWarmup":180}'
```

Rollback by selecting a previous backend object key **and matching checksum**, applying the launch-template change, and restoring the corresponding frontend release. Database migrations must be backward compatible; a code rollback cannot undo destructive schema/data changes. Keep prior artifacts and release manifests. Restore database backups to a new isolated instance first; never experiment on the active production database.

## Troubleshooting

- **HTML instead of JSON:** check CloudFront `/api/*` behavior targets ALB, origin DNS/certificate match, HTTPS-only origin policy, header forwarding, and ALB listener header rules. Never configure an SPA error rewrite for API errors.
- **502:** confirm ALB certificate, origin protocol, target port, security groups and backend process logs.
- **403:** inspect WAF, origin secret header and CloudFront-only ingress; for assets inspect S3 OAC policy and object keys.
- **503/readiness failure:** inspect Secrets Manager permissions, `DB_HOST`, SQL TLS trust, security groups, migration logs and available SQL capacity.
- **Instances fail boot:** inspect cloud-init logs via SSM, release hash/key, package download egress and user-data execution. No SSH ingress is provisioned.
- **RDS failover/secret rotation:** restart or refresh application instances after runtime credential changes if the connection layer has not refreshed credentials; rehearse and automate this for your operational policy.

## Legacy migration

The original configuration and state are retained in `erp-production-tf/`. This release uses new resource addresses and database schema. A fresh apply creates a separate environment. Reuse requires reviewed `terraform import`/`moved` operations, reconciled resource names and a tested data migration. Back up SQL Server and state first; reconcile inventory opening balances with balanced journal entries. The code does not silently convert existing production data or rename resources.
