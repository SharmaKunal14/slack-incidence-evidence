# OnRecord website

Public product site and synthetic review demo for OnRecord.

## Local development

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

## Builds

The project intentionally supports two deployment targets:

- `npm run build` creates the existing OpenAI Sites/Cloudflare Worker build.
- `npm run build:s3` creates a serverless static export in `out/` for Amazon
  S3 and CloudFront.

Set `NEXT_PUBLIC_SITE_URL` to the final HTTPS origin before the S3 build so
Open Graph and social-card URLs use the custom domain:

```bash
NEXT_PUBLIC_SITE_URL=https://onrecord.example.com \
NEXT_PUBLIC_APP_URL=https://app.example.com/#/settings/integrations \
npm run build:s3
```

`NEXT_PUBLIC_APP_URL` is the public HTTPS location of the authenticated review
console. Landing-page “Connect Slack” actions send visitors to its Integrations
route; authentication and Slack authorization still happen in the protected
console, never in the static website.

The static export contains the landing page, `/demo/` redirect, interactive
synthetic review application, product images, technology artwork, captions,
and workflow film. It has no application secrets or server runtime.

## Verification

```bash
npm run lint
npm test
npm run test:s3
bash -n scripts/deploy-s3-cloudfront.sh
bash -n scripts/upload-s3-cloudfront.sh
```

## AWS deployment

Follow [S3 and CloudFront deployment](docs/s3-cloudfront-deployment.md).

After the one-time AWS and GitHub Environment configuration, pull requests
verify the website and pushes to `main` deploy the exact verified artifact
automatically through `.github/workflows/deploy-website.yml`.
