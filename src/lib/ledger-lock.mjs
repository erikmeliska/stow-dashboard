/**
 * One in-process lock for read-modify-write of the ledger (#11): the quick
 * refresh, the full-scan sync, reorg's removeLedgerRows and the relocation's
 * ledger step all take it, so none of them writes back a copy read before
 * another's write. Anchored on globalThis because Next can bundle a module
 * into more than one route chunk (one instance per chunk would be no lock).
 * Other processes (the CLIs) are not covered.
 */
import { writeFile, rename } from 'node:fs/promises'

const S = globalThis.__stowLedgerLock ??= { tail: Promise.resolve() }

/** Wait for the lock; → an idempotent release(). */
export async function acquireLedgerLock() {
  let release
  const mine = new Promise((r) => { release = r })
  const prev = S.tail
  S.tail = prev.then(() => mine)
  await prev
  let done = false
  return () => { if (!done) { done = true; release() } }
}

export async function withLedgerLock(fn) {
  const release = await acquireLedgerLock()
  try { return await fn() } finally { release() }
}

/** tmp + rename, so a concurrent reader never sees a half-written ledger. */
export async function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmp, text)
  await rename(tmp, file)
}
