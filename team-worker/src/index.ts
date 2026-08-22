import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

import schemaSql from '../migrations/0001_init.sql'
import devicesSql from '../migrations/0002_devices.sql'
import tailscaleSql from '../migrations/0003_tailscale.sql'
import { ADMIN_HTML } from './admin'

// D1 exec treats each input line as its own statement: a pretty-printed
// multi-line CREATE TABLE fails with "incomplete input". Flatten each
// migration into a single line; the schema contains no string literals, so
// collapsing whitespace is safe. Strip `--` comments first: once flattened,
// everything after a comment marker would become part of that comment.
const schemaBatch = [schemaSql, devicesSql, tailscaleSql]
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
  TAILSCALE_TAILNET?: string
  TAILSCALE_OAUTH_CLIENT_ID?: string
  TAILSCALE_OAUTH_CLIENT_SECRET?: string
  ADMIN_EMAIL?: string
  DEFAULT_TAILSCALE_KEY_EXPIRY_SECONDS?: string
  CASDOOR_ENDPOINT?: string
  CASDOOR_CLIENT_ID?: string
  CASDOOR_CLIENT_SECRET?: string
  CASDOOR_ORGANIZATION?: string
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
  tailscale_role: 'user' | 'admin'
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
    ['tailscale_role', "TEXT NOT NULL DEFAULT 'user'"],
    ['created_at', 'TEXT'],
    ['updated_at', 'TEXT'],
  ]
  for (const [name, type] of columns) {
    if (!existing.has(name))
      await addColumnIfMissing(env, 'users', name, type)
  }

  // 0003 deliberately keeps its DDL idempotent. This also repairs databases
  // where migrations were recorded before one of the columns was added.
  await healTable(env, 'tailscale_key_issuances', [
    ['access_subject', 'TEXT NOT NULL DEFAULT \'\''],
    ['team_device_id', 'TEXT'],
    ['key_hash', 'TEXT NOT NULL DEFAULT \'\''],
    ['role', "TEXT NOT NULL DEFAULT 'user'"],
    ['tag', "TEXT NOT NULL DEFAULT 'tag:team-user'"],
    ['issued_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['expires_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['used_at', 'INTEGER'],
    ['revoked_at', 'INTEGER'],
    ['created_at', 'TEXT'],
  ])
  await healTable(env, 'tailscale_devices', [
    ['access_subject', "TEXT NOT NULL DEFAULT ''"],
    ['team_device_id', 'TEXT'],
    ['hostname', 'TEXT'],
    ['ipv4', 'TEXT'],
    ['ipv6', 'TEXT'],
    ['role', "TEXT NOT NULL DEFAULT 'user'"],
    ['tag', "TEXT NOT NULL DEFAULT 'tag:team-user'"],
    ['online', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_seen', 'INTEGER NOT NULL DEFAULT 0'],
    ['revoked_at', 'INTEGER'],
    ['created_at', 'TEXT'],
    ['updated_at', 'TEXT'],
  ])
}

async function healTable(
  env: Env,
  table: string,
  columns: Array<[string, string]>,
) {
  const { results } = await env.TEAM_DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
  const existing = new Set(results.map((row) => row.name))
  for (const [name, type] of columns) {
    if (!existing.has(name))
      await addColumnIfMissing(env, table, name, type)
  }
}

async function addColumnIfMissing(
  env: Env,
  table: string,
  name: string,
  type: string,
) {
  try {
    await env.TEAM_DB.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
  } catch (error) {
    // Another Worker isolate may have added the column after our PRAGMA read.
    // SQLite has no portable ADD COLUMN IF NOT EXISTS syntax, so tolerate only
    // that specific race and surface every other schema error.
    if (!/duplicate column name/i.test(describeError(error))) throw error
  }
}

function ensureSchema(env: Env) {
  schemaInit ??= (async () => {
    await env.TEAM_DB.exec(schemaBatch)
    await healUsersTable(env)
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

function extractHeadersProfile(request: Request): Record<string, unknown> {
  const profile: Record<string, unknown> = {}
  const candidateHeaderNames = [
    'cf-access-user-name',
    'cf-access-user-display-name',
    'cf-access-preferred-username',
    'cf-access-first-name',
    'cf-access-last-name',
    'x-user-name',
    'x-display-name',
    'x-preferred-username',
  ]
  for (const name of candidateHeaderNames) {
    const val = request.headers.get(name)
    if (val && val.trim()) {
      profile[name.replace(/^cf-access-/, '').replace(/-/g, '_')] = val.trim()
    }
  }
  return profile
}

async function fetchAccessIdentity(
  issuer: string,
  appOrigin: string,
  assertion: string,
): Promise<Record<string, unknown> | null> {
  const endpoints = [
    `${issuer}/cdn-cgi/access/get-identity`,
    `${appOrigin}/cdn-cgi/access/get-identity`,
  ]
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: {
          cookie: `CF_Authorization=${assertion}`,
          'cf-access-jwt-assertion': assertion,
        },
      })
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>
        if (data && typeof data === 'object') {
          return data
        }
      }
    } catch (e) {
      console.warn(`failed to fetch ${url}:`, describeError(e))
    }
  }
  return null
}

