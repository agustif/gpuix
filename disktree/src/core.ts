/**
 * disktree core: scan, classify, lay out, and rank a directory tree.
 *
 * A TypeScript port of the parts of https://github.com/tobi/disktree that the
 * GPUIX example needs. No UI here, so the logic is testable on its own.
 *
 *   scan()        parallel lstat walk, disk usage = st_blocks × 512, hardlinks once
 *   classify()    kind of data from directory names, and what is reclaimable
 *   layout()      squarified treemap with a name band per open directory
 *   worthALook()  largest directories that could plausibly go
 */

import { lstatSync, statfsSync } from 'node:fs'
import os, { availableParallelism } from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

import type { FileRecord, ScanReply } from './scan-worker.ts'

// ── Tree ───────────────────────────────────────────────────────────────────

export type Category =
  | 'code'
  | 'agent'
  | 'toolchain'
  | 'synced'
  | 'git'
  | 'media'
  | 'documents'
  | 'cache'
  | 'other'

export type Reclaim =
  | 'regenerable'
  | 'sync history'
  | 'package store'
  | 'build output'
  | 'reinstallable'
  | 'sandbox layers'
  | 'snapshots'
  | 'trash'
  | 'temporary'

export interface TreeNode {
  name: string
  dir: boolean
  /** Disk usage: what comes back when it is deleted. */
  bytes: number
  /** What `ls -l` shows. */
  apparent: number
  /** 1 for a file, the count for a folded group of small files. */
  files: number
  dirs: number
  /** Newest write inside, in ms. 0 when unknown. */
  modified: number
  /** Largest first by disk usage. */
  children: TreeNode[]
  category: Category
  reclaim: Reclaim | null
  unreadable: boolean
}

export type Metric = 'bytes' | 'apparent' | 'files'

export function valueOf(node: TreeNode, metric: Metric): number {
  if (metric === 'files') return node.files
  return metric === 'apparent' ? node.apparent : node.bytes
}

export function resolve(root: TreeNode, crumbs: readonly number[]): TreeNode | undefined {
  let node: TreeNode | undefined = root
  for (const index of crumbs) {
    node = node?.children[index]
    if (!node) return undefined
  }
  return node
}

export function resolveChain(root: TreeNode, crumbs: readonly number[]): TreeNode[] {
  const chain = [root]
  let node = root
  for (const index of crumbs) {
    const next = node.children[index]
    if (!next) break
    chain.push(next)
    node = next
  }
  return chain
}

// ── Scan ───────────────────────────────────────────────────────────────────

export interface ScanProgress {
  files: number
  dirs: number
  bytes: number
  errors: number
}

export interface ScanOptions {
  includeHidden: boolean
  progress: ScanProgress
  signal?: AbortSignal
}

// macOS firmlinks /Users, /Applications and the rest of the data volume into
// `/`, and the same volume is also mounted here. Walking both counts it twice.
const MIRRORS = process.platform === 'darwin' ? ['/System/Volumes/Data'] : []

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
    category: 'other',
    reclaim: null,
    unreadable: false,
  }
}

function folder(name: string): TreeNode {
  return { ...leaf(name, 0, 0, 0, 0), dir: true }
}

/**
 * Walk `root` on a pool of workers, like the Rust original walks it on rayon.
 *
 * Workers return one record per directory, parents before children, plus the
 * frontier they did not reach. The main thread only stitches records into the
 * tree and hands the frontier out again, so a deep tree spreads over the pool.
 */
