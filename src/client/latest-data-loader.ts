export function createLatestDataLoader<TArguments extends unknown[]>(
  fetchLatest: (...args: TArguments) => Promise<void>,
) {
  let activeRequest: Promise<void> | null = null;

  async function load(...args: TArguments): Promise<void> {
    if (activeRequest) return activeRequest;
    const request = fetchLatest(...args);
    activeRequest = request;
    try {
      await request;
    } finally {
      if (activeRequest === request) activeRequest = null;
    }
  }

  async function reload(...args: TArguments): Promise<void> {
    if (activeRequest) {
      try {
        await activeRequest;
      } catch {
        // A write still needs a fresh read even if an earlier background read failed.
      }
    }
    await load(...args);
  }

  return { load, reload };
}
