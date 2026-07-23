#!/usr/bin/env bash
set -euo pipefail

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

require_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Required environment variable is not set: $name" >&2
    exit 1
  fi
}

require_command aws
require_command npm
require_value S3_BUCKET
require_value CLOUDFRONT_DISTRIBUTION_ID
require_value SITE_URL

if [[ ! "$S3_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; then
  echo "S3_BUCKET is not a valid bucket name." >&2
  exit 1
fi

if [[ ! "$CLOUDFRONT_DISTRIBUTION_ID" =~ ^[A-Z0-9]+$ ]]; then
  echo "CLOUDFRONT_DISTRIBUTION_ID is invalid." >&2
  exit 1
fi

if [[ ! "$SITE_URL" =~ ^https://[^/]+/?$ ]]; then
  echo "SITE_URL must be an HTTPS origin without a path." >&2
  exit 1
fi

export NEXT_PUBLIC_SITE_URL="${SITE_URL%/}"

aws sts get-caller-identity >/dev/null
npm run build:s3
bash scripts/upload-s3-cloudfront.sh

echo "Deployment completed for ${NEXT_PUBLIC_SITE_URL}."