export async function scan(root: string, options: ScanOptions): Promise<TreeNode> {
  const { progress, signal } = options
  const rootStat = lstatSync(root)
  const tree = folder(root === '/' ? '/' : path.basename(root))
  if (!rootStat.isDirectory()) return leaf(tree.name, rootStat.blocks * 512, rootStat.size, rootStat.mtimeMs)

  const request = { includeHidden: options.includeHidden, devices: [rootStat.dev], skip: MIRRORS }
  // Directories listed by a parent, waiting for their own record.
  const open = new Map<string, TreeNode>([[root, tree]])
  const queue: string[] = [root]
  // Use numeric keys for seen hardlinks instead of strings: Map<dev, Set<ino>>
  const seen = new Map<number, Set<number>>()
  const size = Math.max(2, Math.min(4, availableParallelism() - 2))
  // tsc rewrites import specifiers, not URL strings: src loads .ts, dist loads .js.
  const workerUrl = new URL(`./scan-worker${path.extname(import.meta.url)}`, import.meta.url)
  const workers = Array.from({ length: size }, () => new Worker(workerUrl))
  const idle = [...workers]

  const stitch = (reply: ScanReply) => {
    progress.errors += reply.errors
    for (const record of reply.records) {
      const node = open.get(record.path)
      if (!node) continue
      open.delete(record.path)
      progress.dirs++
      node.modified = record.modified
      node.unreadable = record.unreadable
      // Two names for one inode cost one file.
      const charge = ([, bytes, apparent, , link]: FileRecord) => {
        if (!link) return [bytes, apparent]
        // Parse "dev:ino" into numeric parts
        const colon = link.indexOf(':')
        const dev = parseInt(link.slice(0, colon), 10)
        const ino = parseInt(link.slice(colon + 1), 10)
        let devSet = seen.get(dev)
        if (!devSet) {
          devSet = new Set()
          seen.set(dev, devSet)
        }
        if (devSet.has(ino)) return [0, 0]
        devSet.add(ino)
        return [bytes, apparent]
      }
      for (const file of record.files) {
        const [bytes, apparent] = charge(file)
        node.children.push(leaf(file[0], bytes!, apparent!, file[3]))
        progress.files++
        progress.bytes += bytes!
      }
      const folded = record.folded
      if (folded) {
        let { bytes, apparent } = folded
        for (const link of folded.links) {
          const [kept, keptApparent] = charge(link)
          bytes -= link[1] - kept!
          apparent -= link[2] - keptApparent!
        }
        node.children.push(leaf(`${folded.count} smaller files`, bytes, apparent, folded.modified, folded.count))
        progress.files += folded.count
        progress.bytes += bytes
      }
      for (const name of record.dirs) {
        const child = folder(name)
        node.children.push(child)
        open.set(path.join(record.path, name), child)
      }
    }
    // Avoid spreading large arrays in a single push call
    for (const pending of reply.pending) {
      queue.push(pending)
    }
  }

  try {
    await new Promise<void>((done, fail) => {
      const abort = () => fail(new Error('scan cancelled'))
      signal?.addEventListener('abort', abort, { once: true })
      const pump = () => {
        while (idle.length && queue.length) {
          const worker = idle.pop()!
          // A few paths per message: enough to amortize it, few enough to share.
          const paths = queue.splice(0, Math.max(1, Math.ceil(queue.length / size / 2)))
          worker.postMessage({ ...request, paths })
        }
        if (idle.length === size && !queue.length) done()
      }
      for (const worker of workers) {
        worker.on('message', (reply: ScanReply) => {
          stitch(reply)
          idle.push(worker)
          pump()
        })
        worker.on('error', fail)
      }
      pump()
    })
  } finally {
    for (const worker of workers) void worker.terminate()
  }
  aggregate(tree)
  classify(tree)
  return tree
}

/** Bottom-up totals, then children sorted largest first. */
export function aggregate(node: TreeNode): void {
  if (!node.dir) return
  let files = 0
  let dirs = 0
  let bytes = node.bytes
  let apparent = node.apparent
  let modified = node.modified
  let unreadable = node.unreadable
  for (const child of node.children) {
    aggregate(child)
    bytes += child.bytes
    apparent += child.apparent
    files += child.files
    dirs += child.dir ? child.dirs + 1 : 0
    modified = Math.max(modified, child.modified)
    unreadable ||= child.unreadable
  }
  Object.assign(node, { files, dirs, bytes, apparent, modified, unreadable })
  node.children.sort((left, right) => right.bytes - left.bytes)
}

