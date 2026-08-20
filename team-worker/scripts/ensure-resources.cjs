#!/usr/bin/env node
/**
 * Make Git-connected deploys idempotent.
 *
 * D1 databases and KV namespaces are referenced by account-scoped ids, but the
 * committed wrangler.toml declares bindings by name only, so a fresh account
 * (for example a Cloudflare Workers Builds run on a fork) can provision
 * everything automatically. Before each deploy this script finds or creates
 * the resources, pins their ids into wrangler.toml for this build, and applies
 * any pending D1 migrations. Re-runs reuse existing resources, whether they
 * were created by a previous build or by hand in the Cloudflare dashboard.
 *
 * Inspired by NodeWarden's scripts/ensure-kv.cjs.
 */
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const CONFIG = path.resolve(__dirname, '..', 'wrangler.toml')
const D1_BINDING = 'TEAM_DB'
const KV_BINDING = 'RESOURCE_CACHE'

const wrangler = (args, { inherit = false } = {}) =>
  execSync(`npx wrangler ${args}`, {
    cwd: path.dirname(CONFIG),
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'inherit'],
  })

// KV titles differ only by separator/case depending on how they were created
// (wrangler prefixes "<worker-name>-" and keeps the binding's case).
const normalize = (text) => text.toLowerCase().replace(/_/g, '-')

const readBlock = (toml, header, binding) => {
  const blocks = toml.match(new RegExp(`\\[\\[${header}\\]\\][^[]*`, 'g')) || []
  return blocks.find((entry) =>
    new RegExp(`binding\\s*=\\s*"${binding}"`).test(entry),
  )
}

// Anchor to the line start so "preview_id" cannot satisfy a lookup for "id".
const parseCreatedId = (out, key, length) => {
  const match = out.match(
    new RegExp(`^\\s*${key}\\s*=\\s*"([0-9a-fA-F-]{${length}})"`, 'm'),
  )
  return match ? match[1] : undefined
}

function ensureD1(toml) {
  const block = readBlock(toml, 'd1_databases', D1_BINDING)
  if (!block)
    throw new Error(`[ensure] missing [[d1_databases]] binding ${D1_BINDING}`)
  if (/^\s*database_id\s*=/m.test(block)) {
    console.log(`[ensure] ${D1_BINDING} database_id already pinned`)
    return toml
  }
  const databaseName = (block.match(/database_name\s*=\s*"([^"]+)"/) || [])[1]
  if (!databaseName)
    throw new Error(`[ensure] ${D1_BINDING} requires a database_name`)

  const listDatabases = () =>
    JSON.parse(wrangler('d1 list --json')).filter(
      (db) => db.name === databaseName,
    )

  const matches = listDatabases()
  let id = (matches[0] || {}).uuid
  if (matches.length > 1) {
    console.log(
      `[ensure] WARNING: ${matches.length} D1 databases named "${databaseName}"` +
        ` (${matches.map((db) => db.uuid).join(', ')}); using ${id}`,
    )
  }
  if (id) {
    console.log(`[ensure] reusing D1 database "${databaseName}" (${id})`)
  } else {
    let out = ''
    try {
      out = wrangler(`d1 create ${databaseName}`)
    } catch {
      console.log('[ensure] d1 create failed; re-checking the list')
    }
    id = parseCreatedId(out, 'database_id', 36) || (listDatabases()[0] || {}).uuid
    if (!id)
      throw new Error(
        `[ensure] could not create or find D1 database "${databaseName}"`,
      )
    console.log(`[ensure] created D1 database "${databaseName}" (${id})`)
  }

  const pinned = block.replace(
    /database_name\s*=\s*"[^"]+"/,
    (line) => `${line}\ndatabase_id = "${id}"`,
  )
  return toml.replace(block, pinned)
}

function ensureKv(toml, workerName) {
  const block = readBlock(toml, 'kv_namespaces', KV_BINDING)
  if (!block)
    throw new Error(`[ensure] missing [[kv_namespaces]] binding ${KV_BINDING}`)
  if (/^\s*id\s*=/m.test(block)) {
    console.log(`[ensure] ${KV_BINDING} id already pinned`)
    return toml
  }

  // Accept the worker-prefixed title and the bare binding name, so a
  // namespace created by hand either way is reused instead of duplicated.
  const titles = new Set([
    normalize(`${workerName}-${KV_BINDING}`),
    normalize(KV_BINDING),
  ])
  const findNamespace = () =>
    JSON.parse(wrangler('kv namespace list')).find((ns) =>
      titles.has(normalize(ns.title)),
    )

  let id = (findNamespace() || {}).id
  if (id) {
    console.log(`[ensure] reusing KV namespace (${id})`)
  } else {
    let out = ''
    try {
      out = wrangler(`kv namespace create ${KV_BINDING}`)
    } catch {
      // Titles are unique per account; a conflict means the namespace exists
      // under an alias, so re-list before giving up.
      console.log('[ensure] kv create failed; re-checking the list')
    }
    id = parseCreatedId(out, 'id', 32) || (findNamespace() || {}).id
    if (!id) {
      const existing = JSON.parse(wrangler('kv namespace list'))
        .map((ns) => ns.title)
        .join(', ')
      throw new Error(
        '[ensure] could not create or find the KV namespace. ' +
          `Existing titles: ${existing || '(none)'}`,
      )
    }
    console.log(`[ensure] created KV namespace (${id})`)
  }

  const pinned = block.replace(
    new RegExp(`binding\\s*=\\s*"${KV_BINDING}"`),
    (line) => `${line}\nid = "${id}"`,
  )
  return toml.replace(block, pinned)
}

function main() {
  let toml = fs.readFileSync(CONFIG, 'utf8')
  const workerName =
    (toml.match(/^\s*name\s*=\s*"([^"]+)"/m) || [])[1] || 'worker'

  toml = ensureD1(toml)
  toml = ensureKv(toml, workerName)
  fs.writeFileSync(CONFIG, toml)
  console.log('[ensure] resource ids pinned into wrangler.toml')

  // Non-interactive environments skip the confirmation prompt automatically.
  // With nothing pending this exits quickly; failures abort the deploy.
  wrangler(`d1 migrations apply ${D1_BINDING} --remote`, { inherit: true })
}

main()