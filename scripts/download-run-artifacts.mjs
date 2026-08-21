// Downloads every artifact of a workflow run into a flat directory.
//
// `gh run download` / actions/download-artifact assume every artifact is a
// zip; this repository uploads installers with `archive: false`, which the
// artifacts API serves as raw bytes, so those tools fail with "not a valid
// zip file". This script sniffs the PK zip magic instead: zipped artifacts
// are extracted, raw artifacts are written as single files named after the
// artifact itself. Each artifact download retries transient blob failures.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [runId, outDir = 'release-assets'] = process.argv.slice(2)
const repo = process.env.GITHUB_REPOSITORY
const token = process.env.GH_TOKEN
if (!runId || !repo || !token)
  throw new Error('usage: GH_TOKEN=… GITHUB_REPOSITORY=owner/repo node download-run-artifacts.mjs <runId> [outDir]')

mkdirSync(outDir, { recursive: true })

const api = async (url) => {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`)
  return response
}

const listing = await api(
  `https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
)
const { artifacts } = await listing.json()
if (!artifacts?.length) throw new Error(`no artifacts found for run ${runId}`)

for (const artifact of artifacts) {
  if (artifact.expired) continue
  let buffer
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      buffer = Buffer.from(await (await api(artifact.archive_download_url)).arrayBuffer())
      break
    } catch (error) {
      console.log(`download attempt ${attempt} failed for ${artifact.name}: ${error.message}`)
      if (attempt === 3) throw error
      await new Promise((resolve) => setTimeout(resolve, 10_000))
    }
  }
  const isZip = buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b
  if (isZip) {
    const zipPath = join(outDir, `${artifact.name}.zip`)
    writeFileSync(zipPath, buffer)
    // bsdtar ships with Windows; ubuntu runners have unzip. The zipped
    // artifacts here are already flat, so no path junking is needed.
    if (process.platform === 'win32') {
      execFileSync('tar', ['-xf', zipPath, '-C', outDir], { stdio: 'inherit' })
    } else {
      execFileSync('unzip', ['-o', zipPath, '-d', outDir], { stdio: 'inherit' })
    }
    rmSync(zipPath)
  } else {
    writeFileSync(join(outDir, artifact.name), buffer)
  }
  console.log(`artifact ready: ${artifact.name} (${buffer.length} bytes)`)
}
