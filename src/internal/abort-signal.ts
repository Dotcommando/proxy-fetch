export interface LocalAbortSignal {
  signal: AbortSignal;
  cleanup(): void;
}

export const createLocalAbortSignal = (
  sourceSignal: AbortSignal,
  timeoutMs: number,
): LocalAbortSignal => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(
      new DOMException(
        `Proxy fetch request timed out after ${timeoutMs} ms.`,
        'TimeoutError',
      ),
    );
  }, timeoutMs);
  const abortFromSource = (): void => {
    controller.abort(sourceSignal.reason);
  };

  if (sourceSignal.aborted) {
    abortFromSource();
  } else {
    sourceSignal.addEventListener('abort', abortFromSource, {
      once: true,
    });
  }

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      sourceSignal.removeEventListener('abort', abortFromSource);
    },
  };
};
