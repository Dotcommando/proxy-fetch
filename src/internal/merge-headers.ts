import type { HeaderPair } from '../service/contract';

export const mergeHeaders = (
  defaultHeaders: HeadersInit | undefined,
  requestHeaders: Headers,
): HeaderPair[] => {
  const headers = new Headers(defaultHeaders);

  requestHeaders.forEach((value, key) => {
    headers.set(key, value);
  });

  return Array.from(headers.entries());
};
