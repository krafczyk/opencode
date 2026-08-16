const disposers = new Set<(directory: string) => Promise<void>>()

/** Controls whether instance cleanup propagates aggregate disposer failures after attempting every disposer. */
export interface DisposeInstanceOptions {
  readonly strict?: boolean
}

export function registerDisposer(disposer: (directory: string) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

/** Runs every registered disposer for one instance, optionally rejecting after any cleanup failure. */
export async function disposeInstance(directory: string, options: DisposeInstanceOptions = {}) {
  const results = await Promise.allSettled([...disposers].map((disposer) => disposer(directory)))
  if (!options.strict) return
  const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (failures.length) throw new AggregateError(failures, `Failed to dispose instance ${directory}`)
}
