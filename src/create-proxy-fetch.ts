import { BINARY_BODY_TRANSPORT_MULTIPART } from './constants';
import { createResponse } from './fetch/create-response';
import { serializeRequest } from './fetch/serialize-request';
import { createLocalAbortSignal } from './internal/abort-signal';
import { mergeContext } from './internal/merge-context';
import { mergeHeaders } from './internal/merge-headers';
import { resolveServiceUrl } from './internal/service-url';
import { resolveDefaultTimeoutMs } from './internal/timeout';
import { createServiceClient } from './service/client';
import type { ProxyFetch, ProxyFetchInit, ProxyFetchOptions } from './types';

const NODE_FETCH_DISPATCHER_OPTION = 'dispatcher';

interface ProxyFetchInitWithDispatcher extends ProxyFetchInit {
  dispatcher?: unknown;
}

export const createProxyFetch = (
  options: ProxyFetchOptions = {},
): ProxyFetch => {
  const serviceEndpoint = resolveServiceUrl(options.serviceUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = resolveDefaultTimeoutMs(options.timeoutMs);
  const serviceClientOptions = {
    serviceEndpoint,
    fetchImpl,
  };
  const serviceClient = createServiceClient(
    options.apiKey === undefined
      ? serviceClientOptions
      : {
          ...serviceClientOptions,
          apiKey: options.apiKey,
        },
  );
  const proxyFetch: ProxyFetch = async function fetch(
    input,
    init: ProxyFetchInit | undefined = undefined,
  ) {
    const initWithDispatcher: ProxyFetchInitWithDispatcher | undefined = init;

    if (
      initWithDispatcher !== undefined
      && NODE_FETCH_DISPATCHER_OPTION in initWithDispatcher
      && initWithDispatcher.dispatcher !== undefined
    ) {
      throw new TypeError(
        'proxy-fetch does not support the Node.js fetch dispatcher option because target requests are executed by the orchestrator.',
      );
    }

    const request = new Request(input, init);

    if (request.signal.aborted) {
      throw request.signal.reason;
    }

    const headers = mergeHeaders(options.defaultHeaders, request.headers);
    const context = mergeContext(options.defaultContext, init?.context);
    const timeoutMs = init?.timeoutMs ?? defaultTimeoutMs;
    const localAbortSignal = createLocalAbortSignal(request.signal, timeoutMs);
    const requestBody = init?.body ?? request.body;

    try {
      const envelope = await serializeRequest({
        request,
        requestBody,
        headers,
        context,
        timeoutMs,
        signal: localAbortSignal.signal,
        binaryBodyTransport:
          options.binaryBodyTransport ?? BINARY_BODY_TRANSPORT_MULTIPART,
      });
      let uploadCompletionError: unknown;
      const uploadCompletion = envelope.uploadCompletion?.catch((error) => {
        uploadCompletionError = error;
      });
      const serviceResponse = await serviceClient.execute({
        request: envelope,
        signal: localAbortSignal.signal,
      });

      await uploadCompletion;

      if (uploadCompletionError !== undefined) {
        throw uploadCompletionError;
      }

      return createResponse(serviceResponse);
    } finally {
      localAbortSignal.cleanup();
    }
  };

  Object.defineProperty(proxyFetch, 'name', {
    value: 'fetch',
    configurable: true,
  });

  return proxyFetch;
};
