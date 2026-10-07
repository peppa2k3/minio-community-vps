#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo 'Usage: scripts/onboard-backend.sh APP_NAME BUCKET [QUOTA, e.g. 20GB]' >&2
  exit 2
fi
command -v mc >/dev/null || { echo 'Install MinIO mc first.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Install Python 3 first.' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'Install openssl first.' >&2; exit 1; }

app_name=$1
bucket=$2
quota=${3:-}
[[ $app_name =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo 'APP_NAME: 2-31 lowercase letters/digits/hyphens, starts with letter.' >&2; exit 2; }
[[ $bucket =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || { echo 'Invalid S3 bucket name.' >&2; exit 2; }
if [[ -n $quota && ! $quota =~ ^[1-9][0-9]*(MB|GB|TB)$ ]]; then
  echo 'Quota must look like 20GB.' >&2; exit 2
fi

alias_name=${MC_ALIAS:-minio-vps}
access_key="app-${app_name}"
policy_name="bucket-${app_name}"
secret_key=$(openssl rand -hex 32)
tmp_policy=$(mktemp)
trap 'rm -f "$tmp_policy"' EXIT
python3 - "$bucket" "$(dirname "$0")/../policies/backend-bucket.template.json" "$tmp_policy" <<'PY'
import json, sys
bucket, template, output = sys.argv[1:]
with open(template, encoding='utf-8') as f:
    doc = json.load(f)
for statement in doc['Statement']:
    statement['Resource'] = [r.replace('__BUCKET__', bucket) for r in statement['Resource']]
with open(output, 'w', encoding='utf-8') as f:
    json.dump(doc, f, indent=2)
PY

# Không xoá hay thay thế user cũ: tránh đổi secret ngoài ý muốn.
if mc admin user info "$alias_name" "$access_key" >/dev/null 2>&1; then
  echo "User $access_key already exists; choose another APP_NAME or manage rotation manually." >&2
  exit 1
fi

mc mb --ignore-existing "$alias_name/$bucket"
mc admin policy create "$alias_name" "$policy_name" "$tmp_policy"
mc admin user add "$alias_name" "$access_key" "$secret_key"
mc admin policy attach "$alias_name" "$policy_name" --user "$access_key"
if [[ -n $quota ]]; then mc admin bucket quota "$alias_name/$bucket" --hard "$quota"; fi

cat <<EOF
Created user: $access_key
Bucket: $bucket
Policy: $policy_name
S3_ACCESS_KEY=$access_key
S3_SECRET_KEY=$secret_key
Save the secret now in the backend's private env/secret manager; it cannot be retrieved later.
EOF
