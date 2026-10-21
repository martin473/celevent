#!/usr/bin/env node
// Reads lcov.info (written by `npm run test:coverage`) and prints line coverage.
// Writes coverage.json in shields.io "endpoint" format, which CI publishes to
// the `badges` branch so the README badge shows the number CI measured.
import { readFileSync, writeFileSync } from 'node:fs'

const lcov = readFileSync(process.argv[2] ?? 'lcov.info', 'utf8')
let found = 0
let hit = 0
for (const line of lcov.split('\n')) {
  if (line.startsWith('LF:')) found += Number(line.slice(3))
  if (line.startsWith('LH:')) hit += Number(line.slice(3))
}
if (!found) {
  console.error('no line data in lcov.info')
  process.exit(1)
}
const pct = (hit / found) * 100
const color = pct >= 90 ? 'brightgreen' : pct >= 80 ? 'green' : pct >= 70 ? 'yellow' : 'red'
writeFileSync('coverage.json', JSON.stringify({
  schemaVersion: 1,
  label: 'coverage',
  message: `${pct.toFixed(1)}%`,
  color,
}) + '\n')
console.log(`line coverage: ${pct.toFixed(1)}% (${hit}/${found} lines)`)
