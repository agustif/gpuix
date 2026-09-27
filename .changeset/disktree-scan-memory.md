---
'disktree': patch
---

`disktree ~` no longer runs out of JavaScript heap on large home folders. A scan used to keep up to 13 tree nodes per directory, one per file, so millions of `node_modules`, cache and `.git` directories full of tiny files filled V8's heap before the scan finished. Files under 64 KiB now fold into the directory's "N smaller files" tile, file tiles share one empty child list, and hardlinks are tracked by inode number instead of a string per file. On a synthetic 316k-directory pnpm-style tree the tree kept after the scan drops from 469 MB to 97 MB of heap.
