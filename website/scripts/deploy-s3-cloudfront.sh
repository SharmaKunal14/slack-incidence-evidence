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

aws s3 sync out "s3://${S3_BUCKET}" \
  --exclude "_next/static/*" \
  --exclude "*.html" \
  --cache-control "public,max-age=3600"

aws s3 sync out/_next/static "s3://${S3_BUCKET}/_next/static" \
  --cache-control "public,max-age=31536000,immutable"

aws s3 sync out "s3://${S3_BUCKET}" \
  --exclude "*" \
  --include "*.html" \
  --cache-control "no-cache,no-store,must-revalidate"

aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --paths "/*" >/dev/null

echo "Deployment uploaded and CloudFront invalidation requested for ${NEXT_PUBLIC_SITE_URL}."
