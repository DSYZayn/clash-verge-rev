# Team edition development and deployment

This repository contains a minimal team-edition integration with two parts:

- The Tauri desktop app authenticates through Cloudflare Access Managed OAuth.
- `team-worker/` validates the Access identity, authorizes the user with D1,
  caches the upstream resource in KV, and returns Clash YAML without exposing
  the real upstream URL.

## Desktop development environment

Windows development requires:

1. Node.js 22.13 or newer (the repository currently declares pnpm 11.3.0).
2. pnpm via Corepack.
3. Rust 1.95.0 with `rustfmt` and `clippy`.
4. Visual Studio 2022 Build Tools with **Desktop development with C++**, the
   MSVC toolset, and a Windows 10/11 SDK.
5. WebView2 Runtime (normally already present on Windows 10/11).

Install the JavaScript and generated sidecar/resource dependencies before a
real Tauri build:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm prebuild
pnpm dev:tauri
```

`cargo check -p clash-verge --lib --features clippy` checks Rust code without
requiring the generated mihomo sidecar. A normal `cargo check` or Tauri build
expects `pnpm prebuild` to have populated `src-tauri/sidecar` and resources.

## Desktop configuration

Edit [`src-tauri/resources/team-config.json`](../src-tauri/resources/team-config.json)
before building:

- `enabled`: set to `true`.
- `api_base_url`: the Access-protected Worker custom domain.
- `oauth_discovery_url`: the Managed OAuth discovery endpoint.
- `oauth_client_id`: leave empty to use dynamic client registration, or set a
  registered public client ID.
- `oauth_scopes`: leave empty for Cloudflare Managed OAuth unless the server
  explicitly advertises additional scopes.
- `oauth_resource`: normally the same Access-protected API origin; it defaults
  to `api_base_url` when empty.
- `sync_interval_minutes`: background resource refresh interval.
- `auto_activate`: make the managed profile current after a successful sync.

## GitHub Actions builds

[`.github/workflows/team-build.yml`](../.github/workflows/team-build.yml) builds
the desktop client on every push to `main`, `dev`, `codex/**`, or `team/**`
branches, and can also be started manually from the Actions tab with a
per-platform selection. Installers are uploaded as workflow artifacts named
`clash-verge-team-<platform>`.

Real deployment values do not belong in git. Instead of editing
`team-config.json` before a CI build, set variables in the GitHub Environment
named `team-production`; when `TEAM_API_BASE_URL` or `WORKER_CUSTOM_DOMAIN` is
present, the workflow regenerates
`src-tauri/resources/team-config.json` with `enabled: true`:

- `TEAM_API_BASE_URL` - Access-protected Worker custom domain. It defaults to
  `WORKER_CUSTOM_DOMAIN` when omitted.
- `TEAM_OAUTH_DISCOVERY_URL` - optional; defaults to the Managed OAuth
  discovery endpoint under `TEAM_API_BASE_URL`'s team domain.
- `TEAM_OAUTH_CLIENT_ID` - optional; empty means dynamic client registration.
- `TEAM_OAUTH_RESOURCE` - optional resource indicator; defaults to the API
  origin.
- `TEAM_PROFILE_NAME` - optional display name of the managed profile.
- `TEAM_SYNC_INTERVAL_MINUTES` - optional, default `360`.

Team builds merge [`src-tauri/tauri.team.conf.json`](../src-tauri/tauri.team.conf.json)
via `--config` to disable `createUpdaterArtifacts` and clear the upstream
updater endpoints. Add your own private updater URL and signing key to that
team-specific merge file later if automatic updates are required.

[`.github/workflows/team-worker-ci.yml`](../.github/workflows/team-worker-ci.yml)
typechecks the Worker and runs `wrangler deploy --dry-run`. The manual
[`team-worker-deploy.yml`](../.github/workflows/team-worker-deploy.yml) workflow
generates a production Wrangler config from the `team-production` Environment,
applies D1 migrations, deploys the Worker, and optionally synchronizes the
upstream URL from a GitHub Secret into a Worker Secret.

In Cloudflare Zero Trust, edit the self-hosted Access application and:

1. Enable **Managed OAuth**.
2. Enable **Allow loopback clients** (`127.0.0.1`).
3. Use a 5–15 minute access-token lifetime.
4. Use a 7–14 day grant session.
5. Keep the existing Casdoor identity provider and Access policies.

The desktop app uses Authorization Code + PKCE. Tokens are never sent to the
React webview. For this minimal implementation the session is encrypted with
the app's existing AES key and stored as `team-session.enc` in the app data
directory. A production hardening pass should move the refresh token to
Windows Credential Manager, macOS Keychain, or Linux Secret Service.

## Worker deployment

See [`team-worker/README.md`](../team-worker/README.md) and the detailed
[Chinese production guide](team-deployment.zh-CN.md). In summary:

1. Create D1 and KV resources and copy their IDs into `wrangler.toml`.
2. Fill `TEAM_DOMAIN` and `ACCESS_AUD`.
3. Store the true URL with `wrangler secret put UPSTREAM_SUBSCRIPTION_URL`.
4. Apply migrations and deploy.
5. Put the Worker custom domain behind the same Access application whose
   Managed OAuth metadata the desktop app uses.
6. Insert authorized users into the D1 `users` table.

The upstream URL exists only as a Worker secret. The desktop receives YAML,
`ETag`, and `Subscription-Userinfo`; it never receives the upstream URL.

## Minimal implementation boundaries

- The managed profile has the fixed internal UID `RTEAMMANAGED` and is hidden
  from the ordinary Profiles page.
- View, edit, delete, and direct update commands reject that UID.
- A cached profile remains available after logout, but no authenticated remote
  refresh can occur until the user logs in again. If logout must immediately
  stop the proxy and erase cached YAML, add that policy before production.
- Client-side secrecy is not absolute against a local administrator or process
  debugger. The protected asset is the upstream URL; the YAML must necessarily
  reach mihomo to be used.
