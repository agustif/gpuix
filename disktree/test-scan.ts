#!/usr/bin/env node
/**
 * Test disktree scan() with heap measurement and limits.
 *
 * Usage:
 *   node --max-old-space-size=512 test-scan.ts /path/to/directory
 *   node --heap-prof test-scan.ts /path/to/directory
 *
 * Reports actual peak heap usage and whether scan completes.
 */

import { scan, type ScanProgress } from './src/core.ts'

const targetDir = process.argv[2] || process.cwd()

async function main() {
  console.log(`Testing scan on: ${targetDir}\n`)

  // Force GC before starting
  if (global.gc) {
    global.gc()
  }

  const startHeap = process.memoryUsage().heapUsed
  const startTime = Date.now()

  let peakHeap = startHeap
  const progress: ScanProgress = { files: 0, dirs: 0, bytes: 0, errors: 0 }

  // Monitor heap every 100ms
  const monitor = setInterval(() => {
    const current = process.memoryUsage().heapUsed
    if (current > peakHeap) {
      peakHeap = current
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(
      `[${elapsed}s] ` +
        `dirs: ${progress.dirs.toLocaleString()} | ` +
        `files: ${progress.files.toLocaleString()} | ` +
        `heap: ${(current / (1024 * 1024)).toFixed(1)} MB (peak: ${(peakHeap / (1024 * 1024)).toFixed(1)} MB)`,
    )
  }, 100)

  try {
    const tree = await scan(targetDir, { includeHidden: true, progress })
    clearInterval(monitor)

    if (global.gc) {
      global.gc()
    }
    const finalHeap = process.memoryUsage().heapUsed

    const elapsed = (Date.now() - startTime) / 1000
    const heapGrowth = peakHeap - startHeap

    console.log('\n✓ Scan completed successfully')
    console.log(`\nResults:`)
    console.log(`  Directories: ${tree.dirs.toLocaleString()}`)
    console.log(`  Files: ${tree.files.toLocaleString()}`)
    console.log(`  Bytes: ${(tree.bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`)
    console.log(`  Errors: ${progress.errors.toLocaleString()}`)
    console.log(`\nMemory:`)
    console.log(`  Start heap: ${(startHeap / (1024 * 1024)).toFixed(1)} MB`)
    console.log(`  Peak heap: ${(peakHeap / (1024 * 1024)).toFixed(1)} MB`)
    console.log(`  Final heap: ${(finalHeap / (1024 * 1024)).toFixed(1)} MB`)
    console.log(`  Growth: ${(heapGrowth / (1024 * 1024)).toFixed(1)} MB`)
    console.log(`\nPerformance:`)
    console.log(`  Time: ${elapsed.toFixed(1)}s`)
    console.log(`  Rate: ${(tree.dirs / elapsed).toFixed(0)} dirs/s`)

    process.exit(0)
  } catch (error) {
    clearInterval(monitor)
    const elapsed = (Date.now() - startTime) / 1000
    const heapGrowth = peakHeap - startHeap

    console.error('\n✗ Scan failed')
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`)
    console.error(`\nPartial results:`)
    console.error(`  Directories: ${progress.dirs.toLocaleString()}`)
    console.error(`  Files: ${progress.files.toLocaleString()}`)
    console.error(`\nMemory at failure:`)
    console.error(`  Start heap: ${(startHeap / (1024 * 1024)).toFixed(1)} MB`)
    console.error(`  Peak heap: ${(peakHeap / (1024 * 1024)).toFixed(1)} MB`)
    console.error(`  Growth: ${(heapGrowth / (1024 * 1024)).toFixed(1)} MB`)
    console.error(`  Time: ${elapsed.toFixed(1)}s`)

    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
