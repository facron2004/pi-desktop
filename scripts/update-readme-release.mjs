#!/usr/bin/env node
/**
 * 把 README 里的发布版本改到新版本。
 *
 * README 的下载链接写死了版本号（`releases/download/v0.11.6/...`），发布新版本时
 * 必须一起改，否则链接会指向旧的包。CI 在发布成功后调用这个脚本。
 *
 * 只动 README：CHANGELOG 和版本说明由发布者自己写。
 *
 *   node scripts/update-readme-release.mjs 0.11.7
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readmePath = path.join(root, 'README.md')

const version = (process.argv[2] ?? '').trim().replace(/^v/, '')
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法：node scripts/update-readme-release.mjs <版本号，例如 0.11.7>')
  process.exit(1)
}

const text = readFileSync(readmePath, 'utf8')

// README 里版本号出现在三个地方：下载链接、版本说明链接、当前发布版本。
const patterns = [
  /releases\/download\/v(\d+\.\d+\.\d+)\//g,
  /docs\/releases\/v(\d+\.\d+\.\d+)\.md/g,
  /当前发布版本为 \*\*v(\d+\.\d+\.\d+)\*\*/g
]
const found = new Set()
for (const pattern of patterns) {
  for (const match of text.matchAll(pattern)) {
    found.add(match[1])
  }
}

if (found.size === 0) {
  console.error('README 里找不到发布版本号，无法确定要替换哪一个')
  process.exit(1)
}
if (found.size > 1) {
  console.error(`README 里出现了多个版本号：${[...found].join(', ')}，请手工检查`)
  process.exit(1)
}

const current = [...found][0]
if (current === version) {
  console.log(`README 已经指向 v${version}，没有改动`)
  process.exit(0)
}
if (compareVersions(current, version) > 0) {
  console.error(`README 已经指向 v${current}，比要发布的 v${version} 更新，不回退`)
  process.exit(1)
}

// 只替换独立出现的版本号：前面不能是数字或小数点，后面不能是数字。
const pattern = new RegExp(`(?<![\\d.])${current.replace(/\./g, '\\.')}(?!\\d)`, 'g')
const updated = text.replace(pattern, version)
writeFileSync(readmePath, updated, 'utf8')
console.log(`README：v${current} → v${version}`)

function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}