// ── Classify ───────────────────────────────────────────────────────────────

const NAMES: Record<string, Category> = {}
function names(category: Category, list: string) {
  for (const name of list.split('|')) NAMES[name] = category
}
names('code', 'src|code|projects|repos|dev|work|workspace|workspaces|github.com|gitlab.com|sites|development|github')
names(
  'agent',
  '.codex|.claude|.herdr|.pi|.cursor|.aider|.gemini|.continue|.windsurf|.microsandbox|.omp|.agents|.openai|tries|worktrees|experiments|scratch|playground|.opencode|.kimaki',
)
names(
  'toolchain',
  '.cargo|.rustup|.local|.npm|.pnpm-store|pnpm|.bun|.deno|go|.gradle|.m2|.platformio|mise|.mise|.pyenv|.nvm|.gem|gem|.rbenv|.config|.vscode|.zig|.rye|.conda|anaconda3|miniconda3|.opam|.ghcup|.stack|.julia|.dotnet|.android|.sdkman|.volta|.yarn|.java|.nuget|xcode|coresimulator',
)
names('synced', 'sync|dropbox|nextcloud|google drive|onedrive|pclouddrive|mega|.stversions|mobile documents|cloudstorage|iclouddrive')
names('git', '.git')
names('media', 'pictures|photos|music|videos|movies|steam|steamlibrary|steamapps|emulation|models|.ollama|.lmstudio|games|wineprefix|assets|screenshots')
names('documents', 'documents|desktop|downloads|books|notes|obsidian|public|templates|docs')
names(
  'cache',
  '.cache|cache|caches|.ccache|.sccache|_cacache|__pycache__|node_modules|trash|.trash|tmp|.tmp|deriveddata|ios devicesupport|watchos devicesupport|temp|npm-cache|dist|build|.next|.turbo',
)
export function categoryOfName(name: string): Category | undefined {
  return NAMES[name.toLowerCase()]
}

export function reclaimOf(name: string, parent: Category, hasSibling: (name: string) => boolean): Reclaim | null {
  switch (name.toLowerCase()) {
    case '.cache':
    case 'cache':
    case 'caches':
    case '.ccache':
    case '.sccache':
    case '_cacache':
    case 'npm-cache':
    case 'ios devicesupport':
    case 'watchos devicesupport':
      return 'regenerable'
    case '.stversions':
      return 'sync history'
    case '.pnpm-store':
    case 'pnpm':
      return 'package store'
    case '__pycache__':
    case '.pytest_cache':
    case '.mypy_cache':
    case '.ruff_cache':
    case '.next':
    case '.turbo':
    case '.parcel-cache':
    case 'deriveddata':
      return 'build output'
    case 'logs':
      return hasSibling('Application Support') ? 'temporary' : null
    case 'target':
      return hasSibling('Cargo.toml') ? 'build output' : null
    case 'dist':
    case 'build':
      return hasSibling('package.json') ? 'build output' : null
    case 'node_modules':
      return hasSibling('package.json') ? 'reinstallable' : null
    case 'layers':
      return parent === 'agent' ? 'sandbox layers' : null
    case 'snapshots':
      return parent === 'agent' ? 'snapshots' : null
    case 'trash':
    case '.trash':
      return 'trash'
    case 'tmp':
    case '.tmp':
    case 'temp':
      return 'temporary'
    default:
      return null
  }
}

/** A git object store by its shape: `objects`, `refs` and `HEAD`. */
function isGitStore(node: TreeNode): boolean {
  if (!node.dir) return false
  const has = (wanted: string) => node.children.some((child) => child.name === wanted)
  return has('objects') && has('refs') && has('HEAD')
}