function getStringValue(val: unknown): string {
  if (typeof val === 'string') return val.trim()
  if (Array.isArray(val) && val.length > 0) {
    const first = val[0]
    if (typeof first === 'string') return first.trim()
  }
  return ''
}

function extractDisplayName(identity: JWTPayload, identityDetails?: Record<string, unknown> | null): string | null {
  const raw = { ...(identityDetails || {}), ...(identity as Record<string, unknown> || {}) }
  const email = getStringValue(raw.email)
  const isEmail = (s: string) => Boolean(email && s.toLowerCase() === email.toLowerCase()) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

  const candidateKeys = [
    'displayName',
    'display_name',
    'displayname',
    'preferred_username',
    'preferredUsername',
    'preferredusername',
    'username',
    'user_name',
    'name',
    'nickname',
    'nickName',
  ]

  function findInObject(obj: unknown): string {
    if (!obj || typeof obj !== 'object') return ''
    const dict = obj as Record<string, unknown>
    // 1. Direct candidate keys
    for (const key of candidateKeys) {
      const val = getStringValue(dict[key])
      if (val && !isEmail(val)) {
        return val
      }
    }
    // 2. Case-insensitive key search
    for (const k of Object.keys(dict)) {
      const lowerK = k.toLowerCase()
      for (const candidate of candidateKeys) {
        if (
          lowerK === candidate.toLowerCase() ||
          lowerK.endsWith('/' + candidate.toLowerCase()) ||
          lowerK.endsWith(':' + candidate.toLowerCase())
        ) {
          const val = getStringValue(dict[k])
          if (val && !isEmail(val)) {
            return val
          }
        }
      }
    }
    return ''
  }

  // 1. Check root
  let name = findInObject(raw)
  if (name) return name

  // 2. Check nested claim objects (Cloudflare Access custom claims, SAML attributes, IdP claims)
  const nestedKeys = [
    'custom',
    'custom_attributes',
    'custom_claims',
    'user_metadata',
    'app_metadata',
    'profile',
    'idp',
    'raw_attributes',
    'claims',
    'user',
    'identity_provider',
  ]

  for (const nk of nestedKeys) {
    const nested = raw[nk]
    if (nested && typeof nested === 'object') {
      name = findInObject(nested)
      if (name) return name
    }
  }

  // 3. Check first_name + last_name combinations
  function getCompositeName(obj: unknown): string {
    if (!obj || typeof obj !== 'object') return ''
    const dict = obj as Record<string, unknown>
    const given =
      getStringValue(dict.firstName) ||
      getStringValue(dict.first_name) ||
      getStringValue(dict.given_name) ||
      getStringValue(dict.givenName)
    const family =
      getStringValue(dict.lastName) ||
      getStringValue(dict.last_name) ||
      getStringValue(dict.family_name) ||
      getStringValue(dict.familyName)

    if (given && family) {
      const hasCJK = /[\u4e00-\u9fa5]/.test(given) || /[\u4e00-\u9fa5]/.test(family)
      return hasCJK ? `${family}${given}` : `${given} ${family}`
    }
    if (given && !isEmail(given)) return given
    if (family && !isEmail(family)) return family
    return ''
  }

  name = getCompositeName(raw)
  if (name) return name

  for (const nk of nestedKeys) {
    name = getCompositeName(raw[nk])
    if (name) return name
  }

  // Fallback to name if present even if it looks like email
  const rawName = getStringValue(raw.name)
  if (rawName) return rawName

  return email || null
}

