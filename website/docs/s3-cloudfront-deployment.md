# Deploy OnRecord with private S3 and CloudFront

This setup serves a static export from a private S3 bucket through CloudFront.
Do not enable S3 website hosting and do not make the bucket public. CloudFront
Origin Access Control (OAC) is the only public read path.

## Resulting architecture

```text
Visitor -> DNS -> CloudFront (TLS, cache, security headers)
                      |
                      +-> CloudFront Function (clean URL rewrite)
                      |
                      +-> private S3 bucket through OAC
```

## Prerequisites

- An AWS account and permission to manage S3, CloudFront, ACM, and DNS.
- AWS CLI v2 authenticated to the intended account for repeat deployments.
- Node.js `>=22.13.0` and the website dependencies installed.
- A dedicated custom hostname, for example `onrecord.example.com`.

Use a dedicated bucket for this site. The deployment script does not delete
objects, which avoids accidentally erasing unrelated bucket content. Old
fingerprinted build assets may therefore remain and can be removed later after
reviewing the exact keys.

## 1. Build and inspect the static export

From the `website` directory:

```bash
npm install
NEXT_PUBLIC_SITE_URL=https://onrecord.example.com npm run test:s3
```

The deployable artifact is `out/`. Test it through an HTTP server rather than
opening `index.html` directly because browser module loading expects HTTP:

```bash
npx serve out
```

Check the landing page, video playback, `review-demo/demo.html`, and `/demo/`.

## 2. Create the private S3 bucket

In **S3 -> Create bucket**:

1. Choose a globally unique name such as `onrecord-public-site-prod`.
2. Choose the AWS Region closest to the operator; CloudFront is global.
3. Keep **Block all public access** enabled.
4. Keep **Object Ownership: Bucket owner enforced**.
5. Enable bucket versioning for easier recovery from a bad upload.
6. Keep default server-side encryption enabled.
7. Create the bucket. Do not enable **Static website hosting**.

No credentials, API keys, Slack tokens, or backend configuration belong in
this bucket or in `NEXT_PUBLIC_*` variables. Everything in `out/` is public.

## 3. Request the TLS certificate

CloudFront only accepts ACM certificates from **US East (N. Virginia),
`us-east-1`**, regardless of the S3 bucket Region.

1. Switch the AWS Console Region to **us-east-1**.
2. Open **AWS Certificate Manager -> Request certificate**.
3. Request a public certificate for the exact hostname, such as
   `onrecord.example.com`.
4. Choose DNS validation.
5. Add the generated ACM CNAME validation record at the DNS provider.
6. Wait until ACM reports **Issued**.

Keep the validation CNAME in DNS so ACM can renew the certificate.

## 4. Create the CloudFront distribution

In **CloudFront -> Create distribution**:

1. Select the S3 bucket as the origin. Use the regular S3 bucket endpoint, not
   the website endpoint.
2. Create an **Origin Access Control** with signed requests enabled and attach
   it to the origin.
3. Allow CloudFront to update the S3 bucket policy, or apply the least-privilege
   policy in the next section.
4. Set **Viewer protocol policy** to **Redirect HTTP to HTTPS**.
5. Allow only `GET` and `HEAD` viewer methods.
6. Enable automatic compression.
7. Use the managed **CachingOptimized** cache policy.
8. Attach the managed **SecurityHeadersPolicy** response headers policy.
9. Set **Default root object** to `index.html`.
10. Add the custom hostname as an alternate domain name.
11. Select the ACM certificate issued in `us-east-1`.
12. Enable HTTP/2 and HTTP/3. Enable IPv6 unless the network policy forbids it.
13. Create the distribution and wait for it to finish deploying.

Record the distribution ID and its hostname, such as
`d111111abcdef8.cloudfront.net`.

### Least-privilege bucket policy

