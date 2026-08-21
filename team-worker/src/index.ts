import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

import schemaSql from '../migrations/0001_init.sql'
import devicesSql from '../migrations/0002_devices.sql'

// D1 exec treats each input line as its own statement: a pretty-printed
// multi-line CREATE TABLE fails with "incomplete input". Flatten each
// migration into a single line; the schema contains no string literals, so
// collapsing whitespace is safe. Strip `--` comments first: once flattened,
// everything after a comment marker would become part of that comment.
const schemaBatch = [schemaSql, devicesSql]
  .map((sql) =>
    sql
      .replace(/--[^\n]*/g, '')
      .replace(/\s+/g, ' ')
      .replace(/;+\s*$/, ''),
  )
  .join(';')

interface Env {
  TEAM_DB: D1Database
  RESOURCE_CACHE: KVNamespace
  TEAM_DOMAIN: string
  ACCESS_AUD: string
  DEFAULT_TEAM_NAME?: string
  CACHE_TTL_SECONDS?: string
  UPSTREAM_SUBSCRIPTION_URL?: string
  ADMIN_API_TOKEN?: string
}

interface UserRow {
  access_subject: string
  email: string | null
  display_name: string | null
  team_name: string | null
  enabled: number
  quota_upload: number | null
  quota_download: number | null
  quota_total: number | null
  quota_expire: number | null
}

interface CachedResource {
  body: string
  etag: string
  subscriptionUserinfo?: string
  contentDisposition?: string
}

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { 'cache-control': 'private, no-store' },
  })

// D1 and jose errors hide the actionable detail in `cause`; unwrap it so
// the Worker logs show the real reason instead of an empty message.
function describeError(error: unknown, depth = 0): string {
  if (depth > 3) return '...'
  if (error instanceof Error) {
    const base = `${error.name}: ${error.message}`
    return error.cause === undefined
      ? base
      : `${base} <- ${describeError(error.cause, depth + 1)}`
  }
  return String(error)
}

const normalizedIssuer = (teamDomain: string) => teamDomain.replace(/\/$/, '')

// A freshly provisioned database (first deploy through a Git-connected build,
// before migrations have ever run) has no tables yet. Run the idempotent
// schema once per isolate so the Worker can self-heal; a failed attempt is
// retried on the next request.
let schemaInit: Promise<unknown> | undefined

