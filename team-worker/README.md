# Clash Verge Team Worker

This Worker sits behind a Cloudflare Access self-hosted application with
**Managed OAuth** enabled. It validates the Access JWT forwarded by Cloudflare,
looks up the user's entitlement in D1, and proxies the managed Clash YAML
without revealing the upstream URL to the desktop app.

## Provision

```powershell
wrangler d1 create clash-verge-team
wrangler kv namespace create RESOURCE_CACHE
wrangler kv namespace create RESOURCE_CACHE --preview
```

Copy the returned IDs to `wrangler.toml`, then configure `TEAM_DOMAIN` and
`ACCESS_AUD`. Store the real resource URL as a Worker secret:

```powershell
wrangler secret put UPSTREAM_SUBSCRIPTION_URL
pnpm install
pnpm db:migrate:remote
pnpm deploy
```

Create an entitlement after the first Access login. Use the Access JWT `sub`
claim when available; email is retained as a migration/fallback lookup:

```sql
INSERT INTO users (
  access_subject, email, display_name, team_name, enabled,
  quota_upload, quota_download, quota_total, quota_expire
) VALUES (
  'ACCESS_SUBJECT', 'user@example.com', 'Example User', 'Example Team', 1,
  0, 0, 107374182400, 1790000000
);
```

The Access application must allow loopback clients and expose Managed OAuth
discovery at `/.well-known/oauth-authorization-server`. Recommended settings:
5–15 minute access tokens and a 7–14 day grant session.

For local development, Access does not inject its assertion. Test the deployed
Access-protected hostname for the authentication flow; use local development
only for type checking and non-authenticated `/healthz` work.
