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

  const findDatabase = () =>
    JSON.parse(wrangler('d1 list --json')).find(
      (db) => db.name === databaseName,
    )

  let id = (findDatabase() || {}).uuid
  if (id) {
    console.log(`[ensure] reusing D1 database "${databaseName}" (${id})`)
  } else {
    const out = wrangler(`d1 create ${databaseName}`)
    id = parseCreatedId(out, 'database_id', 36) || (findDatabase() || {}).uuid
    if (!id)
      throw new Error(
        `[ensure] could not determine the new database id from:\n${out}`,
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

  const canonicalTitle = normalize(`${workerName}-${KV_BINDING}`)
  const findNamespace = () =>
    JSON.parse(wrangler('kv namespace list')).find(
      (ns) => normalize(ns.title) === canonicalTitle,
    )

  let id = (findNamespace() || {}).id
  if (id) {
    console.log(`[ensure] reusing KV namespace "${canonicalTitle}" (${id})`)
  } else {
    // Wrangler prefixes the title with the worker name from wrangler.toml, so
    // pass the bare binding name and then re-list to learn the real title/id.
    const out = wrangler(`kv namespace create ${KV_BINDING}`)
    id = parseCreatedId(out, 'id', 32) || (findNamespace() || {}).id
    if (!id)
      throw new Error(
        `[ensure] could not determine the new namespace id from:\n${out}`,
      )
    console.log(`[ensure] created KV namespace "${canonicalTitle}" (${id})`)
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