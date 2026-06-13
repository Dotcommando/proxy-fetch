const {
  WIRE_PROTOCOL_VERSION,
  createProxyFetch,
} = require('../dist/index.cjs');

const SERVICE_URL = 'https://proxy-fetch-service.example';
const TARGET_URL = 'https://example.test/resource';

const createEmptyServiceResponse = () =>
  new Response(
    JSON.stringify({
      version: WIRE_PROTOCOL_VERSION,
      ok: true,
      response: {
        url: TARGET_URL,
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'text/plain']],
        body: {
          kind: 'text',
          text: 'ok',
        },
      },
    }),
    {
      headers: {
        'content-type': 'application/json',
      },
    },
  );

const captureEnvelope = async (options = {}, init = {}) => {
  let capturedInit;
  const proxyFetch = createProxyFetch({
    serviceUrl: SERVICE_URL,
    fetchImpl: async (_url, serviceInit) => {
      capturedInit = serviceInit;

      return createEmptyServiceResponse();
    },
    ...options,
  });

  await proxyFetch(TARGET_URL, init);

  return JSON.parse(capturedInit.body);
};

describe('Node.js 26 Fetch API function and defaultHeaders compatibility', () => {
  it('exposes a fetch-like function name and arity', () => {
    const proxyFetch = createProxyFetch({ serviceUrl: SERVICE_URL });

    expect(proxyFetch.name).toBe(fetch.name);
    expect(proxyFetch.length).toBe(fetch.length);
  });

  it('works when passed as a fetch-like function', async () => {
    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl: async () => createEmptyServiceResponse(),
    });
    const usesFetch = async (fetchLike) => {
      const response = await fetchLike(TARGET_URL);

      return response.text();
    };

    await expect(usesFetch(proxyFetch)).resolves.toBe('ok');
  });

  it('rejects invalid default header names through native Headers validation', async () => {
    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      defaultHeaders: {
        'bad header name': 'value',
      },
      fetchImpl: async () => createEmptyServiceResponse(),
    });

    await expect(proxyFetch(TARGET_URL)).rejects.toMatchObject({
      name: 'TypeError',
    });
  });

  it('lets request headers override default headers', async () => {
    const envelope = await captureEnvelope(
      {
        defaultHeaders: {
          'x-test': 'default',
        },
      },
      {
        headers: {
          'x-test': 'request',
        },
      },
    );

    expect(envelope.request.headers).toContainEqual(['x-test', 'request']);
    expect(envelope.request.headers).not.toContainEqual(['x-test', 'default']);
  });

  it('does not mutate caller-owned default Headers objects', async () => {
    const defaultHeaders = new Headers({
      'x-test': 'default',
    });

    await captureEnvelope({ defaultHeaders });

    expect(defaultHeaders.get('x-test')).toBe('default');
  });
});
