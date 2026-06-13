import {
  DEFAULT_TIMEOUT_MS,
  PROXY_FETCH_DEFAULT_TIMEOUT_MS_ENV,
} from '../constants';
import { ProxyFetchConfigError } from '../errors';

export const resolveDefaultTimeoutMs = (timeoutMs?: number): number => {
  if (timeoutMs !== undefined) {
    return timeoutMs;
  }

  const envTimeoutMs = process.env[PROXY_FETCH_DEFAULT_TIMEOUT_MS_ENV];

  if (envTimeoutMs === undefined || envTimeoutMs === '') {
    return DEFAULT_TIMEOUT_MS;
  }

  const parsedTimeoutMs = Number(envTimeoutMs);

  if (!Number.isInteger(parsedTimeoutMs) || parsedTimeoutMs <= 0) {
    throw new ProxyFetchConfigError(
      `${PROXY_FETCH_DEFAULT_TIMEOUT_MS_ENV} must be a positive integer number of milliseconds.`,
    );
  }

  return parsedTimeoutMs;
};
