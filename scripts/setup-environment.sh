#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ERP_SETUP=/workspace/setup
mkdir -p "$ERP_SETUP/bin" "$ERP_SETUP/downloads"
if ! "$ERP_SETUP/bin/terraform" version -json 2>/dev/null | python3 -c 'import json,sys; assert json.load(sys.stdin)["terraform_version"] == "1.14.5"' 2>/dev/null; then
  curl -fsS https://releases.hashicorp.com/terraform/1.14.5/terraform_1.14.5_linux_amd64.zip -o "$ERP_SETUP/downloads/terraform.zip"
  curl -fsS https://releases.hashicorp.com/terraform/1.14.5/terraform_1.14.5_SHA256SUMS -o "$ERP_SETUP/downloads/SHA256SUMS"
  python3 - <<'PY'
import hashlib,pathlib,zipfile
p=pathlib.Path('/workspace/setup/downloads')
expected=next(line.split()[0] for line in (p/'SHA256SUMS').read_text().splitlines() if line.endswith('terraform_1.14.5_linux_amd64.zip'))
assert hashlib.sha256((p/'terraform.zip').read_bytes()).hexdigest() == expected
zipfile.ZipFile(p/'terraform.zip').extract('terraform','/workspace/setup/bin')
PY
  chmod +x "$ERP_SETUP/bin/terraform"
fi
export PATH="$ERP_SETUP/bin:$PATH"
npm ci --prefix backend --no-audit --no-fund
npm ci --prefix tooling --no-audit --no-fund
npm --prefix tooling run build
terraform -chdir=terraform init -backend=false -input=false -lockfile=readonly
terraform -chdir=terraform validate -no-color
