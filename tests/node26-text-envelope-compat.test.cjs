const {
  WIRE_PROTOCOL_VERSION,
  createProxyFetch,
} = require('../dist/index.cjs');

const SERVICE_URL = 'https://proxy-fetch-service.example';
const TARGET_URL = 'https://example.test/unicode';

const createProxyFetchForBody = (
  body,
  headers = [['content-type', 'text/plain; charset=utf-8']],
) =>
  createProxyFetch({
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
            headers,
            body,
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
  });

const readBytes = async (response) =>
  Array.from(new Uint8Array(await response.arrayBuffer()));

describe('Node.js 26 Fetch API text envelope compatibility', () => {
  it('treats Latin-1-looking text envelope values as real UTF-8 text', async () => {
    const text = 'ð ñ ÿ';
    const proxyFetch = createProxyFetchForBody({
      kind: 'text',
      text,
    });

    const response = await proxyFetch(TARGET_URL);
    const native = new Response(text, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
      },
    });

    expect(await response.clone().text()).toBe(text);
    expect(await readBytes(response)).toEqual(await readBytes(native));
  });

  it('preserves emoji and non-Latin text envelope values as real UTF-8 text', async () => {
    const text = 'Привет, κόσμε, こんにちは, 😀';
    const proxyFetch = createProxyFetchForBody({
      kind: 'text',
      text,
    });

    const response = await proxyFetch(TARGET_URL);
    const native = new Response(text);

    expect(await response.clone().text()).toBe(text);
    expect(await readBytes(response)).toEqual(await readBytes(native));
  });

  it('preserves arbitrary binary bytes through base64 byte transport, not text transport', async () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0xfd, 0x00, 0x41]);
    const proxyFetch = createProxyFetchForBody(
      {
        kind: 'base64',
        data: Buffer.from(bytes).toString('base64'),
      },
      [['content-type', 'application/octet-stream']],
    );

    const response = await proxyFetch(TARGET_URL);

    expect(await readBytes(response)).toEqual(Array.from(bytes));
  });
});