function nameCategory(node: TreeNode): Category | undefined {
  return categoryOfName(node.name) ?? (isGitStore(node) ? 'git' : undefined)
}

/** An unknown top-level directory takes the first known name down its largest children. */
function dominantCategory(node: TreeNode): Category | undefined {
  let current: TreeNode | undefined = node
  for (let level = 0; level < 3 && current; level++) {
    for (const child of current.children) {
      if (!child.dir) continue
      const category = nameCategory(child)
      if (category) return category
    }
    current = current.children.find((child) => child.dir)
  }
  return undefined
}

/** Top-down: a node's own name wins, otherwise it inherits. Reclaim inherits too. */
export function classify(root: TreeNode): void {
  root.category = 'other'
  root.reclaim = null
  const has = (siblings: TreeNode[]) => (wanted: string) => siblings.some((sibling) => sibling.name === wanted)
  for (const child of root.children) {
    const category = nameCategory(child) ?? dominantCategory(child) ?? 'other'
    const reclaim = child.dir ? reclaimOf(child.name, 'other', has(root.children)) : null
    below(child, category, reclaim)
  }
  function below(node: TreeNode, category: Category, reclaim: Reclaim | null) {
    node.category = category
    node.reclaim = reclaim
    const siblings = has(node.children)
    for (const child of node.children) {
      if (!child.dir) {
        child.category = category
        child.reclaim = reclaim
        continue
      }
      below(child, nameCategory(child) ?? category, reclaim ?? reclaimOf(child.name, category, siblings))
    }
  }
}

// ── Layout ─────────────────────────────────────────────────────────────────

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Tile {
  /** Child indices from the scanned root. */
  crumbs: number[]
  rect: Rect
  /** 0 is a child of the directory on screen. */
  depth: number
  /** The band a subdivided directory keeps for its own name. */
  header: Rect | null
  /** Set on the merged tail of a long child list. */
  others: number
}

export interface LayoutOptions {
  maxDepth: number
  padding: number
  paddingOuter: number
  minTile: number
  maxChildren: number
  header: number
  headerInner: number
}

export const LAYOUT_DEFAULTS: LayoutOptions = {
  maxDepth: 3,
  padding: 1,
  paddingOuter: 3,
  minTile: 5,
  maxChildren: 96,
  header: 22,
  headerInner: 17,
}

const inset = (rect: Rect, padding: number): Rect => ({
  x: rect.x + padding,
  y: rect.y + padding,
  w: Math.max(0, rect.w - padding * 2),
  h: Math.max(0, rect.h - padding * 2),
})

/** Every tile beneath `node`, parents before children, so hit-testing runs in reverse. */
export function layout(
  node: TreeNode,
  rootCrumbs: readonly number[],
  area: Rect,
  metric: Metric,
  options: LayoutOptions = LAYOUT_DEFAULTS,
): Tile[] {
  const out: Tile[] = []
  place(node, area, 0, [...rootCrumbs])
  return out

  function place(parent: TreeNode, area: Rect, depth: number, crumbs: number[]) {
    if (!parent.children.length || area.w <= 0 || area.h <= 0) return
    const ranked = parent.children
      .map((child, index) => ({ index, value: valueOf(child, metric) }))
      .filter((entry) => entry.value > 0)
      .sort((left, right) => right.value - left.value)
    if (!ranked.length) return
    const kept = ranked.slice(0, options.maxChildren)
    const tail = ranked.slice(options.maxChildren)
    const values = kept.map((entry) => entry.value)
    if (tail.length) values.push(tail.reduce((sum, entry) => sum + entry.value, 0))

    squarify(values, area).forEach((raw, slot) => {
      const rect = inset(raw, depth === 0 ? options.paddingOuter : options.padding)
      if (rect.w < options.minTile || rect.h < options.minTile) return
      const entry = kept[slot]
      if (!entry) {
        out.push({ crumbs: [...crumbs], rect, depth, header: null, others: tail.length })
        return
      }
      const child = parent.children[entry.index]!
      const childCrumbs = [...crumbs, entry.index]
      // No room for a band: the directory stays whole rather than draw its
      // name over its own children.
      const height = depth === 0 ? options.header : options.headerInner
      const header =
        child.dir && depth + 1 < options.maxDepth && rect.w >= 44 && rect.h - height >= options.minTile * 3
          ? { x: rect.x, y: rect.y, w: rect.w, h: height }
          : null
      out.push({ crumbs: childCrumbs, rect, depth, header, others: 0 })
      if (header) {
        const body = { x: rect.x, y: rect.y + height, w: rect.w, h: rect.h - height }
        place(child, body, depth + 1, childCrumbs)
      }
    })
  }
}

