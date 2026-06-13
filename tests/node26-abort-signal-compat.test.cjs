const {
  WIRE_PROTOCOL_VERSION,
  createProxyFetch,
} = require('../dist/index.cjs');

const SERVICE_URL = 'https://proxy-fetch-service.example';
const TARGET_URL = 'https://example.test/slow';

const neverSettlingFetch = async (_url, init) =>
  new Promise((_resolve, reject) => {
    if (init.signal.aborted) {
      reject(init.signal.reason);

      return;
    }

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

const createProxyFetchWithFetchImpl = (fetchImpl) =>
  createProxyFetch({
    serviceUrl: SERVICE_URL,
    fetchImpl,
  });

const createEmptyResponse = () =>
  new Response(
    JSON.stringify({
      version: WIRE_PROTOCOL_VERSION,
      ok: true,
      response: {
        url: TARGET_URL,
        status: 204,
        statusText: 'No Content',
        headers: [],
        body: null,
      },
    }),
    {
      headers: {
        'content-type': 'application/json',
      },
    },
  );

describe('Node.js 26 Fetch API AbortSignal compatibility', () => {
  it('preserves already-aborted custom Error reasons', async () => {
    const reason = new Error('custom abort');
    const controller = new AbortController();
    const proxyFetch = createProxyFetchWithFetchImpl(async () =>
      createEmptyResponse(),
    );

    controller.abort(reason);

    await expect(
      proxyFetch(TARGET_URL, {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it('preserves AbortSignal.timeout TimeoutError reason', async () => {
    const proxyFetch = createProxyFetchWithFetchImpl(neverSettlingFetch);

    await expect(
      proxyFetch(TARGET_URL, {
        signal: AbortSignal.timeout(10),
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('preserves AbortSignal.any first abort reason', async () => {
    const reason = new Error('manual abort');
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(1000),
    ]);
    const proxyFetch = createProxyFetchWithFetchImpl(neverSettlingFetch);
    const promise = proxyFetch(TARGET_URL, {
      signal,
      timeoutMs: 1000,
    });

    controller.abort(reason);

    await expect(promise).rejects.toBe(reason);
  });
});
