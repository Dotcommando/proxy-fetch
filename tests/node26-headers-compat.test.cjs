const {
  WIRE_PROTOCOL_VERSION,
  createProxyFetch,
} = require('../dist/index.cjs');

const SERVICE_URL = 'https://proxy-fetch-service.example';
const TARGET_URL = 'data:text/plain,native';

const createProxyResponse = async () => {
  const proxyFetch = createProxyFetch({
    serviceUrl: SERVICE_URL,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          version: WIRE_PROTOCOL_VERSION,
          ok: true,
          response: {
            url: TARGET_URL,
            status: 200,
            statusText: 'OK',
            redirected: false,
            type: 'basic',
            headers: [['content-type', 'text/plain;charset=UTF-8']],
            body: {
              kind: 'text',
              text: 'proxy',
            },
          },
        }),
        {
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
  });

  return proxyFetch(TARGET_URL);
};

const captureError = (fn) => {
  try {
    fn();

    return undefined;
  } catch (error) {
    return error;
  }
};

describe('Node.js 26 Fetch API response headers compatibility', () => {
  it('throws TypeError for direct mutation methods like native fetch responses', async () => {
    const native = await fetch(TARGET_URL);
    const proxy = await createProxyResponse();

    for (const method of ['set', 'append', 'delete']) {
      const nativeError = captureError(() =>
        native.headers[method]('x-test', '1'),
      );
      const proxyError = captureError(() =>
        proxy.headers[method]('x-test', '1'),
      );

      expect(nativeError?.name).toBe('TypeError');
      expect(proxyError?.name).toBe(nativeError?.name);
    }
  });

  it('throws TypeError for prototype mutation method calls', async () => {
    const proxy = await createProxyResponse();

    expect(
      captureError(() =>
        Headers.prototype.set.call(proxy.headers, 'x-test', '1'),
      )?.name,
    ).toBe('TypeError');
    expect(
      captureError(() =>
        Headers.prototype.append.call(proxy.headers, 'x-test', '1'),
      )?.name,
    ).toBe('TypeError');
    expect(
      captureError(() =>
        Headers.prototype.delete.call(proxy.headers, 'content-type'),
      )?.name,
    ).toBe('TypeError');
  });

  it('native fetched responses also throw TypeError for prototype mutation method calls', async () => {
    const native = await fetch(TARGET_URL);

    expect(
      captureError(() =>
        Headers.prototype.set.call(native.headers, 'x-test', '1'),
      )?.name,
    ).toBe('TypeError');
    expect(
      captureError(() =>
        Headers.prototype.append.call(native.headers, 'x-test', '1'),
      )?.name,
    ).toBe('TypeError');
    expect(
      captureError(() =>
        Headers.prototype.delete.call(native.headers, 'content-type'),
      )?.name,
    ).toBe('TypeError');
  });

  it('keeps Headers brand and read behavior compatible', async () => {
    const native = await fetch(TARGET_URL);
    const proxy = await createProxyResponse();

    expect(proxy.headers instanceof Headers).toBe(true);
    expect(Object.prototype.toString.call(proxy.headers)).toBe(
      Object.prototype.toString.call(native.headers),
    );
    expect(proxy.headers.get('content-type')).toBe('text/plain;charset=UTF-8');
    expect(Array.from(proxy.headers.entries())).toEqual([
      ['content-type', 'text/plain;charset=UTF-8'],
    ]);
  });
});