/**
 * Bruls, Huizing and van Wijk's squarified layout: grow a row while its worst
 * aspect ratio improves, then start the next one in the space left.
 * Returned in the order of `values`.
 */
export function squarify(values: readonly number[], area: Rect): Rect[] {
  const rects: Rect[] = values.map(() => ({ x: 0, y: 0, w: 0, h: 0 }))
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0)
  if (total <= 0 || area.w <= 0 || area.h <= 0) return rects
  const order = values.map((_, index) => index).filter((index) => values[index]! > 0)
  order.sort((left, right) => values[right]! - values[left]!)
  const scale = (area.w * area.h) / total
  const areas = order.map((index) => values[index]! * scale)

  const free = { ...area }
  let start = 0
  while (start < areas.length) {
    const side = Math.min(free.w, free.h)
    let end = start + 1
    let rowSum = areas[start]!
    let rowWorst = worstRatio(areas.slice(start, end), rowSum, side)
    while (end < areas.length) {
      const candidateSum = rowSum + areas[end]!
      const candidateWorst = worstRatio(areas.slice(start, end + 1), candidateSum, side)
      if (candidateWorst > rowWorst) break
      rowSum = candidateSum
      rowWorst = candidateWorst
      end++
    }
    if (free.w >= free.h) {
      const stripW = Math.min(rowSum / free.h, free.w)
      let y = free.y
      for (let index = start; index < end; index++) {
        const height = Math.max(0, Math.min(stripW > 0 ? areas[index]! / stripW : 0, free.y + free.h - y))
        rects[order[index]!] = { x: free.x, y, w: stripW, h: height }
        y += height
      }
      free.x += stripW
      free.w -= stripW
    } else {
      const stripH = Math.min(rowSum / free.w, free.h)
      let x = free.x
      for (let index = start; index < end; index++) {
        const width = Math.max(0, Math.min(stripH > 0 ? areas[index]! / stripH : 0, free.x + free.w - x))
        rects[order[index]!] = { x, y: free.y, w: width, h: stripH }
        x += width
      }
      free.y += stripH
      free.h -= stripH
    }
    start = end
  }
  return rects
}

function worstRatio(areas: number[], rowSum: number, side: number): number {
  if (rowSum <= 0 || side <= 0) return Infinity
  const thickness = rowSum / side
  let worst = 0
  for (const area of areas) {
    if (area <= 0) continue
    const other = area / thickness
    worst = Math.max(worst, thickness / other, other / thickness)
  }
  return worst
}

/** The deepest tile under a point. */
export function hit(tiles: readonly Tile[], x: number, y: number): Tile | undefined {
  for (let index = tiles.length - 1; index >= 0; index--) {
    const { rect } = tiles[index]!
    if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) return tiles[index]
  }
  return undefined
}

// ── Worth a look ───────────────────────────────────────────────────────────

const DAY = 86_400_000
export const STALE_DAYS = 30

export interface Candidate {
  crumbs: number[]
  bytes: number
  reason: string
}

/**
 * The largest findings beneath `root`: reclaimable space, agent worktrees,
 * experiments untouched for a month. Findings never nest.
 */
