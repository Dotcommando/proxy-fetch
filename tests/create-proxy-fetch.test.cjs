const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_TIMEOUT_MS,
  PROXY_FETCH_DEFAULT_TIMEOUT_MS_ENV,
  PROXY_FETCH_SERVICE_URL_ENV,
  SERVICE_ACCEPT_HEADER_VALUE,
  WIRE_PROTOCOL_VERSION,
  createProxyFetch,
  ProxyFetchServiceError,
} = require('../dist/index.cjs');

const MINUTES_PER_LLM_REQUEST_TIMEOUT = 6;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1_000;
const DEFAULT_LLM_TIMEOUT_MS =
  MINUTES_PER_LLM_REQUEST_TIMEOUT
  * SECONDS_PER_MINUTE
  * MILLISECONDS_PER_SECOND;

const REQUEST_TIMEOUT_MS = 12_345;
const SERVICE_URL = 'https://proxy-fetch-service.example/fetch';
const TARGET_URL = 'https://example.com/catalog';
const API_KEY = 'test-api-key';
const ENV_TIMEOUT_MS = 240_000;

const createEmptyServiceResponse = (status = 204) =>
  new Response(
    JSON.stringify({
      version: WIRE_PROTOCOL_VERSION,
      ok: true,
      response: {
        url: TARGET_URL,
        status,
        statusText: status === 204 ? 'No Content' : 'OK',
        headers: [],
        body: null,
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    },
  );

const readHeader = (headers, name) => {
  if (headers instanceof Headers) {
    return headers.get(name);
  }

  return headers[name] ?? headers[name.toLowerCase()];
};

describe('createProxyFetch', () => {
  const previousServiceUrl = process.env[PROXY_FETCH_SERVICE_URL_ENV];
  const previousDefaultTimeoutMs =
    process.env[PROXY_FETCH_DEFAULT_TIMEOUT_MS_ENV];

  afterEach(() => {
    if (previousServiceUrl === undefined) {
      delete process.env[PROXY_FETCH_SERVICE_URL_ENV];
    } else {
      process.env[PROXY_FETCH_SERVICE_URL_ENV] = previousServiceUrl;
    }

    if (previousDefaultTimeoutMs === undefined) {
      delete process.env[PROXY_FETCH_DEFAULT_TIMEOUT_MS_ENV];

      return;
    }

    process.env[PROXY_FETCH_DEFAULT_TIMEOUT_MS_ENV] = previousDefaultTimeoutMs;
  });

  it('uses a six minute default timeout for LLM-oriented requests', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(DEFAULT_LLM_TIMEOUT_MS);
  });

  it('documents the six minute default timeout in .env.example', () => {
    const envExample = fs.readFileSync(
      path.join(__dirname, '..', '.env.example'),
      'utf8',
    );

    expect(envExample).toContain(
      `PROXY_FETCH_DEFAULT_TIMEOUT_MS=${DEFAULT_LLM_TIMEOUT_MS}`,
    );
  });

  it('sends a no-body request as a JSON envelope', async () => {
    process.env[PROXY_FETCH_SERVICE_URL_ENV] = SERVICE_URL;

    let capturedUrl;
    let capturedInit;

    const fetchImpl = async (url, init) => {
      capturedUrl = url.toString();
      capturedInit = init;

      return createEmptyServiceResponse();
    };

    const proxyFetch = createProxyFetch({
      apiKey: API_KEY,
      defaultContext: {
        flowKey: 'default-flow',
        metadata: {
          tenantId: 'tenant-a',
        },
      },
      defaultHeaders: {
        accept: 'text/html',
      },
      fetchImpl,
    });

    await proxyFetch(TARGET_URL, {
      context: {
        useCase: 'catalog',
        metadata: {
          requestId: 'request-a',
        },
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    expect(capturedUrl).toBe(SERVICE_URL);
    expect(capturedInit.method).toBe('POST');
    expect(readHeader(capturedInit.headers, 'accept')).toBe(
      SERVICE_ACCEPT_HEADER_VALUE,
    );
    expect(readHeader(capturedInit.headers, 'authorization')).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(readHeader(capturedInit.headers, 'content-type')).toBe(
      'application/json',
    );

    expect(JSON.parse(capturedInit.body)).toEqual({
      version: WIRE_PROTOCOL_VERSION,
      request: {
        url: TARGET_URL,
        method: 'GET',
        headers: [['accept', 'text/html']],
        body: null,
      },
      options: {
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
      context: {
        flowKey: 'default-flow',
        useCase: 'catalog',
        metadata: {
          tenantId: 'tenant-a',
          requestId: 'request-a',
        },
      },
    });
  });

  it('uses the default timeout constant when a request timeout is not provided', async () => {
    process.env[PROXY_FETCH_SERVICE_URL_ENV] = SERVICE_URL;

    let capturedInit;

    const fetchImpl = async (_url, init) => {
      capturedInit = init;

      return createEmptyServiceResponse();
    };

    const proxyFetch = createProxyFetch({ fetchImpl });

    await proxyFetch(TARGET_URL);

    expect(JSON.parse(capturedInit.body).options.timeoutMs).toBe(
      DEFAULT_TIMEOUT_MS,
    );
  });

  it('uses the environment default timeout when options do not override it', async () => {
    process.env[PROXY_FETCH_SERVICE_URL_ENV] = SERVICE_URL;
    process.env[PROXY_FETCH_DEFAULT_TIMEOUT_MS_ENV] = String(ENV_TIMEOUT_MS);

    let capturedInit;

    const fetchImpl = async (_url, init) => {
      capturedInit = init;

      return createEmptyServiceResponse();
    };

    const proxyFetch = createProxyFetch({ fetchImpl });

    await proxyFetch(TARGET_URL);

    expect(JSON.parse(capturedInit.body).options.timeoutMs).toBe(
      ENV_TIMEOUT_MS,
    );
  });

  it('aborts the local service request when timeoutMs expires', async () => {
    let capturedSignal;

    const fetchImpl = async (_url, init) => {
      capturedSignal = init.signal;

      if (init.signal.aborted) {
        throw init.signal.reason;
      }

      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => {
            reject(init.signal.reason);
          },
          {
            once: true,
          },
        );
      });
    };

    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl,
    });

    await expect(
      proxyFetch(TARGET_URL, {
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'Proxy fetch request timed out after 1 ms.',
    });

    expect(capturedSignal.aborted).toBe(true);
  });

  it('aborts the local service request when the user signal aborts', async () => {
    const controller = new AbortController();
    const abortReason = new DOMException('User cancelled.', 'AbortError');
    let capturedSignal;
    let markFetchStarted;
    const fetchStarted = new Promise((resolve) => {
      markFetchStarted = resolve;
    });

    const fetchImpl = async (_url, init) => {
      capturedSignal = init.signal;
      markFetchStarted();

      if (init.signal.aborted) {
        throw init.signal.reason;
      }

      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => {
            reject(init.signal.reason);
          },
          {
            once: true,
          },
        );
      });
    };

    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl,
    });
    const requestPromise = proxyFetch(TARGET_URL, {
      signal: controller.signal,
    });

    await fetchStarted;
    controller.abort(abortReason);

    await expect(requestPromise).rejects.toBe(abortReason);
    expect(capturedSignal.aborted).toBe(true);
  });

  it('resolves target HTTP errors as normal fetch responses', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          version: WIRE_PROTOCOL_VERSION,
          ok: true,
          response: {
            url: TARGET_URL,
            status: 404,
            statusText: 'Not Found',
            headers: [['content-type', 'text/plain']],
            body: {
              kind: 'text',
              text: 'missing',
            },
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );

    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl,
    });

    const response = await proxyFetch(TARGET_URL);

    expect(response.status).toBe(404);
    expect(response.ok).toBe(false);
    expect(await response.text()).toBe('missing');
  });

  it('rejects structured service failures with a typed error', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          version: WIRE_PROTOCOL_VERSION,
          ok: false,
          error: {
            code: 'REQUEST_TIMEOUT',
            message: 'Request timed out.',
            retryable: true,
            details: {
              phase: 'target-request',
            },
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );

    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl,
    });

    await expect(proxyFetch(TARGET_URL)).rejects.toMatchObject({
      name: 'ProxyFetchServiceError',
      code: 'REQUEST_TIMEOUT',
      retryable: true,
      details: {
        phase: 'target-request',
      },
    });

    await expect(proxyFetch(TARGET_URL)).rejects.toBeInstanceOf(
      ProxyFetchServiceError,
    );
  });

  it('requires a service URL from options or environment', () => {
    delete process.env[PROXY_FETCH_SERVICE_URL_ENV];

    expect(() => createProxyFetch()).toThrow(PROXY_FETCH_SERVICE_URL_ENV);
  });
});
