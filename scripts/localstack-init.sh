#!/bin/sh
set -eu

REGION="${AWS_DEFAULT_REGION:-ap-southeast-2}"
DLQ_NAME="incident-review-requests-dlq.fifo"
QUEUE_NAME="incident-review-requests.fifo"

awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name "$DLQ_NAME" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

DLQ_URL="$(awslocal sqs get-queue-url --region "$REGION" --queue-name "$DLQ_NAME" --query QueueUrl --output text)"
DLQ_ARN="$(awslocal sqs get-queue-attributes --region "$REGION" --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)"

awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name "$QUEUE_NAME" \
  --attributes "FifoQueue=true,ContentBasedDeduplication=false,VisibilityTimeout=120,RedrivePolicy={\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"5\"}"