export function worthALook(root: TreeNode, now: number, limit: number): Candidate[] {
  // 64 MiB on a real disk; a small folder still gets a list.
  const minBytes = Math.min(64 * 1024 * 1024, Math.max(1, root.bytes * 0.01))
  const found: Candidate[] = []
  root.children.forEach((child, index) => visit(child, [index]))
  return found
    .filter((candidate) => candidate.bytes >= minBytes)
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, limit)

  function visit(node: TreeNode, crumbs: number[]) {
    if (!node.dir || node.bytes < minBytes) return
    if (node.reclaim) {
      found.push({ crumbs, bytes: node.bytes, reason: node.reclaim })
      return
    }
    const name = node.name.toLowerCase()
    const scratch = node.category === 'agent'
    const trees = node.children.filter((child) => child.dir)
    if (scratch && name === 'worktrees' && trees.length) {
      const oldest = Math.min(...trees.map((tree) => tree.modified || now))
      const days = Math.floor((now - oldest) / DAY)
      found.push({
        crumbs,
        bytes: node.bytes,
        reason: `${trees.length} worktree${trees.length === 1 ? '' : 's'} · oldest ${days} d`,
      })
      return
    }
    const experiments = scratch && (name === 'tries' || name === 'experiments')
    let stale = 0
    let staleBytes = 0
    node.children.forEach((child, index) => {
      if (experiments && child.dir && child.modified > 0 && now - child.modified > STALE_DAYS * DAY) {
        stale++
        staleBytes += child.bytes
        return
      }
      visit(child, [...crumbs, index])
    })
    if (stale) {
      found.push({
        crumbs,
        bytes: staleBytes,
        reason: `${stale} experiment${stale === 1 ? '' : 's'} untouched`,
      })
    }
  }
}

// ── Disk and formatting ────────────────────────────────────────────────────

export interface DiskSpace {
  total: number
  available: number
}

export function diskSpace(at: string): DiskSpace | null {
  try {
    const stat = statfsSync(at)
    return { total: stat.blocks * stat.bsize, available: stat.bavail * stat.bsize }
  } catch {
    return null
  }
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']

/** `1.4 GiB`, `523 MiB`: one decimal below 10, like `du -h`. */
export function humanBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const text = unit === 0 ? value.toFixed(0) : value < 9.95 ? value.toFixed(1) : value.toFixed(0)
  return `${text} ${UNITS[unit]}`
}

/** `1.2k`, `3.4M`, `812`. */
export function humanCount(count: number): string {
  if (count < 10_000) return String(count)
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

export function ago(now: number, then: number): string {
  if (!then) return 'unknown'
  const seconds = Math.max(0, (now - then) / 1000)
  if (seconds < 90) return 'just now'
  if (seconds < 3600 * 1.5) return `${Math.round(seconds / 60)} minutes ago`
  if (seconds < 86_400 * 1.5) return `${Math.round(seconds / 3600)} hours ago`
  if (seconds < 86_400 * 60) return `${Math.round(seconds / 86_400)} days ago`
  if (seconds < 86_400 * 365 * 1.5) return `${Math.round(seconds / (86_400 * 30))} months ago`
  return `${Math.round(seconds / (86_400 * 365))} years ago`
}

export const AGE_BUCKETS: Array<[days: number, label: string]> = [
  [7, 'This week'],
  [30, 'This month'],
  [182, 'Six months'],
  [365, 'This year'],
  [Infinity, 'Older'],
]

export function ageBucket(days: number): number {
  const index = AGE_BUCKETS.findIndex(([limit]) => days <= limit)
  return index === -1 ? AGE_BUCKETS.length - 1 : index
}

/** `~/src/app` for anything under the home directory. */
export function displayPath(full: string): string {
  const home = os.homedir()
  if (full === home) return '~'
  return full.startsWith(home + path.sep) ? `~${full.slice(home.length)}` : full
}
