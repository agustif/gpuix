/**
 * Scan memory: the tree the main thread keeps must grow with directories, not
 * with files. A home folder has millions of directories of tiny files, and a
 * node per file ran V8 out of heap before the scan finished.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { scan, type ScanProgress, type TreeNode } from './core.ts'

const KIB = 1024
const DIRS = 120
const FILES_PER_DIR = 20

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disktree-core-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function write(relative: string, bytes: number) {
  const full = path.join(root, relative)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, Buffer.alloc(bytes, 1))
  return full
}

// A package store and many node_modules-like directories of hardlinks into it,
// the way pnpm lays out a home folder.
const store = Array.from({ length: 40 }, (_, index) => write(`store/${index}.js`, 1 * KIB + index * 100))
for (let dir = 0; dir < DIRS; dir++) {
  const base = path.join(root, `projects/p${dir}/node_modules/pkg/lib`)
  fs.mkdirSync(base, { recursive: true })
  for (let file = 0; file < FILES_PER_DIR; file++) {
    fs.linkSync(store[(dir + file) % store.length]!, path.join(base, `f${file}.js`))
  }
}
write('big/video.mp4', 512 * KIB)
write('big/cover.png', 96 * KIB)
write('big/notes.txt', 2 * KIB)
write('big/todo.txt', 2 * KIB)
write('lonely/readme.md', 1 * KIB)

/** What `du` would say: every inode once, disk usage from st_blocks. */
function expected(dir: string, seen = new Set<number>()): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  for (const name of fs.readdirSync(dir)) {
    const stat = fs.lstatSync(path.join(dir, name))
    if (stat.isDirectory()) {
      const inner = expected(path.join(dir, name), seen)
      bytes += inner.bytes
      files += inner.files
      continue
    }
    files++
    if (stat.nlink > 1 && seen.has(stat.ino)) continue
    seen.add(stat.ino)
    bytes += stat.blocks * 512
  }
  return { bytes, files }
}

function count(node: TreeNode): { dirs: number; leaves: number } {
  if (!node.dir) return { dirs: 0, leaves: 1 }
  let dirs = 1
  let leaves = 0
  for (const child of node.children) {
    const inner = count(child)
    dirs += inner.dirs
    leaves += inner.leaves
  }
  return { dirs, leaves }
}

function find(node: TreeNode, ...names: string[]): TreeNode | undefined {
  let current: TreeNode | undefined = node
  for (const name of names) current = current?.children.find((child) => child.name === name)
  return current
}

describe('scan', () => {
  it('keeps about one node per directory, not one per small file', async () => {
    const progress: ScanProgress = { files: 0, dirs: 0, bytes: 0, errors: 0 }
    const tree = await scan(root, { includeHidden: true, progress })
    const { dirs, leaves } = count(tree)
    const truth = expected(root)

    // Totals are exact, and every hardlinked inode is charged once.
    expect(tree.files).toBe(truth.files)
    expect(tree.bytes).toBe(truth.bytes)
    expect(progress.files).toBe(truth.files)
    expect(progress.bytes).toBe(truth.bytes)
    expect(tree.dirs + 1).toBe(dirs)

    // Each folder of 20 tiny files is one "20 smaller files" tile. Keeping the
    // 12 largest of them as tiles grew the tree by 13 nodes per directory.
    expect(find(tree, 'projects', 'p0', 'node_modules', 'pkg', 'lib')!.children.map((child) => child.name)).toEqual([
      `${FILES_PER_DIR} smaller files`,
    ])
    // Tiles: one per directory with files, plus the two big files.
    expect(leaves).toBeLessThanOrEqual(dirs + 2)
    expect(leaves).toBeLessThan(DIRS * 2)

    // Files big enough to see keep their own tile; the small ones fold.
    expect(find(tree, 'big')!.children.map((child) => child.name)).toEqual(['video.mp4', 'cover.png', '2 smaller files'])
    // A fold of one file would cost the same node, so it keeps its name.
    expect(find(tree, 'lonely')!.children.map((child) => child.name)).toEqual(['readme.md'])
  })
})
