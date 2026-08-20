# Clash Verge Team Worker

This Worker sits behind a Cloudflare Access self-hosted application with
**Managed OAuth** enabled. It validates the Access JWT forwarded by Cloudflare,
looks up the user's entitlement in D1, and proxies the managed Clash YAML
without revealing the upstream URL to the desktop app.

## Recommended production deployment

Use the repository's **Deploy Team Worker** GitHub Action. It reads non-secret
configuration and credentials from the `team-production` GitHub Environment,
generates the ignored `wrangler.generated.toml`, applies migrations, deploys,
and copies the upstream URL from a GitHub Environment Secret to a Cloudflare
Worker Secret. See [`../docs/team-deployment.zh-CN.md`](../docs/team-deployment.zh-CN.md)
for the complete Cloudflare Access and client-build sequence.

## Local provisioning

```powershell
wrangler d1 create clash-verge-team
wrangler kv namespace create RESOURCE_CACHE
wrangler kv namespace create RESOURCE_CACHE --preview
```

Copy `.env.example` to `.env` and fill the returned IDs, `TEAM_DOMAIN`, and
`ACCESS_AUD`. Both `.env` and the generated Wrangler config are ignored. Store
the real resource URL as a Worker secret:

```powershell
npm install
npm run config:prepare
npx wrangler secret put UPSTREAM_SUBSCRIPTION_URL --config wrangler.generated.toml
npm run db:migrate:remote
npm run deploy
```

Create an entitlement before or after the first Access login. A `pending:` key
allows pre-provisioning by email; after the first valid Access request the
Worker replaces it with the immutable JWT `sub`:

```sql
INSERT INTO users (
  access_subject, email, display_name, team_name, enabled,
  quota_upload, quota_download, quota_total, quota_expire
) VALUES (
  'pending:user@example.com', 'user@example.com', 'Example User', 'Example Team', 1,
  NULL, NULL, NULL, NULL
);
```

The Access application must allow loopback clients and expose Managed OAuth
discovery at `/.well-known/oauth-authorization-server`. Recommended settings:
5–15 minute access tokens and a 7–14 day grant session.

For local development, Access does not inject its assertion. Test the deployed
Access-protected hostname for the authentication flow; use local development
only for type checking and non-authenticated `/healthz` work.
