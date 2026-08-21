// Builds the Tauri updater manifests (update.json + update-proxy.json) for
// the rolling team-latest release from the artifacts of the matrix build.
// Signatures are read from the local .sig files; download URLs are derived
// from the release tag, so no GitHub API reads are needed.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const assetsDir = process.argv[2] ?? 'release-assets'
const version = process.env.UPDATE_VERSION
const repo = process.env.GITHUB_REPOSITORY
const tag = process.env.RELEASE_TAG ?? 'team-latest'
if (!version || !repo) throw new Error('UPDATE_VERSION and GITHUB_REPOSITORY are required')

const files = readdirSync(assetsDir)
const platforms = {}
const add = (keys, file) => {
  const sigFile = file + '.sig'
  if (!files.includes(sigFile)) throw new Error('missing signature file: ' + sigFile)
  const signature = readFileSync(join(assetsDir, sigFile), 'utf8').trim()
  const url = 'https://github.com/' + repo + '/releases/download/' + tag + '/' + encodeURIComponent(file)
  for (const key of keys) platforms[key] = { signature, url }
}

for (const file of files) {
  if (file.endsWith('x64-setup.exe')) add(['windows-x86_64', 'windows-x86_64-nsis'], file)
  else if (file.endsWith('arm64-setup.exe')) add(['windows-aarch64', 'windows-aarch64-nsis'], file)
  else if (file.endsWith('.app.tar.gz')) add(['darwin-aarch64', 'darwin-aarch64-app'], file)
  else if (file.endsWith('amd64.deb')) add(['linux-x86_64', 'linux-x86_64-deb'], file)
}
if (Object.keys(platforms).length === 0) throw new Error('no updater artifacts found in ' + assetsDir)

const manifest = {
  name: version,
  notes: 'Lab Clash Verge team build ' + version,
  pub_date: new Date().toISOString(),
  platforms,
}
writeFileSync(join(assetsDir, 'update.json'), JSON.stringify(manifest, null, 2))

const proxied = JSON.parse(JSON.stringify(manifest))
for (const value of Object.values(proxied.platforms)) {
  value.url = 'https://gh-proxy.org/' + value.url
}
writeFileSync(join(assetsDir, 'update-proxy.json'), JSON.stringify(proxied, null, 2))
console.log('manifest ' + version + ': ' + Object.keys(platforms).join(', '))
