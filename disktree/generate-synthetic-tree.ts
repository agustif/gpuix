#!/usr/bin/env node
/**
 * Generate a synthetic directory tree resembling a large development environment:
 * - Millions of directories (node_modules-like structure)
 * - Many small files per directory
 * - pnpm-style store with hardlinked files
 *
 * Usage:
 *   node --loader tsx generate-synthetic-tree.ts <target-dir> [dirs=1000000]
 *
 * Example realistic Mac home with development work:
 * - ~/Library/Caches, ~/Library/Application Support (many small dirs)
 * - Multiple project directories with node_modules
 * - .pnpm-store with hardlinked packages
 * - .git object stores
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const args = process.argv.slice(2)
const targetDir = args[0] || '/tmp/disktree-synthetic'
const targetDirs = parseInt(args[1] || '1000000', 10)

console.log(`Generating synthetic tree at: ${targetDir}`)
console.log(`Target: ${targetDirs.toLocaleString()} directories\n`)

// Check if target is on tmpfs (for speed)
try {
  const mount = execSync(`df -T ${path.dirname(targetDir)} 2>/dev/null || df ${path.dirname(targetDir)}`)
    .toString()
    .split('\n')[1]
  console.log(`Mount: ${mount}`)
  if (!mount?.includes('tmpfs')) {
    console.warn('⚠ Not on tmpfs - generation will be slow. Consider mounting tmpfs first:')
    console.warn(`  sudo mkdir -p /mnt/ramdisk`)
    console.warn(`  sudo mount -t tmpfs -o size=2G tmpfs /mnt/ramdisk`)
    console.warn(`  node ... /mnt/ramdisk/disktree-synthetic\n`)
  }
} catch (e) {
  // Ignore mount check errors
}

fs.mkdirSync(targetDir, { recursive: true })

const startTime = Date.now()
let dirCount = 0
let fileCount = 0
let linkCount = 0

// Small reusable file content for hardlinking
const storeContent = Buffer.alloc(4096, 'x')
const storeFile = path.join(targetDir, '.store-original')
fs.writeFileSync(storeFile, storeContent)

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// Create node_modules-like structure: deep nesting, 5-30 files per dir
function createNodeModulesTree(base: string, depth: number, maxDepth: number, budget: { remaining: number }) {
  if (budget.remaining <= 0 || depth > maxDepth) return

  const numPackages = randomInt(3, 12)
  for (let i = 0; i < numPackages && budget.remaining > 0; i++) {
    const pkgDir = path.join(base, `pkg-${i}`)
    try {
      fs.mkdirSync(pkgDir, { recursive: true })
      dirCount++
      budget.remaining--

      // Add files
      const numFiles = randomInt(5, 30)
      for (let f = 0; f < numFiles; f++) {
        const filePath = path.join(pkgDir, `file-${f}.js`)
        fs.writeFileSync(filePath, Buffer.alloc(randomInt(100, 5000), 'a'))
        fileCount++
      }

      // 30% chance of nested node_modules
      if (Math.random() < 0.3 && depth < maxDepth) {
        const nestedModules = path.join(pkgDir, 'node_modules')
        fs.mkdirSync(nestedModules)
        dirCount++
        budget.remaining--
        createNodeModulesTree(nestedModules, depth + 1, maxDepth, budget)
      }
    } catch (e) {
      // May hit ENOSPC or other limits
      return
    }
  }
}

// Create pnpm-style store with hardlinks
function createPnpmStore(base: string, budget: { remaining: number }) {
  const storeDir = path.join(base, '.pnpm-store')
  fs.mkdirSync(storeDir, { recursive: true })
  dirCount++
  budget.remaining--

  // Create store packages (these will be hardlinked from projects)
  const numStorePackages = Math.min(5000, budget.remaining / 10)
  for (let i = 0; i < numStorePackages && budget.remaining > 0; i++) {
    const pkgHash = `pkg-${i.toString(16)}`
    const pkgDir = path.join(storeDir, pkgHash)
    try {
      fs.mkdirSync(pkgDir, { recursive: true })
      dirCount++
      budget.remaining--

      // Create some files that will be hardlinked
      const numFiles = randomInt(3, 15)
      for (let f = 0; f < numFiles; f++) {
        const filePath = path.join(pkgDir, `lib-${f}.js`)
        // Hardlink from the store file (simulates dedupe)
        try {
          fs.linkSync(storeFile, filePath)
          linkCount++
        } catch {
          // If hardlink fails, write a normal file
          fs.writeFileSync(filePath, storeContent.subarray(0, randomInt(1000, 4096)))
        }
        fileCount++
      }
    } catch (e) {
      return
    }

    if (i % 1000 === 0 && i > 0) {
      const elapsed = (Date.now() - startTime) / 1000
      const rate = dirCount / elapsed
      console.log(
        `  Store: ${i.toLocaleString()} packages, ` +
          `${dirCount.toLocaleString()} dirs, ` +
          `${linkCount.toLocaleString()} hardlinks, ` +
          `${rate.toFixed(0)} dirs/s`,
      )
    }
  }
}

// Create cache-like structure: shallow but many dirs
function createCacheStructure(base: string, budget: { remaining: number }) {
  const cacheDir = path.join(base, 'cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  dirCount++
  budget.remaining--

  // Many shallow dirs with few files each
  const numCacheDirs = Math.min(50000, budget.remaining / 2)
  for (let i = 0; i < numCacheDirs && budget.remaining > 0; i++) {
    const subDir = path.join(cacheDir, `cache-${i.toString(16)}`)
    try {
      fs.mkdirSync(subDir)
      dirCount++
      budget.remaining--

      // 2-5 files per cache dir
      const numFiles = randomInt(2, 5)
      for (let f = 0; f < numFiles; f++) {
        fs.writeFileSync(path.join(subDir, `blob-${f}`), Buffer.alloc(randomInt(1000, 10000), 'b'))
        fileCount++
      }
    } catch (e) {
      return
    }

    if (i % 10000 === 0 && i > 0) {
      const elapsed = (Date.now() - startTime) / 1000
      const rate = dirCount / elapsed
      console.log(`  Cache: ${i.toLocaleString()} dirs, ${rate.toFixed(0)} dirs/s`)
    }
  }
}

console.log('Phase 1: Creating pnpm store with hardlinks...')
const budget = { remaining: targetDirs }
createPnpmStore(targetDir, budget)

console.log('\nPhase 2: Creating node_modules trees...')
const numProjects = Math.min(100, budget.remaining / 10000)
for (let p = 0; p < numProjects && budget.remaining > 0; p++) {
  const projectDir = path.join(targetDir, `project-${p}`)
  fs.mkdirSync(projectDir, { recursive: true })
  dirCount++
  budget.remaining--

  const modulesDir = path.join(projectDir, 'node_modules')
  fs.mkdirSync(modulesDir)
  dirCount++
  budget.remaining--

  createNodeModulesTree(modulesDir, 0, 4, budget)

  if (p % 10 === 0) {
    const elapsed = (Date.now() - startTime) / 1000
    const rate = dirCount / elapsed
    console.log(
      `  Project ${p}: ${dirCount.toLocaleString()} dirs total, ` +
        `${fileCount.toLocaleString()} files, ${rate.toFixed(0)} dirs/s`,
    )
  }
}

console.log('\nPhase 3: Creating cache structure...')
createCacheStructure(targetDir, budget)

const elapsed = (Date.now() - startTime) / 1000
const totalSize = execSync(`du -sh ${targetDir} 2>/dev/null || echo "unknown"`).toString().trim().split(/\s+/)[0]

console.log('\n✓ Synthetic tree complete!')
console.log(`  Directories: ${dirCount.toLocaleString()}`)
console.log(`  Files: ${fileCount.toLocaleString()}`)
console.log(`  Hardlinks: ${linkCount.toLocaleString()}`)
console.log(`  Total size: ${totalSize}`)
console.log(`  Time: ${elapsed.toFixed(1)}s`)
console.log(`  Rate: ${(dirCount / elapsed).toFixed(0)} dirs/s`)
console.log(`\nTest with: node --max-old-space-size=512 test-scan.ts ${targetDir}`)
