#!/usr/bin/env node
/**
 * Simplified scan test without workers to measure heap retention.
 * This lets us test just the tree-building memory usage.
 */

import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'

interface TreeNode {
  name: string
  dir: boolean
  bytes: number
  apparent: number
  files: number
  dirs: number
  modified: number
  children: TreeNode[]
}

function leaf(name: string, bytes: number, apparent: number, modified: number, files = 1): TreeNode {
  return {
    name,
    dir: false,
    bytes,
    apparent,
    files,
    dirs: 0,
    modified,
    children: [],
  }
}

function folder(name: string): TreeNode {
  return { ...leaf(name, 0, 0, 0, 0), dir: true }
}

const progress = { files: 0, dirs: 0, bytes: 0, errors: 0 }
const seen = new Set<string>()
const KEEP_FILES = 12 // Same as worker

function scanSync(fullPath: string): TreeNode {
  const node = folder(path.basename(fullPath))

  try {
    const stat = lstatSync(fullPath)
    if (!stat.isDirectory()) {
      return leaf(node.name, stat.blocks * 512, stat.size, stat.mtimeMs)
    }

    node.modified = stat.mtimeMs
    progress.dirs++

    const names = readdirSync(fullPath)
    const files: Array<[string, number, number, number, string]> = []
    const subdirs: string[] = []

    for (const name of names) {
      if (name.startsWith('.') && name !== '.pnpm-store') continue
      const child = path.join(fullPath, name)
      try {
        const st = lstatSync(child)
        if (st.isDirectory()) {
          subdirs.push(child)
          continue
        }
        const link = st.nlink > 1 ? `${st.dev}:${st.ino}` : ''
        files.push([name, st.blocks * 512, st.size, st.mtimeMs, link])
      } catch (e) {
        progress.errors++
      }
    }

    files.sort((a, b) => b[1] - a[1])

    // Keep top files
    for (let i = 0; i < Math.min(KEEP_FILES, files.length); i++) {
      const [name, blocks, size, mtime, link] = files[i]!
      let bytes = blocks
      let apparent = size
      if (link) {
        if (seen.has(link)) {
          bytes = 0
          apparent = 0
        } else {
          seen.add(link)
        }
      }
      node.children.push(leaf(name, bytes, apparent, mtime))
      progress.files++
      progress.bytes += bytes
    }

    // Fold remaining files
    if (files.length > KEEP_FILES) {
      const rest = files.slice(KEEP_FILES)
      let foldedBytes = 0
      let foldedApparent = 0
      let foldedMod = 0
      for (const [, blocks, size, mtime, link] of rest) {
        let bytes = blocks
        let apparent = size
        if (link) {
          if (seen.has(link)) {
            bytes = 0
            apparent = 0
          } else {
            seen.add(link)
          }
        }
        foldedBytes += bytes
        foldedApparent += apparent
        foldedMod = Math.max(foldedMod, mtime)
        progress.files++
        progress.bytes += bytes
      }
      node.children.push(leaf(`${rest.length} smaller files`, foldedBytes, foldedApparent, foldedMod, rest.length))
    }

    // Scan subdirs
    for (const subdir of subdirs) {
      node.children.push(scanSync(subdir))
    }

    // Aggregate
    let totalBytes = node.bytes
    let totalApparent = node.apparent
    let totalFiles = 0
    let totalDirs = 0
    let maxMod = node.modified

    for (const child of node.children) {
      totalBytes += child.bytes
      totalApparent += child.apparent
      totalFiles += child.files
      totalDirs += child.dir ? child.dirs + 1 : 0
      maxMod = Math.max(maxMod, child.modified)
    }

    node.bytes = totalBytes
    node.apparent = totalApparent
    node.files = totalFiles
    node.dirs = totalDirs
    node.modified = maxMod

    node.children.sort((a, b) => b.bytes - a.bytes)

    return node
  } catch (e) {
    progress.errors++
    return node
  }
}

const targetDir = process.argv[2] || process.cwd()

async function main() {
  console.log(`Testing scan on: ${targetDir}\n`)

  if (global.gc) global.gc()
  const startHeap = process.memoryUsage().heapUsed
  const startTime = Date.now()
  let peakHeap = startHeap

  const monitor = setInterval(() => {
    const current = process.memoryUsage().heapUsed
    if (current > peakHeap) peakHeap = current
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(
      `[${elapsed}s] ` +
        `dirs: ${progress.dirs.toLocaleString()} | ` +
        `files: ${progress.files.toLocaleString()} | ` +
        `heap: ${(current / (1024 * 1024)).toFixed(1)} MB (peak: ${(peakHeap / (1024 * 1024)).toFixed(1)} MB)`,
    )
  }, 200)

  try {
    const tree = scanSync(targetDir)
    clearInterval(monitor)

    if (global.gc) global.gc()
    const finalHeap = process.memoryUsage().heapUsed
    const elapsed = (Date.now() - startTime) / 1000
    const heapGrowth = peakHeap - startHeap

    console.log('\n✓ Scan completed successfully')
    console.log(`\nResults:`)
    console.log(`  Directories: ${tree.dirs.toLocaleString()}`)
    console.log(`  Files: ${tree.files.toLocaleString()}`)
    console.log(`  Bytes: ${(tree.bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`)
    console.log(`  seen Set size: ${seen.size.toLocaleString()}`)
    console.log(`\nMemory:`)
    console.log(`  Start heap: ${(startHeap / (1024 * 1024)).toFixed(1)} MB`)
    console.log(`  Peak heap: ${(peakHeap / (1024 * 1024)).toFixed(1)} MB`)
    console.log(`  Final heap: ${(finalHeap / (1024 * 1024)).toFixed(1)} MB`)
    console.log(`  Growth: ${(heapGrowth / (1024 * 1024)).toFixed(1)} MB`)
    console.log(`\nPerformance:`)
    console.log(`  Time: ${elapsed.toFixed(1)}s`)
    console.log(`  Rate: ${(tree.dirs / elapsed).toFixed(0)} dirs/s`)
  } catch (error) {
    clearInterval(monitor)
    console.error('\n✗ Scan failed:', error)
    process.exit(1)
  }
}

main()
