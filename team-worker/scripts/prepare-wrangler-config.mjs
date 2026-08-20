import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const output = path.resolve(
  process.env.WRANGLER_CONFIG_OUTPUT ||
    path.join(workerRoot, 'wrangler.generated.toml'),
)

const value = (name, fallback = '') => (process.env[name] ?? fallback).trim()
const isPlaceholder = (text) =>
  /(?:YOUR[-_]|REPLACE_|CHANGE[-_]?ME)/i.test(text)
// TEAM_DOMAIN and ACCESS_AUD are optional: when omitted, keep_vars in the
// generated config preserves the dashboard-managed variables on deploy.
const required = ['D1_DATABASE_ID', 'KV_NAMESPACE_ID']

const missing = required.filter((name) => {
  const current = value(name)
  return !current || isPlaceholder(current)
})

if (missing.length > 0) {
  console.error(
    `Missing or placeholder deployment variables: ${missing.join(', ')}`,
  )
  process.exit(1)
}

const teamDomain = value('TEAM_DOMAIN').replace(/\/$/, '')
const accessAud = value('ACCESS_AUD')
const customDomainValue = value('WORKER_CUSTOM_DOMAIN')
const customDomain = isPlaceholder(customDomainValue)
  ? ''
  : customDomainValue.replace(/\/$/, '')
const workerName = value('WORKER_NAME', 'clash-verge-rev')
const accountId = value('CLOUDFLARE_ACCOUNT_ID')
const databaseName = value('D1_DATABASE_NAME', 'clash-verge-team')
const previewValue = value('KV_PREVIEW_NAMESPACE_ID')
const kvPreviewId =
  !previewValue || isPlaceholder(previewValue)
    ? value('KV_NAMESPACE_ID')
    : previewValue

let customDomainHostname = ''
try {
  if (teamDomain && !isPlaceholder(teamDomain)) {
    const teamDomainUrl = new URL(teamDomain)
    if (
      teamDomainUrl.protocol !== 'https:' ||
      teamDomainUrl.pathname !== '/' ||
      teamDomainUrl.search ||
      teamDomainUrl.hash ||
      teamDomainUrl.username ||
      teamDomainUrl.password
    ) {
      throw new Error('TEAM_DOMAIN must be an HTTPS origin without a path')
    }
  }
  if (customDomain) {
    const customDomainUrl = new URL(customDomain)
    if (
      customDomainUrl.protocol !== 'https:' ||
      customDomainUrl.pathname !== '/' ||
      customDomainUrl.search ||
      customDomainUrl.hash
    ) {
      throw new Error(
        'WORKER_CUSTOM_DOMAIN must be an HTTPS origin without a path',
      )
    }
    customDomainHostname = customDomainUrl.hostname
  }
} catch (error) {
  console.error(
    `TEAM_DOMAIN or WORKER_CUSTOM_DOMAIN is not a valid URL: ${error.message}`,
  )
  process.exit(1)
}

const toml = (text) => JSON.stringify(String(text))
const managedVars = [
  ...(teamDomain && !isPlaceholder(teamDomain)
    ? [`TEAM_DOMAIN = ${toml(teamDomain)}`]
    : []),
  ...(accessAud && !isPlaceholder(accessAud)
    ? [`ACCESS_AUD = ${toml(accessAud)}`]
    : []),
]

const lines = [
  `name = ${toml(workerName)}`,
  ...(accountId ? [`account_id = ${toml(accountId)}`] : []),
  'main = "src/index.ts"',
  'compatibility_date = "2026-08-20"',
  `workers_dev = ${customDomain ? 'false' : 'true'}`,
  'keep_vars = true',
  '',
  // DEFAULT_TEAM_NAME / CACHE_TTL_SECONDS have in-code defaults and live in
  // the dashboard; repo-managed [vars] entries would overwrite dashboard
  // values on every deploy even with keep_vars.
  ...(managedVars.length ? ['[vars]', ...managedVars, ''] : []),
  '[[d1_databases]]',
  'binding = "TEAM_DB"',
  `database_name = ${toml(databaseName)}`,
  `database_id = ${toml(value('D1_DATABASE_ID'))}`,
  'migrations_dir = "migrations"',
  '',
  '[[kv_namespaces]]',
  'binding = "RESOURCE_CACHE"',
  `id = ${toml(value('KV_NAMESPACE_ID'))}`,
  `preview_id = ${toml(kvPreviewId)}`,
]

if (customDomainHostname) {
  lines.push(
    '',
    '[[routes]]',
    `pattern = ${toml(customDomainHostname)}`,
    'custom_domain = true',
  )
}

if (
  !teamDomain ||
  isPlaceholder(teamDomain) ||
  !accessAud ||
  isPlaceholder(accessAud)
) {
  console.log(
    'TEAM_DOMAIN/ACCESS_AUD not provided; deploy keeps dashboard-managed variables (keep_vars).',
  )
}
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, `${lines.join('\n')}\n`, 'utf8')
console.log(`Wrote ${output}`)
