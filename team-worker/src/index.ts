import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

interface Env {
  TEAM_DB: D1Database
  RESOURCE_CACHE: KVNamespace
  TEAM_DOMAIN: string
  ACCESS_AUD: string
  DEFAULT_TEAM_NAME: string
  CACHE_TTL_SECONDS: string
  UPSTREAM_SUBSCRIPTION_URL: string
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

const normalizedIssuer = (teamDomain: string) => teamDomain.replace(/\/$/, '')

async function authenticate(request: Request, env: Env): Promise<JWTPayload> {
  const assertion = request.headers.get('cf-access-jwt-assertion')
  if (!assertion) throw new Response('Missing Cloudflare Access assertion', { status: 401 })

  const issuer = normalizedIssuer(env.TEAM_DOMAIN)
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))
  const { payload } = await jwtVerify(assertion, jwks, {
    issuer,
    audience: env.ACCESS_AUD,
  })
  return payload
}

async function getUser(env: Env, identity: JWTPayload): Promise<UserRow | null> {
  const subject = identity.sub
  const email = typeof identity.email === 'string' ? identity.email : undefined
  if (!subject) return null

  return env.TEAM_DB.prepare(
    `SELECT access_subject, email, display_name, team_name, enabled,
            quota_upload, quota_download, quota_total, quota_expire
       FROM users
      WHERE access_subject = ?1 OR (?2 IS NOT NULL AND email = ?2)
      LIMIT 1`,
  )
    .bind(subject, email ?? null)
    .first<UserRow>()
}

function requireEnabledUser(user: UserRow | null): asserts user is UserRow {
  if (!user) throw new Response('No team entitlement is assigned', { status: 403 })
  if (user.enabled !== 1) throw new Response('Team entitlement is disabled', { status: 403 })
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
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `"${hex}"`
}

async function fetchResource(env: Env): Promise<CachedResource> {
  const cacheKey = 'managed-profile:v1'
  const cached = await env.RESOURCE_CACHE.get<CachedResource>(cacheKey, 'json')
  if (cached) return cached

  if (!env.UPSTREAM_SUBSCRIPTION_URL) {
    throw new Response('UPSTREAM_SUBSCRIPTION_URL is not configured', { status: 503 })
  }
  const response = await fetch(env.UPSTREAM_SUBSCRIPTION_URL, {
    redirect: 'follow',
    headers: { 'user-agent': 'Clash-Verge-Team-Worker/0.1' },
  })
  if (!response.ok) throw new Response('Upstream resource is unavailable', { status: 502 })

  const body = await response.text()
  if (body.length > 10 * 1024 * 1024) {
    throw new Response('Upstream resource exceeds the 10 MiB limit', { status: 502 })
  }
  const resource: CachedResource = {
    body,
    etag: await sha256Etag(body),
    subscriptionUserinfo: response.headers.get('subscription-userinfo') ?? undefined,
    contentDisposition: response.headers.get('content-disposition') ?? undefined,
  }
  await env.RESOURCE_CACHE.put(cacheKey, JSON.stringify(resource), {
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

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url)
  if (url.pathname === '/healthz') return json({ ok: true })

  const identity = await authenticate(request, env)
  const user = await getUser(env, identity)
  requireEnabledUser(user)

  if (request.method === 'GET' && url.pathname === '/v1/desktop/account') {
    return json({
      userId: user.access_subject,
      email: user.email,
      displayName: user.display_name,
      team: user.team_name ?? env.DEFAULT_TEAM_NAME,
      enabled: true,
      quota: quota(user),
    })
  }

  if (request.method === 'GET' && url.pathname === '/v1/desktop/profile') {
    const resource = await fetchResource(env)
    const effectiveEtag = await sha256Etag(`${resource.etag}:${quotaHeader(user)}`)
    if (request.headers.get('if-none-match') === effectiveEtag) {
      return new Response(null, { status: 304, headers: { etag: effectiveEtag } })
    }
    ctx.waitUntil(audit(env, user, 'profile_download'))
    const headers = new Headers({
      'content-type': 'application/yaml; charset=utf-8',
      'cache-control': 'private, no-store',
      etag: effectiveEtag,
      'subscription-userinfo':
        user.quota_total !== null ? quotaHeader(user) : resource.subscriptionUserinfo ?? quotaHeader(user),
      'profile-update-interval': '6',
    })
    if (resource.contentDisposition) headers.set('content-disposition', resource.contentDisposition)
    return new Response(resource.body, { headers })
  }

  return json({ error: 'Not found' }, 404)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx)
    } catch (error) {
      if (error instanceof Response) return error
      console.error(error)
      return json({ error: 'Internal server error' }, 500)
    }
  },
} satisfies ExportedHandler<Env>