Replace the placeholders and attach this policy to the S3 bucket. It grants
only this CloudFront distribution permission to read objects:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontReadOnly",
      "Effect": "Allow",
      "Principal": {
        "Service": "cloudfront.amazonaws.com"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::BUCKET_NAME/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::AWS_ACCOUNT_ID:distribution/DISTRIBUTION_ID"
        }
      }
    }
  ]
}
```

Do not add public principals or `s3:*` permissions.

## 5. Add the clean-URL function

S3 stores the static `/demo/` route as `demo/index.html`. CloudFront needs a
small viewer-request rewrite so both `/demo` and `/demo/` work.

1. Open **CloudFront -> Functions -> Create function**.
2. Name it `onrecord-clean-urls` and create it.
3. Paste the contents of `infrastructure/cloudfront-url-rewrite.js`.
4. Save changes, test `/`, `/demo`, `/demo/`, and an asset path, then publish.
5. Open the distribution's default behavior and associate this function with
   the **Viewer request** event.
6. Save and wait for the distribution update to deploy.

The function appends `index.html` only to directory or extensionless paths. It
does not rewrite assets such as JavaScript, CSS, images, captions, or video.

## 6. Upload the first release

The included deployment script validates its inputs, confirms AWS credentials,
builds the site, uploads files with appropriate cache policies, and invalidates
CloudFront.

```bash
export S3_BUCKET=onrecord-public-site-prod
export CLOUDFRONT_DISTRIBUTION_ID=E1234567890ABC
export SITE_URL=https://onrecord.example.com
npm run deploy:s3
```

It applies:

- one-year immutable caching to fingerprinted `/_next/static/` assets;
- one-hour caching to stable media and other public assets;
- no browser caching to HTML; and
- a CloudFront invalidation after upload.

For CI, use short-lived OIDC credentials and a dedicated deployment role. Do
not create long-lived AWS access keys in the repository or CI variables.

## 7. Point the custom subdomain to CloudFront

Do this only after CloudFront reports that the distribution is deployed and the
custom hostname is attached.

### Route 53

Create these records in the hosted zone:

| Type         | Name       | Target                                      |
| ------------ | ---------- | ------------------------------------------- |
| `A` Alias    | `onrecord` | The CloudFront distribution                 |
| `AAAA` Alias | `onrecord` | The same distribution, when IPv6 is enabled |

Set **Evaluate target health** to **No**.

### Another DNS provider

Create a CNAME for the subdomain:

| Type    | Name       | Value                           |
| ------- | ---------- | ------------------------------- |
| `CNAME` | `onrecord` | `d111111abcdef8.cloudfront.net` |

The ACM validation CNAME is separate and should remain in DNS. Do not point the
hostname directly at the S3 bucket.

## 8. Verify production

After DNS resolves, verify:

```bash
curl -I https://onrecord.example.com/
curl -I https://onrecord.example.com/demo
curl -I https://onrecord.example.com/review-demo/demo.html
curl -I https://onrecord.example.com/video/onrecord-workflow-90s.mp4
```

Expected results:

- HTTP redirects end on HTTPS.
- `/`, `/demo`, and the review demo return successful HTML responses.
- `Cache-Control` is short/no-cache for HTML and long-lived for fingerprinted
  assets.
- Security headers are present.
- A byte-range request to the MP4 succeeds so seeking works.
- The S3 object URL is not publicly readable.

Also test keyboard navigation, mobile layout, video captions, the synthetic
review workflow, and social-card rendering on the final hostname.

## 9. Routine releases and rollback

After the CI/CD configuration below is complete, merge website changes into
`main`. Pull requests run linting and the static-export tests. A push to `main`
uploads that same verified artifact, waits for CloudFront invalidation, and
smoke-tests the public domain. Manual production runs are restricted to
`main` as well.

For an exceptional local release, run the same three exported variables and
`npm run deploy:s3`. The command creates a fresh static export, uploads it, and
waits for invalidation.

For rollback, retrieve the previous objects from S3 version history, then
invalidate `/*`. A stronger long-term setup is a versioned release prefix plus
an atomic CloudFront origin-path change, but that adds operational complexity
that this single-site deployment does not currently need.

## Known limitations

- S3 hosts only the public site and synthetic browser-memory demo. It cannot run
  Next.js server code, authentication callbacks, APIs, or database operations.
- The real protected review API and Slack-to-Confluence backend remain separate
  AWS services; do not expose them by placing credentials in this frontend.
- The current deployment script deliberately does not delete stale S3 keys.
- CloudFront changes and first-time DNS/TLS validation are not instantaneous.

## One-time GitHub Actions configuration

The workflow is `.github/workflows/deploy-website.yml`. It uses GitHub OIDC and
short-lived AWS credentials; it does not accept stored AWS access keys.

### 1. Resolve the real distribution ID

CloudFront invalidations use a distribution ID, not the CloudFront hostname.
Resolve it from the real distribution hostname:

```bash
aws cloudfront list-distributions \
  --query "DistributionList.Items[?DomainName=='dum73za17r19q.cloudfront.net'].Id | [0]" \
  --output text
```

If this prints `None`, the hostname is not present in the authenticated AWS
account. The supplied `d123example.cloudfront.net` value was illustrative and
does not exist in the authenticated account. The verified production values
are distribution `E3EMVCLM5MIYJP` at `dum73za17r19q.cloudfront.net`.

### 2. Obtain the immutable GitHub OIDC identifiers

Push the workflow branch and open a pull request before creating the AWS role.
The **Report immutable GitHub OIDC identifiers** step in the **Verify static
website** job prints:

```text
repository_id=...
repository_owner_id=...
```

These numeric identifiers are not credentials. GitHub includes them in default
OIDC subjects for repositories created after July 15, 2026. Using them prevents
a renamed, transferred, or later name-reused repository from assuming the
deployment role.

### 3. Create the least-privilege OIDC deployment role

The account must already have GitHub's OIDC provider for
`token.actions.githubusercontent.com`. Deploy
`infrastructure/website-deployment-role.yml` with:

- `GitHubOidcProviderArn`: the existing GitHub OIDC provider ARN;
- `GitHubOwnerId`: the printed `repository_owner_id`;
- `GitHubRepositoryId`: the printed `repository_id`;
- `BucketName`: `onrecord-public-site-prod`; and
- `CloudFrontDistributionId`: the ID resolved above.

The resulting role can only list and upload to this bucket and create/read
invalidations for that one distribution. It cannot delete S3 objects or modify
CloudFront configuration.

For the verified AWS account and repository, run from `website/`:

```bash
aws cloudformation deploy \
  --region ap-southeast-2 \
  --stack-name onrecord-website-github-deployment \
  --template-file infrastructure/website-deployment-role.yml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    GitHubOidcProviderArn=arn:aws:iam::393209814365:oidc-provider/token.actions.githubusercontent.com \
    GitHubOwnerId=REPLACE_WITH_REPOSITORY_OWNER_ID \
    GitHubRepositoryId=REPLACE_WITH_REPOSITORY_ID
```

Read the role ARN after the stack succeeds:

```bash
aws cloudformation describe-stacks \
  --region ap-southeast-2 \
  --stack-name onrecord-website-github-deployment \
  --query "Stacks[0].Outputs[?OutputKey=='WebsiteDeploymentRoleArn'].OutputValue | [0]" \
  --output text
```

### 4. Create the protected GitHub Environment

In **GitHub repository -> Settings -> Environments**, create
`production-website`. Add deployment reviewers if you want a manual approval
before every production release. Restrict deployment branches to `main`.

Add these environment variables:

| Variable | Value |
| --- | --- |
| `AWS_ACCOUNT_ID` | `393209814365` |
| `AWS_WEBSITE_DEPLOY_ROLE_ARN` | The role ARN output by the CloudFormation stack |

These values are identifiers, not credentials. Do not add AWS access-key
secrets; the workflow exchanges its GitHub identity for short-lived AWS
credentials.

### 5. Protect `main`

Require the **Verify static website** check before merging. Once merged, the
production job deploys to:

- bucket: `onrecord-public-site-prod`;
- site URL: `https://onrecord.kunal-sharma.in`; and
- CloudFront distribution: `E3EMVCLM5MIYJP`
  (`dum73za17r19q.cloudfront.net`).

The workflow intentionally triggers only when `website/**` or its workflow
changes. Backend-only commits do not rebuild or redeploy an unchanged website.

## AWS references

- [Restrict access to an S3 origin with CloudFront OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- [CloudFront certificate requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html)
- [Add an alternate domain name to CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CreatingCNAME.html)
- [Route 53 alias records for CloudFront](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-to-cloudfront-distribution.html)
- [CloudFront response headers policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/modifying-response-headers.html)
