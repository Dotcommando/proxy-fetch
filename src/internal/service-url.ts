import { PROXY_FETCH_SERVICE_URL_ENV } from '../constants';
import { ProxyFetchConfigError } from '../errors';

export const resolveServiceUrl = (serviceUrl?: string | URL): URL => {
  const configuredServiceUrl =
    serviceUrl ?? process.env[PROXY_FETCH_SERVICE_URL_ENV];

  if (configuredServiceUrl === undefined || configuredServiceUrl === '') {
    throw new ProxyFetchConfigError(
      `Proxy fetch service URL is required. Pass serviceUrl or set ${PROXY_FETCH_SERVICE_URL_ENV}.`,
    );
  }

  try {
    return new URL(configuredServiceUrl);
  } catch (cause) {
    throw new ProxyFetchConfigError('Proxy fetch service URL is invalid.', {
      cause,
    });
  }
};