async function getUser(
  env: Env,
  identity: JWTPayload,
  identityDetails?: Record<string, unknown> | null,
): Promise<UserRow | null> {
  const subject = identity.sub
  const email = typeof identity.email === 'string' ? identity.email.trim() : undefined
  if (!subject) return null

  const user = await env.TEAM_DB.prepare(
    `SELECT access_subject, email, display_name, team_name, enabled,
            quota_upload, quota_download, quota_total, quota_expire,
            COALESCE(tailscale_role, 'user') AS tailscale_role
       FROM users
      WHERE access_subject = ?1 OR (?2 IS NOT NULL AND lower(email) = lower(?2))
      ORDER BY CASE WHEN access_subject = ?1 THEN 0 ELSE 1 END
      LIMIT 1`,
  )
    .bind(subject, email ?? null)
    .first<UserRow>()

  if (user) {
    // Administrators can provision a user by email before the user's first
    // login. Replace the pending key with the immutable Access subject as soon
    // as Access resolves the OAuth token into a signed identity assertion.
    if (
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

    // Auto-sync display name and email if a better/updated name is present in SSO identity
    const currentName = user.display_name?.trim() ?? ''
    const ssoDisplayName = extractDisplayName(identity, identityDetails)
    const shouldUpdateName =
      ssoDisplayName &&
      ssoDisplayName !== currentName &&
      (currentName === '' || (user.email && currentName.toLowerCase() === user.email.toLowerCase()) || ssoDisplayName !== email)

    if (shouldUpdateName) {
      await env.TEAM_DB.prepare(
        'UPDATE users SET display_name = ?1, updated_at = CURRENT_TIMESTAMP WHERE access_subject = ?2',
      )
        .bind(ssoDisplayName, user.access_subject)
        .run()
      user.display_name = ssoDisplayName
    }

    if (email && email !== user.email) {
      await env.TEAM_DB.prepare(
        'UPDATE users SET email = ?1, updated_at = CURRENT_TIMESTAMP WHERE access_subject = ?2',
      )
        .bind(email, user.access_subject)
        .run()
      user.email = email
    }
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
  identityDetails?: Record<string, unknown> | null,
): Promise<UserRow | null> {
  const subject = identity.sub
  if (!subject) return null
  const email = typeof identity.email === 'string' ? identity.email.trim() : null
  const displayName = extractDisplayName(identity, identityDetails)
  await env.TEAM_DB.prepare(
    `INSERT INTO users (access_subject, email, display_name, enabled)
     VALUES (?1, ?2, ?3, 1)
     ON CONFLICT(access_subject) DO NOTHING`,
  )
    .bind(subject, email, displayName)
    .run()
  const user = await getUser(env, identity, identityDetails)
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
const TAILSCALE_KEY_DEFAULT_EXPIRY_SECONDS = 7 * 86400
const TAILSCALE_KEY_MIN_EXPIRY_SECONDS = 86400
const TAILSCALE_KEY_MAX_EXPIRY_SECONDS = 90 * 86400

const TAILSCALE_API = 'https://api.tailscale.com/api/v2'

interface TailscaleKeyResponse {
  id: string
  key: string
  created: string
  expires: string
}

interface TailscaleDeviceKeyState {
  keyExpiryDisabled?: boolean
  expires?: string
}

type TailscaleScope = 'auth_keys' | 'devices:core'

function tailscaleConfig(env: Env) {
  if (!env.TAILSCALE_TAILNET || !env.TAILSCALE_OAUTH_CLIENT_ID || !env.TAILSCALE_OAUTH_CLIENT_SECRET)
    throw new Response('Tailscale is not configured', { status: 503 })
  return {
    // Tailscale API v2 accepts the Tailnet ID (the recommended identifier)
    // in this path. Keep it opaque: do not parse it as a DNS name or append
    // a domain suffix. encodeURIComponent is only for path-segment safety.
    tailnetId: env.TAILSCALE_TAILNET,
    clientId: env.TAILSCALE_OAUTH_CLIENT_ID,
    clientSecret: env.TAILSCALE_OAUTH_CLIENT_SECRET,
  }
}

function safeTailscaleMessage(body: string, secret?: string) {
  let text = body.replace(/\s+/g, ' ').trim().slice(0, 500)
  text = text
    .replace(/tskey-[A-Za-z0-9._-]+/g, '[redacted-auth-key]')
    .replace(/("?(?:key|auth[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)"?\s*[:=]\s*")([^"\\]+)/gi, '$1[redacted-secret]')
  return secret && text ? text.split(secret).join('[redacted]') : text
}

async function tailscaleAccessToken(
  env: Env,
  scope: TailscaleScope,
  tags: string[],
) {
  const config = tailscaleConfig(env)
  if (tags.length === 0)
    throw new Response('Tailscale tags are required for this request', { status: 500 })
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    scope,
    tags: tags.join(' '),
  })
  let response: Response
  try {
    response = await fetch(`${TAILSCALE_API}/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
    })
  } catch (error) {
    console.error('Tailscale OAuth token request failed:', describeError(error))
    throw new Response('Tailscale OAuth service is unreachable', { status: 502 })
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    console.error('Tailscale OAuth token request failed:', response.status, safeTailscaleMessage(body, config.clientSecret))
    throw new Response(JSON.stringify({
      error: 'Tailscale API error',
      tailscale: { status: response.status, message: safeTailscaleMessage(body, config.clientSecret) || response.statusText },
    }), { status: 502, headers: { 'content-type': 'application/json' } })
  }
  let data: { access_token?: string }
  try {
    data = await response.json() as { access_token?: string }
  } catch {
    throw new Response('Tailscale OAuth response is invalid', { status: 502 })
  }
  if (!data.access_token) throw new Response('Tailscale OAuth response did not contain an access token', { status: 502 })
  return { token: data.access_token, config }
}

async function tailscaleRequest<T>(
  env: Env,
  path: string,
  scope: TailscaleScope,
  tags: string[],
  init: RequestInit = {},
) {
  const { token } = await tailscaleAccessToken(env, scope, tags)
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  let response: Response
  try {
    response = await fetch(`${TAILSCALE_API}${path}`, { ...init, headers })
  } catch (error) {
    console.error(`Tailscale API ${init.method ?? 'GET'} ${path} request failed:`, describeError(error))
    throw new Response('Tailscale API is unreachable', { status: 502 })
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const message = safeTailscaleMessage(body, env.TAILSCALE_OAUTH_CLIENT_SECRET)
    console.error(`Tailscale API ${init.method ?? 'GET'} ${path} failed: ${response.status} ${message}`)
    throw new Response(JSON.stringify({
      error: 'Tailscale API error',
      tailscale: { status: response.status, message: message || response.statusText },
    }), { status: 502, headers: { 'content-type': 'application/json' } })
  }
  if (response.status === 204) return undefined as T
  const responseBody = await response.text()
  if (!responseBody.trim()) return undefined as T
  try {
    return JSON.parse(responseBody) as T
  } catch {
    throw new Response('Tailscale API returned invalid JSON', { status: 502 })
  }
}

function roleFor(user: UserRow): 'user' | 'admin' {
  return user.tailscale_role === 'admin' ? 'admin' : 'user'
}

function tailscaleTag(role: 'user' | 'admin') {
  return role === 'admin' ? 'tag:team-admin' : 'tag:team-user'
}

async function ensureTailscaleDeviceKeyExpiry(env: Env, nodeId: string, tag: string) {
  const encodedNodeId = encodeURIComponent(nodeId)
  await tailscaleRequest(env, `/device/${encodedNodeId}/key`, 'devices:core', [tag], {
    method: 'POST',
    body: JSON.stringify({ keyExpiryDisabled: false }),
  })
  const device = await tailscaleRequest<TailscaleDeviceKeyState>(
    env,
    `/device/${encodedNodeId}?fields=default`,
    'devices:core',
    [tag],
  )
  const expiresAt = device.expires ? Date.parse(device.expires) : NaN
  if (device.keyExpiryDisabled || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
    throw new Response('Tailscale device key expiry is disabled or unavailable; configure a finite Tailnet key duration', { status: 502 })
}

async function hashSecret(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function parseJsonBody(request: Request) {
  return request.json().catch(() => { throw new Response('Invalid JSON body', { status: 400 }) }) as Promise<Record<string, unknown>>
}

async function syncDeviceTag(env: Env, nodeId: string, tag: string) {
  return tailscaleRequest(env, `/device/${encodeURIComponent(nodeId)}/tags`, 'devices:core', [tag], {
    method: 'POST',
    body: JSON.stringify({ tags: [tag] }),
  })
}

async function handleDesktopTailscale(request: Request, env: Env, user: UserRow) {
  const role = roleFor(user)
  const tag = tailscaleTag(role)
  if (request.method === 'GET') {
    const rows = await env.TEAM_DB.prepare(
      'SELECT node_id, team_device_id, hostname, ipv4, ipv6, role, tag, online, last_seen, revoked_at FROM tailscale_devices WHERE access_subject = ?1 ORDER BY updated_at DESC',
    ).bind(user.access_subject).all()
    return json({ enabled: true, role, tag, devices: rows.results })
  }
  if (request.method === 'POST' && request.url.endsWith('/key')) {
    const body = await parseJsonBody(request)
    const configuredExpiry = Number(env.DEFAULT_TAILSCALE_KEY_EXPIRY_SECONDS)
    const defaultExpiry = Number.isFinite(configuredExpiry)
      && configuredExpiry >= TAILSCALE_KEY_MIN_EXPIRY_SECONDS
      && configuredExpiry <= TAILSCALE_KEY_MAX_EXPIRY_SECONDS
      ? Math.floor(configuredExpiry)
      : TAILSCALE_KEY_DEFAULT_EXPIRY_SECONDS
    const requestedExpiry = typeof body.expirySeconds === 'number' ? body.expirySeconds : defaultExpiry
    if (!Number.isFinite(requestedExpiry) || requestedExpiry < TAILSCALE_KEY_MIN_EXPIRY_SECONDS || requestedExpiry > TAILSCALE_KEY_MAX_EXPIRY_SECONDS)
      throw new Response(`Tailscale auth key expiry must be between ${TAILSCALE_KEY_MIN_EXPIRY_SECONDS} and ${TAILSCALE_KEY_MAX_EXPIRY_SECONDS} seconds`, { status: 400 })
    const expirySeconds = Math.floor(requestedExpiry)
    const teamDeviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : null
    const hostname = typeof body.hostname === 'string' ? body.hostname.trim().slice(0, 255) : null
    const config = tailscaleConfig(env)
    const result = await tailscaleRequest<TailscaleKeyResponse>(env, `/tailnet/${encodeURIComponent(config.tailnetId)}/keys`, 'auth_keys', [tag], {
      method: 'POST',
      body: JSON.stringify({ capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: [tag] } } }, expirySeconds }),
    })
    const issuedAt = Math.floor(Date.now() / 1000)
    if (!result.id || !result.key || !result.created || !result.expires)
      throw new Response('Tailscale auth key response is invalid', { status: 502 })
    const expiresAt = Math.floor(Date.parse(result.expires) / 1000)
    if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt)
      throw new Response('Tailscale auth key response has an invalid expiry', { status: 502 })
    // Strict lifetime guarantee: refuse keys whose actual expiry outlives the
    // requested window (small tolerance for clock skew), so no unbounded or
    // unexpectedly long-lived key is ever handed to a client.
    if (expiresAt > issuedAt + expirySeconds + 300)
      throw new Response('Tailscale issued an auth key that outlives the requested expiry', { status: 502 })
    await env.TEAM_DB.prepare(
      'INSERT INTO tailscale_key_issuances (id, access_subject, team_device_id, key_hash, role, tag, issued_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
    ).bind(crypto.randomUUID(), user.access_subject, teamDeviceId, await hashSecret(result.key), role, tag, issuedAt, expiresAt).run()
    await audit(env, user, 'tailscale_key_issued')
    return json({ key: result.key, issuedAt, expiresAt, role, tag, deviceId: teamDeviceId, hostname })
  }
  if (request.method === 'POST' && request.url.endsWith('/reconcile')) {
    const body = await parseJsonBody(request)
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId : ''
    if (!/^[A-Za-z0-9:_-]{4,128}$/.test(nodeId)) return json({ error: 'nodeId is required' }, 400)
    const addresses = Array.isArray(body.addresses) ? body.addresses.filter((v): v is string => typeof v === 'string') : []
    const hostname = typeof body.hostname === 'string' ? body.hostname.slice(0, 255) : null
    const teamDeviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : null
    await ensureTailscaleDeviceKeyExpiry(env, nodeId, tag)
    await env.TEAM_DB.prepare(
      `INSERT INTO tailscale_devices (node_id, access_subject, team_device_id, hostname, ipv4, ipv6, role, tag, online, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)
       ON CONFLICT(node_id) DO UPDATE SET access_subject=?2, team_device_id=?3, hostname=?4, ipv4=?5, ipv6=?6, role=?7, tag=?8, online=1, last_seen=?9, updated_at=CURRENT_TIMESTAMP, revoked_at=NULL`,
    ).bind(nodeId, user.access_subject, teamDeviceId, hostname, addresses[0] ?? null, addresses[1] ?? null, role, tag, Math.floor(Date.now() / 1000)).run()
    // Auth keys are one-time credentials. Once the client reconciles its
    // device, retain only the non-recoverable issuance metadata and mark the
    // newest matching issuance as used.
    if (teamDeviceId) {
      // Mark older active nodes for the same teamDeviceId as offline
      await env.TEAM_DB.prepare(
        'UPDATE tailscale_devices SET online = 0, updated_at = CURRENT_TIMESTAMP WHERE access_subject = ?1 AND team_device_id = ?2 AND node_id != ?3 AND online = 1',
      ).bind(user.access_subject, teamDeviceId, nodeId).run()

      await env.TEAM_DB.prepare(
        `UPDATE tailscale_key_issuances
            SET used_at = COALESCE(used_at, ?1)
          WHERE id = (
            SELECT id FROM tailscale_key_issuances
             WHERE access_subject = ?2 AND team_device_id = ?3
             ORDER BY issued_at DESC LIMIT 1
          )`,
      ).bind(Math.floor(Date.now() / 1000), user.access_subject, teamDeviceId).run()
    }
    return json({ ok: true, nodeId, role, tag })
  }
  if (request.method === 'POST' && request.url.endsWith('/logout')) {
    const body = await parseJsonBody(request)
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId : null
    if (nodeId) await env.TEAM_DB.prepare('UPDATE tailscale_devices SET online=0, last_seen=?1, updated_at=CURRENT_TIMESTAMP WHERE node_id=?2 AND access_subject=?3').bind(Math.floor(Date.now() / 1000), nodeId, user.access_subject).run()
    return json({ ok: true })
  }
  return json({ error: 'Not found' }, 404)
}

async function requireAdmin(identity: JWTPayload, env: Env) {
  if (!env.ADMIN_EMAIL?.trim())
    throw new Response('ADMIN_EMAIL is not configured', { status: 503 })
  const email = typeof identity.email === 'string' ? identity.email.trim() : ''
  if (email.toLowerCase() !== env.ADMIN_EMAIL.trim().toLowerCase())
    throw new Response('Administrator access required', { status: 403 })
}

async function syncFromCasdoor(
  env: Env,
  endpointOverride?: string,
  clientIdOverride?: string,
  clientSecretOverride?: string,
  orgOverride?: string,
): Promise<{ synced: number; total: number }> {
  const endpoint = (endpointOverride || env.CASDOOR_ENDPOINT || '').trim().replace(/\/$/, '')
  const clientId = (clientIdOverride || env.CASDOOR_CLIENT_ID || '').trim()
  const clientSecret = (clientSecretOverride || env.CASDOOR_CLIENT_SECRET || '').trim()

  if (!clientId || !clientSecret) {
    throw new Response(
      JSON.stringify({ error: '请在 Worker 环境变量中配置 CASDOOR_CLIENT_ID 和 CASDOOR_CLIENT_SECRET' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )
  }
  const org = (orgOverride || env.CASDOOR_ORGANIZATION || 'built-in').trim()

  if (!endpoint) {
    throw new Response(
      JSON.stringify({ error: 'Casdoor 服务地址未填写（例如 https://door.example.com）' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }

  const authHeader = `Basic ${btoa(`${clientId}:${clientSecret}`)}`
  const url = `${endpoint}/api/get-users?owner=${encodeURIComponent(org)}`
  let response: Response
  try {
    response = await fetch(url, {
      headers: { authorization: authHeader },
    })
  } catch (error) {
    console.error('Casdoor fetch users failed:', describeError(error))
    throw new Response(
      JSON.stringify({ error: `无法连接 Casdoor (${endpoint})` }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )
  }

  if (!response.ok) {
    throw new Response(
      JSON.stringify({ error: `Casdoor API 返回错误 (HTTP ${response.status})` }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )
  }

  const data = (await response.json()) as {
    status: string
    data: Array<{ name: string; displayName?: string; email?: string; firstName?: string; lastName?: string }>
  }

  if (data.status !== 'ok' || !Array.isArray(data.data)) {
    throw new Response(
      JSON.stringify({ error: 'Casdoor API 返回数据格式不符合预期' }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )
  }

  let synced = 0
  for (const u of data.data) {
    let realName = u.displayName?.trim() || ''
    if (!realName && u.firstName && u.lastName) {
      const hasCJK = /[\u4e00-\u9fa5]/.test(u.firstName) || /[\u4e00-\u9fa5]/.test(u.lastName)
      realName = hasCJK ? `${u.lastName.trim()}${u.firstName.trim()}` : `${u.firstName.trim()} ${u.lastName.trim()}`
    }
    if (!realName) realName = u.name?.trim() || ''
    if (!realName) continue
    const email = u.email?.trim().toLowerCase()
    const name = u.name?.trim().toLowerCase()
    if (email) {
      const res = await env.TEAM_DB.prepare(
        'UPDATE users SET display_name = ?1, updated_at = CURRENT_TIMESTAMP WHERE lower(email) = ?2',
      )
        .bind(realName, email)
        .run()
      if (res.meta.changes > 0) synced++
    }
    if (name) {
      const res = await env.TEAM_DB.prepare(
        'UPDATE users SET display_name = ?1, updated_at = CURRENT_TIMESTAMP WHERE lower(email) LIKE ?2 AND display_name = email',
      )
        .bind(realName, `${name}@%`)
        .run()
      if (res.meta.changes > 0) synced++
    }
  }

  return { synced, total: data.data.length }
}

async function handleAdminUsers(request: Request, env: Env, identity: JWTPayload, currentUser: UserRow) {
  await requireAdmin(identity, env)
  const url = new URL(request.url)
  if (request.method === 'GET') {
    const search = url.searchParams.get('search')?.trim() ?? ''
    const selectUsers = `SELECT access_subject, email, display_name, enabled,
                                COALESCE(tailscale_role, 'user') AS tailscale_role
                           FROM users`
    const rows = search
      ? await env.TEAM_DB.prepare(`${selectUsers}
                         WHERE lower(COALESCE(email, '')) LIKE ?1
                            OR lower(COALESCE(display_name, '')) LIKE ?1
                         ORDER BY lower(COALESCE(display_name, '')), lower(COALESCE(email, ''))`).bind(`%${search.toLowerCase()}%`).all<UserRow>()
      : await env.TEAM_DB.prepare(`${selectUsers}
                         ORDER BY lower(COALESCE(display_name, '')), lower(COALESCE(email, ''))`).all<UserRow>()
    const users = await Promise.all(rows.results.map(async (row) => {
      const devices = await env.TEAM_DB.prepare('SELECT node_id AS nodeId, hostname, role, tag, online, last_seen AS lastSeen, revoked_at AS revokedAt FROM tailscale_devices WHERE access_subject=?1 AND revoked_at IS NULL ORDER BY online DESC, updated_at DESC').bind(row.access_subject).all()
      const latestKey = await env.TEAM_DB.prepare(
        `SELECT issued_at AS issuedAt, expires_at AS expiresAt, role, tag,
                revoked_at AS revokedAt, used_at AS usedAt
           FROM tailscale_key_issuances
          WHERE access_subject = ?1
          ORDER BY issued_at DESC
          LIMIT 1`,
      ).bind(row.access_subject).first<{
        issuedAt: number
        expiresAt: number
        role: 'user' | 'admin'
        tag: string
        revokedAt: number | null
        usedAt: number | null
      }>()
      return {
        accessSubject: row.access_subject,
        email: row.email,
        displayName: row.display_name,
        enabled: row.enabled === 1,
        tailscaleRole: row.tailscale_role,
        devices: devices.results,
        latestKey: latestKey
          ? {
              issuedAt: latestKey.issuedAt,
              expiresAt: latestKey.expiresAt,
              role: latestKey.role,
              tag: latestKey.tag,
              revoked: latestKey.revokedAt !== null,
              used: latestKey.usedAt !== null,
            }
          : null,
      }
    }))
    return json({ users })
  }
  if (request.method === 'POST' && url.pathname.endsWith('/sync-casdoor')) {
    const body = await parseJsonBody(request).catch(() => ({} as Record<string, unknown>))
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : undefined
    const org = typeof body.org === 'string' ? body.org : undefined
    const outcome = await syncFromCasdoor(env, endpoint, undefined, undefined, org)
    return json({ ok: true, ...outcome })
  }
  const match = url.pathname.match(/^\/v1\/admin\/users\/([^/]+)(?:\/role)?$/)
  if (request.method === 'PATCH' && match) {
    const subject = decodeURIComponent(match[1])
    const body = await parseJsonBody(request)
    const role = body.role === 'admin' ? 'admin' : body.role === 'user' ? 'user' : null
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : undefined
    const row = await env.TEAM_DB.prepare('SELECT access_subject, email, display_name, team_name, enabled, quota_upload, quota_download, quota_total, quota_expire, COALESCE(tailscale_role,\'user\') AS tailscale_role FROM users WHERE access_subject=?1').bind(subject).first<UserRow>()
    if (!row) return json({ error: 'User not found' }, 404)
    if (role && role !== row.tailscale_role) {
      await env.TEAM_DB.prepare('UPDATE users SET tailscale_role=?1, updated_at=CURRENT_TIMESTAMP WHERE access_subject=?2').bind(role, subject).run()
      const tag = tailscaleTag(role)
      const devices = await env.TEAM_DB.prepare('SELECT node_id FROM tailscale_devices WHERE access_subject=?1 AND revoked_at IS NULL').bind(subject).all<{ node_id: string }>()
      for (const device of devices.results) {
        try { await syncDeviceTag(env, device.node_id, tag) } catch (error) { console.error('failed to sync tag on role change:', describeError(error)) }
      }
      await audit(env, currentUser, `tailscale_role_changed:${role}`)
    }
    if (displayName !== undefined && displayName !== row.display_name) {
      await env.TEAM_DB.prepare('UPDATE users SET display_name=?1, updated_at=CURRENT_TIMESTAMP WHERE access_subject=?2').bind(displayName || null, subject).run()
      await audit(env, currentUser, `display_name_updated:${displayName}`)
    }
    return json({ ok: true })
  }
  const revokeMatch = url.pathname.match(/^\/v1\/admin\/devices\/([^/]+)$/)
  if (request.method === 'DELETE' && revokeMatch) {
    const nodeId = decodeURIComponent(revokeMatch[1])
    const device = await env.TEAM_DB.prepare('SELECT node_id, access_subject, team_device_id, role FROM tailscale_devices WHERE node_id=?1').bind(nodeId).first<{ node_id: string; access_subject: string; team_device_id: string | null; role: 'user' | 'admin' }>()
    if (device) {
      try {
        await tailscaleRequest(env, `/device/${encodeURIComponent(nodeId)}`, 'devices:core', [tailscaleTag(device.role === 'admin' ? 'admin' : 'user')], { method: 'DELETE' })
      } catch (error) {
        console.warn(`Tailscale API delete device ${nodeId} failed:`, describeError(error))
      }
      if (device.team_device_id) {
        const remainingDevice = await env.TEAM_DB.prepare(
          `SELECT 1 FROM tailscale_devices
            WHERE access_subject = ?1 AND team_device_id = ?2
              AND node_id != ?3 AND revoked_at IS NULL
            LIMIT 1`,
        ).bind(device.access_subject, device.team_device_id, nodeId).first()
        if (!remainingDevice) {
          await env.TEAM_DB.prepare(
            `UPDATE tailscale_key_issuances
                SET revoked_at = COALESCE(revoked_at, ?1)
              WHERE access_subject = ?2 AND team_device_id = ?3
                AND used_at IS NOT NULL`,
          ).bind(Math.floor(Date.now() / 1000), device.access_subject, device.team_device_id).run()
        }
      }
    }
    await env.TEAM_DB.prepare('DELETE FROM tailscale_devices WHERE node_id=?1').bind(nodeId).run()
    await audit(env, currentUser, 'tailscale_device_revoked')
    return json({ ok: true, nodeId })
  }
  return json({ error: 'Not found' }, 404)
}

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

  // Machine-to-machine resource pushes use only ADMIN_API_TOKEN. Keep this
  // branch ahead of Access authentication so the token is never parsed as a
  // Cloudflare Access JWT and does not require an Access identity or D1 user.
  if (request.method === 'PUT' && url.pathname === '/v1/admin/resource')
    return handleAdminResourcePut(request, env)

  const bearer = request.headers.get('authorization')
  const assertion =
    request.headers.get('cf-access-jwt-assertion') ??
    (bearer?.toLowerCase().startsWith('bearer ') ? bearer.slice(7).trim() : null)
  const headersProfile = extractHeadersProfile(request)
  const identity = await authenticate(request, env)
  const identityDetails = assertion && env.TEAM_DOMAIN
    ? await fetchAccessIdentity(normalizedIssuer(env.TEAM_DOMAIN), new URL(request.url).origin, assertion)
    : null
  const combinedDetails = { ...headersProfile, ...(identityDetails || {}) }
  try {
    await ensureSchema(env)
  } catch (error) {
    console.error('database schema init failed:', describeError(error))
    return json({ error: 'Database schema initialization failed' }, 560)
  }
  let user: UserRow | null
  try {
    user = await getUser(env, identity, combinedDetails)
    // Access is the membership gate: provision on first login instead of
    // requiring a manual D1 INSERT. users.enabled = 0 stays the kill switch.
    user ??= await provisionUser(env, identity, combinedDetails)
  } catch (error) {
    console.error('user lookup/provision failed:', describeError(error))
    return json({ error: 'User lookup or provisioning failed' }, 561)
  }
  requireEnabledUser(user)

  if (url.pathname === '/admin') {
    await requireAdmin(identity, env)
    return new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' } })
  }

  if (url.pathname.startsWith('/v1/admin/users') || url.pathname.startsWith('/v1/admin/devices/'))
    return handleAdminUsers(request, env, identity, user)

  if (url.pathname.startsWith('/v1/desktop/tailscale'))
    return handleDesktopTailscale(request, env, user)

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
