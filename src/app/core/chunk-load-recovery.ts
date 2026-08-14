const CHUNK_RELOAD_KEY = 'zxd-training-hub:chunk-reload';
const CHUNK_RELOAD_COOLDOWN_MS = 60_000;

const CHUNK_LOAD_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /loading chunk [\w-]+ failed/i,
  /chunkloaderror/i,
];

export function isChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
        ? error
        : '';

  return CHUNK_LOAD_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Recovers tabs that still have an older Angular entry bundle after a deploy.
 * A cache-busting navigation fetches the current index and its current chunks.
 */
export function installChunkLoadRecovery(): void {
  let recoveryStarted = false;

  const recover = (error: unknown): void => {
    if (recoveryStarted || !isChunkLoadError(error)) {
      return;
    }

    const lastReload = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0);
    if (Date.now() - lastReload < CHUNK_RELOAD_COOLDOWN_MS) {
      return;
    }

    recoveryStarted = true;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));

    const url = new URL(window.location.href);
    url.searchParams.set('app-reload', String(Date.now()));
    window.location.replace(url.toString());
  };

  window.addEventListener('error', (event) => recover(event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => recover(event.reason));
}
