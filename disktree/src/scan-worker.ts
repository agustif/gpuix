/**
 * One scan worker for disktree. The main thread hands it directories; it walks
 * them depth first with synchronous syscalls, which are several times cheaper
 * than one promise per entry, and returns a compact record per directory.
 *
 * After BUDGET directories it stops and hands the unvisited frontier back, so
 * the main thread can spread a deep tree like `/Users` across every worker.
 *
 * Self-contained on purpose: Node 24 loads this file with type stripping
 * (under vitest), Bun loads it natively, and neither sees the app's modules.
 */

import { lstatSync, readdirSync, type Stats } from 'node:fs'
import path from 'node:path'
import { parentPort } from 'node:worker_threads'

export interface ScanRequest {
  paths: string[]
  includeHidden: boolean
  devices: number[]
  skip: string[]
}

/**
 * name, disk bytes, apparent bytes, mtime ms, inode when hardlinked or 0.
 * A scan stays on one device, so the inode alone identifies a hardlink.
 */
export type FileRecord = [string, number, number, number, number]

export interface DirRecord {
  path: string
  modified: number
  unreadable: boolean
  /** The largest files, one node each. */
  files: FileRecord[]
  /** Everything else, folded into one total. */
  folded: {
    count: number
    bytes: number
    apparent: number
    modified: number
    /**
     * Hardlinked files in the total, flat as disk bytes, apparent bytes,
     * inode: one message per batch can carry thousands of them.
     */
    links: number[]
  } | null
  /** Subdirectories to be scanned; their records follow here or in a later batch. */
  dirs: string[]
}

export interface ScanReply {
  records: DirRecord[]
  pending: string[]
  errors: number
}

const BUDGET = 400
/** Files kept as their own tile per directory; the rest cannot be seen anyway. */
export const KEEP_FILES = 12
/**
 * Smaller files are folded even when there is room for them. Every kept file
 * becomes a tree node on the main thread that lives as long as the window, and
 * a home folder has millions of directories full of tiny files (node_modules,
 * caches, .git): at up to 13 nodes per directory the tree can outgrow V8's
 * default heap. A file this small is a sliver of any folder worth looking at.
 */
export const MIN_FILE_BYTES = 64 * 1024

function scanBatch(request: ScanRequest): ScanReply {
  const devices = new Set(request.devices)
  const skip = new Set(request.skip)
  const records: DirRecord[] = []
  const stack = [...request.paths].reverse()
  let errors = 0

  while (stack.length && records.length < BUDGET) {
    const full = stack.pop()!
    const record: DirRecord = { path: full, modified: 0, unreadable: false, files: [], folded: null, dirs: [] }
    records.push(record)
    let names: string[]
    try {
      record.modified = lstatSync(full).mtimeMs
      names = readdirSync(full)
    } catch {
      record.unreadable = true
      errors++
      continue
    }
    const files: FileRecord[] = []
    const subdirs: string[] = []
    for (const name of names) {
      if (!request.includeHidden && name.startsWith('.')) continue
      const child = path.join(full, name)
      if (skip.has(child)) continue
      let stat: Stats
      try {
        stat = lstatSync(child)
      } catch {
        errors++
        continue
      }
      if (stat.isDirectory()) {
        // One volume, like `du -x`: other mounts are other disks.
        if (!devices.has(stat.dev)) continue
        subdirs.push(name)
        continue
      }
      files.push([name, stat.blocks * 512, stat.size, stat.mtimeMs, stat.nlink > 1 ? stat.ino : 0])
    }
    files.sort((left, right) => right[1] - left[1])
    let keep = 0
    while (keep < files.length && keep < KEEP_FILES && files[keep]![1] >= MIN_FILE_BYTES) keep++
    // A fold of one file costs the same node as the file, and keeps its name.
    if (files.length - keep === 1) keep++
    record.files = files.slice(0, keep)
    const rest = files.slice(keep)
    if (rest.length) {
      record.folded = { count: rest.length, bytes: 0, apparent: 0, modified: 0, links: [] }
      for (const file of rest) {
        record.folded.bytes += file[1]
        record.folded.apparent += file[2]
        record.folded.modified = Math.max(record.folded.modified, file[3])
        if (file[4]) record.folded.links.push(file[1], file[2], file[4])
      }
    }
    record.dirs = subdirs
    for (let index = subdirs.length - 1; index >= 0; index--) stack.push(path.join(full, subdirs[index]!))
  }
  return { records, pending: stack.reverse(), errors }
}

parentPort?.on('message', (request: ScanRequest) => parentPort!.postMessage(scanBatch(request)))
