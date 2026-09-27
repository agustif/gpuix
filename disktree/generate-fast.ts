#!/usr/bin/env node
/**
 * Fast generator for millions of directories.
 * Focuses on creating many dirs quickly rather than realistic structure.
 */

import fs from 'node:fs'
import path from 'node:path'

const targetDir = process.argv[2] || '/tmp/disktree-large'
const targetDirs = parseInt(process.argv[3] || '1000000', 10)

console.log(`Generating ${targetDirs.toLocaleString()} directories at: ${targetDir}\n`)

fs.mkdirSync(targetDir, { recursive: true })

// Store file for hardlinks
const storeFile = path.join(targetDir, '.store')
fs.writeFileSync(storeFile, Buffer.alloc(4096, 'x'))

let dirCount = 0
let fileCount = 0
let linkCount = 0
const start = Date.now()

// Create many shallow dirs with a few files each
// Structure: level1-NNN/level2-NNN/level3-NNN
const level1Dirs = Math.ceil(Math.cbrt(targetDirs))

for (let i = 0; i < level1Dirs && dirCount < targetDirs; i++) {
  const l1 = path.join(targetDir, `d${i}`)
  fs.mkdirSync(l1)
  dirCount++

  const level2Dirs = Math.ceil(Math.sqrt(targetDirs / level1Dirs))
  for (let j = 0; j < level2Dirs && dirCount < targetDirs; j++) {
    const l2 = path.join(l1, `d${j}`)
    fs.mkdirSync(l2)
    dirCount++

    const level3Dirs = Math.ceil(targetDirs / (level1Dirs * level2Dirs))
    for (let k = 0; k < level3Dirs && dirCount < targetDirs; k++) {
      const l3 = path.join(l2, `d${k}`)
      try {
        fs.mkdirSync(l3)
        dirCount++

        // Add 3-7 files per leaf, some hardlinked
        const numFiles = 3 + Math.floor(Math.random() * 5)
        for (let f = 0; f < numFiles; f++) {
          const filePath = path.join(l3, `f${f}`)
          if (Math.random() < 0.3) {
            try {
              fs.linkSync(storeFile, filePath)
              linkCount++
            } catch {
              fs.writeFileSync(filePath, Buffer.alloc(1000, 'a'))
            }
          } else {
            fs.writeFileSync(filePath, Buffer.alloc(1000, 'a'))
          }
          fileCount++
        }
      } catch (e) {
        // May hit limits
        break
      }
    }

    if (dirCount % 10000 === 0) {
      const elapsed = (Date.now() - start) / 1000
      const rate = dirCount / elapsed
      console.log(
        `${dirCount.toLocaleString()} dirs, ` +
          `${fileCount.toLocaleString()} files, ` +
          `${linkCount.toLocaleString()} links, ` +
          `${rate.toFixed(0)} dirs/s`,
      )
    }
  }
}

const elapsed = (Date.now() - start) / 1000
console.log(`\n✓ Complete: ${dirCount.toLocaleString()} dirs in ${elapsed.toFixed(1)}s`)