async function healUsersTable(env: Env) {
  // Self-heal databases whose users table predates the current schema:
  // CREATE TABLE IF NOT EXISTS cannot retrofit missing columns.
  const { results } = await env.TEAM_DB.prepare(
    'PRAGMA table_info(users)',
  ).all<{ name: string }>()
  const existing = new Set(results.map((row) => row.name))
  const columns: Array<[string, string]> = [
    ['email', 'TEXT'],
    ['display_name', 'TEXT'],
    ['team_name', 'TEXT'],
    ['enabled', 'INTEGER NOT NULL DEFAULT 1'],
    ['quota_upload', 'INTEGER'],
    ['quota_download', 'INTEGER'],
    ['quota_total', 'INTEGER'],
    ['quota_expire', 'INTEGER'],
    ['created_at', 'TEXT'],
    ['updated_at', 'TEXT'],
  ]
  for (const [name, type] of columns) {
    if (!existing.has(name))
      await env.TEAM_DB.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`)
  }
}

function ensureSchema(env: Env) {
  schemaInit ??= (async () => {
    await env.TEAM_DB.exec(schemaBatch)
    try {
      await healUsersTable(env)
    } catch (error) {
      // Advisory only: schemaSql is the authoritative shape. If a stale
      // table cannot be retrofitted, later queries surface the real gap.
      console.error('schema self-heal failed:', describeError(error))
    }
  })().catch((error: unknown) => {
    schemaInit = undefined
    throw error
  })
  return schemaInit
}

const PLACEHOLDER_VALUE = /YOUR[-_]|REPLACE_|CHANGE[-_]?ME/i

// Single KV slot for the managed profile. Admin pushes (PUT /v1/admin/resource)
// store without expiry; direct upstream fetches populate it with a TTL.
const RESOURCE_CACHE_KEY = 'managed-profile:v1'

async function authenticate(request: Request, env: Env): Promise<JWTPayload> {
  // Access injects Cf-Access-Jwt-Assertion on the origin request, but accept a
  // Bearer token too so the worker stays correct if the header is stripped.
  const bearer = request.headers.get('authorization')
  const assertion =
    request.headers.get('cf-access-jwt-assertion') ??
    (bearer?.toLowerCase().startsWith('bearer ') ? bearer.slice(7).trim() : null)
  if (!assertion)
    throw new Response('Missing Cloudflare Access assertion', { status: 401 })

  if (
    !env.TEAM_DOMAIN ||
    !env.ACCESS_AUD ||
    PLACEHOLDER_VALUE.test(env.TEAM_DOMAIN) ||
    PLACEHOLDER_VALUE.test(env.ACCESS_AUD)
  ) {
    throw new Response(
      'Worker is not configured: set TEAM_DOMAIN and ACCESS_AUD in the dashboard',
      { status: 503 },
    )
  }
  const issuer = normalizedIssuer(env.TEAM_DOMAIN)
  try {
    const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))
    const { payload } = await jwtVerify(assertion, jwks, {
      issuer,
      audience: env.ACCESS_AUD,
    })
    return payload
  } catch (error) {
    // Verification failures (aud/issuer mismatch, unreachable JWKS, malformed
    // TEAM_DOMAIN) must surface as a diagnosable 401 in the Worker logs, not
    // as an opaque 500 from the catch-all handler.
    console.error('access assertion verification failed:', describeError(error))
    throw new Response('Access assertion verification failed', { status: 401 })
  }
}

async function getUser(
  env: Env,
  identity: JWTPayload,
): Promise<UserRow | null> {
  const subject = identity.sub
  const email = typeof identity.email === 'string' ? identity.email : undefined
  if (!subject) return null

  const user = await env.TEAM_DB.prepare(
    `SELECT access_subject, email, display_name, team_name, enabled,
            quota_upload, quota_download, quota_total, quota_expire
       FROM users
      WHERE access_subject = ?1 OR (?2 IS NOT NULL AND lower(email) = lower(?2))
      ORDER BY CASE WHEN access_subject = ?1 THEN 0 ELSE 1 END
      LIMIT 1`,
  )
    .bind(subject, email ?? null)
    .first<UserRow>()

  // Administrators can provision a user by email before the user's first
  // login. Replace the pending key with the immutable Access subject as soon
  // as Access resolves the OAuth token into a signed identity assertion.
  if (
    user &&
    user.access_subject !== subject &&
    email &&
    user.email?.toLowerCase() === email.toLowerCase()
  ) {
    await env.TEAM_DB.prepare(
      `UPDATE users
          SET access_subject = ?1, updated_at = CURRENT_TIMESTAMP
        WHERE access_subject = ?2`,
    )
      .bind(subject, user.access_subject)
      .run()
    user.access_subject = subject
  }
  return user
}

// First-login enrollment: anyone who passed Cloudflare Access gets an
// entitlement row created from the identity. Concurrent first requests race
// on the primary key; ON CONFLICT keeps the loser benign and the row is
// re-read so the winner's values are authoritative.
async function provisionUser(
  env: Env,
  identity: JWTPayload,
): Promise<UserRow | null> {
  const subject = identity.sub
  if (!subject) return null
  const email = typeof identity.email === 'string' ? identity.email : null
  const displayName =
    typeof identity.name === 'string' && identity.name.trim() !== ''
      ? identity.name
      : email
  await env.TEAM_DB.prepare(
    `INSERT INTO users (access_subject, email, display_name, enabled)
     VALUES (?1, ?2, ?3, 1)
     ON CONFLICT(access_subject) DO NOTHING`,
  )
    .bind(subject, email, displayName)
    .run()
  const user = await getUser(env, identity)
  if (user) await audit(env, user, 'user_provisioned')
  return user
}

function requireEnabledUser(user: UserRow | null): asserts user is UserRow {
  if (!user)
    throw new Response('No team entitlement is assigned', { status: 403 })
  if (user.enabled !== 1)
    throw new Response('Team entitlement is disabled', { status: 403 })
}

function quota(user: UserRow) {
  return {
    upload: user.quota_upload ?? 0,
    download: user.quota_download ?? 0,
    total: user.quota_total ?? 0,
    expire: user.quota_expire ?? 0,
  }
}

function quotaHeader(user: UserRow) {
  const value = quota(user)
  return `upload=${value.upload}; download=${value.download}; total=${value.total}; expire=${value.expire}`
}

async function sha256Etag(body: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(body),
  )
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `"${hex}"`
}

// The managed profile is served from KV. Admin pushes are the primary path for
// upstreams whose WAF blocks datacenter egress; a direct upstream fetch is the
// fallback when nothing has been pushed yet.
async function getResource(env: Env): Promise<CachedResource> {
  const cached = await env.RESOURCE_CACHE.get<CachedResource>(
    RESOURCE_CACHE_KEY,
    'json',
  )
  if (cached) return cached
  return fetchResource(env)
}

async function putResource(
  env: Env,
  body: string,
  subscriptionUserinfo?: string,
  contentDisposition?: string,
) {
  const resource: CachedResource = {
    body,
    etag: await sha256Etag(body),
    subscriptionUserinfo,
    contentDisposition,
  }
  // No expiration: a pushed resource is served until the next push replaces
  // it, so a stalled uploader never breaks clients.
  await env.RESOURCE_CACHE.put(RESOURCE_CACHE_KEY, JSON.stringify(resource))
  return resource
}

// Machine-to-machine ingestion for the managed profile, authenticated with a
// dedicated admin secret rather than an Access identity. Typically called by
// a scheduled uploader running on a residential-IP machine.
async function handleAdminResourcePut(request: Request, env: Env) {
  if (!env.ADMIN_API_TOKEN)
    return json({ error: 'Admin endpoint is not configured' }, 503)
  if (request.headers.get('authorization') !== `Bearer ${env.ADMIN_API_TOKEN}`)
    return json({ error: 'Invalid admin token' }, 401)
  const body = await request.text()
  if (!body || body.length > 10 * 1024 * 1024)
    return json({ error: 'Body is empty or exceeds the 10 MiB limit' }, 400)
  const resource = await putResource(
    env,
    body,
    request.headers.get('x-subscription-userinfo') ?? undefined,
    request.headers.get('x-content-disposition') ?? undefined,
  )
  console.log(`admin resource pushed: ${body.length} bytes, etag: ${resource.etag}`)
  return json({ ok: true, bytes: body.length, etag: resource.etag })
}

async function fetchResource(env: Env): Promise<CachedResource> {
  if (!env.UPSTREAM_SUBSCRIPTION_URL) {
    throw new Response('UPSTREAM_SUBSCRIPTION_URL is not configured', {
      status: 503,
    })
  }
  let upstreamHost = '(unknown)'
  let response: Response
  try {
    upstreamHost = new URL(env.UPSTREAM_SUBSCRIPTION_URL).host
    response = await fetch(env.UPSTREAM_SUBSCRIPTION_URL, {
      redirect: 'follow',
      // Never let the edge cache a subscription response.
      cf: { cacheTtl: 0 },
      // Some subscription panels only serve YAML to a recognizable client UA.
      headers: { 'user-agent': 'clash-verge/v2.4.3' },
    })
  } catch (error) {
    // Never log the full upstream URL: it embeds a secret token.
    console.error('upstream fetch error:', describeError(error), `host: ${upstreamHost}`)
    throw new Response('Upstream resource is unreachable', { status: 502 })
  }
  if (!response.ok) {
    // The error page identifies the blocker: a Cloudflare WAF challenge
    // (Error 1020) reads differently from a panel-generated token error.
    const snippet = (await response.text().catch(() => '')).slice(0, 300)
    console.error(
      `upstream fetch failed: ${response.status} ${response.statusText}, host: ${upstreamHost}, server: ${response.headers.get('server') ?? '(none)'}, cf-ray: ${response.headers.get('cf-ray') ?? '(none)'}, body: ${snippet}`,
    )
    throw new Response('Upstream resource is unavailable', { status: 502 })
  }

  const body = await response.text()
  if (body.length > 10 * 1024 * 1024) {
    console.error(
      `upstream resource too large: ${body.length} bytes, host: ${upstreamHost}`,
    )
    throw new Response('Upstream resource exceeds the 10 MiB limit', {
      status: 502,
    })
  }
  console.log(
    `upstream fetched: ${response.status}, ${body.length} bytes, host: ${upstreamHost}`,
  )
  const resource: CachedResource = {
    body,
    etag: await sha256Etag(body),
    subscriptionUserinfo:
      response.headers.get('subscription-userinfo') ?? undefined,
    contentDisposition:
      response.headers.get('content-disposition') ?? undefined,
  }
  await env.RESOURCE_CACHE.put(RESOURCE_CACHE_KEY, JSON.stringify(resource), {
    expirationTtl: Math.max(60, Number(env.CACHE_TTL_SECONDS) || 300),
  })
  return resource
}

async function audit(env: Env, user: UserRow, eventType: string) {
  await env.TEAM_DB.prepare(
    'INSERT INTO audit_events (access_subject, event_type) VALUES (?1, ?2)',
  )
    .bind(user.access_subject, eventType)
    .run()
}

const ONLINE_WINDOW_SECONDS = 600

// Upsert a presence row for the calling install. The device id is a random
// per-install string generated by the desktop; it carries no identity beyond
// "this installation was seen recently".
async function touchDevice(env: Env, subject: string, deviceId: string) {
  const ts = Math.floor(Date.now() / 1000)
  await env.TEAM_DB.prepare(
    'INSERT INTO devices (access_subject, device_id, first_seen, last_seen) VALUES (?1, ?2, ?3, ?3) ON CONFLICT (access_subject, device_id) DO UPDATE SET last_seen = ?3',
  )
    .bind(subject, deviceId, ts)
    .run()
}

async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) {
  const url = new URL(request.url)
  if (url.pathname === '/healthz') return json({ ok: true })

  const bindings = env as Partial<Env>
  if (!bindings.TEAM_DB || !bindings.RESOURCE_CACHE)
    return json(
      {
        error:
          'Worker bindings missing: bind TEAM_DB (D1) and RESOURCE_CACHE (KV), then redeploy',
      },
      503,
    )

  if (request.method === 'PUT' && url.pathname === '/v1/admin/resource') {
    return handleAdminResourcePut(request, env)
  }

  const identity = await authenticate(request, env)
  try {
    await ensureSchema(env)
  } catch (error) {
    console.error('database schema init failed:', describeError(error))
    return json({ error: 'Database schema initialization failed' }, 560)
  }
  let user: UserRow | null
  try {
    user = await getUser(env, identity)
    // Access is the membership gate: provision on first login instead of
    // requiring a manual D1 INSERT. users.enabled = 0 stays the kill switch.
    user ??= await provisionUser(env, identity)
  } catch (error) {
    console.error('user lookup/provision failed:', describeError(error))
    return json({ error: 'User lookup or provisioning failed' }, 561)
  }
  requireEnabledUser(user)

  const deviceId = request.headers.get('x-team-device')
  if (deviceId && /^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) {
    ctx.waitUntil(touchDevice(env, user.access_subject, deviceId))
  }

  if (request.method === 'GET' && url.pathname === '/v1/desktop/account') {
    const online = await env.TEAM_DB.prepare(
      'SELECT COUNT(*) AS n FROM devices WHERE access_subject = ?1 AND last_seen > ?2',
    )
      .bind(user.access_subject, Math.floor(Date.now() / 1000) - ONLINE_WINDOW_SECONDS)
      .first<{ n: number }>()
    return json({
      devicesOnline: online?.n ?? 0,
      userId: user.access_subject,
      email: user.email,
      displayName: user.display_name,
      team: user.team_name ?? env.DEFAULT_TEAM_NAME ?? 'Team',
      enabled: true,
      // A null total means quota is inherited from Subscription-Userinfo. The
      // desktop preserves its last synchronized value until /profile refreshes it.
      quota: user.quota_total !== null ? quota(user) : null,
    })
  }

  if (request.method === 'GET' && url.pathname === '/v1/desktop/profile') {
    const resource = await getResource(env)
    const effectiveQuota =
      user.quota_total !== null
        ? quotaHeader(user)
        : (resource.subscriptionUserinfo ?? quotaHeader(user))
    const effectiveEtag = await sha256Etag(`${resource.etag}:${effectiveQuota}`)
    if (request.headers.get('if-none-match') === effectiveEtag) {
      return new Response(null, {
        status: 304,
        headers: { etag: effectiveEtag },
      })
    }
    ctx.waitUntil(audit(env, user, 'profile_download'))
    const headers = new Headers({
      'content-type': 'application/yaml; charset=utf-8',
      'cache-control': 'private, no-store',
      etag: effectiveEtag,
      'subscription-userinfo': effectiveQuota,
      'profile-update-interval': '6',
    })
    if (resource.contentDisposition)
      headers.set('content-disposition', resource.contentDisposition)
    return new Response(resource.body, { headers })
  }

  return json({ error: 'Not found' }, 404)
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx)
    } catch (error) {
      if (error instanceof Response) return error
      console.error('unhandled error:', describeError(error))
      return json({ error: 'Internal server error' }, 500)
    }
  },
} satisfies ExportedHandler<Env>
