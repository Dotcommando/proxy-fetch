const {
  WIRE_PROTOCOL_VERSION,
  createProxyFetch,
} = require('../dist/index.cjs');

const SERVICE_URL = 'https://proxy-fetch-service.example';
const TARGET_URL = 'data:text/plain,native';
const FINAL_URL = 'https://example.com/final';

const createSuccessEnvelope = (response) => ({
  version: WIRE_PROTOCOL_VERSION,
  ok: true,
  response,
});

const createProxyFetchForEnvelope = (envelope) =>
  createProxyFetch({
    serviceUrl: SERVICE_URL,
    fetchImpl: async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
  });

const createProxyResponse = async (responseFields) => {
  const proxyFetch = createProxyFetchForEnvelope(
    createSuccessEnvelope({
      url: TARGET_URL,
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'text/plain']],
      body: {
        kind: 'text',
        text: 'proxy',
      },
      redirected: false,
      type: 'basic',
      ...responseFields,
    }),
  );

  return proxyFetch(TARGET_URL);
};

const readBytes = async (response) =>
  Array.from(new Uint8Array(await response.arrayBuffer()));

describe('Node.js 26 Fetch API Response reconstruction compatibility', () => {
  it('preserves reconstructed response metadata after clone()', async () => {
    const response = await createProxyResponse({
      url: FINAL_URL,
      redirected: true,
      type: 'basic',
    });
    const clone = response.clone();

    expect(clone.url).toBe(response.url);
    expect(clone.redirected).toBe(response.redirected);
    expect(clone.type).toBe(response.type);
    expect(clone.status).toBe(response.status);
    expect(clone.statusText).toBe(response.statusText);
  });

  it('matches native fetched response header immutability', async () => {
    const nativeResponse = await fetch(TARGET_URL);
    const proxyResponse = await createProxyResponse();

    expect(() => nativeResponse.headers.set('x-test', '1')).toThrow(
      /immutable/i,
    );
    expect(() => proxyResponse.headers.set('x-test', '1')).toThrow(
      /immutable/i,
    );
  });

  it('does not add own data properties for Web IDL Response attributes', async () => {
    const nativeResponse = await fetch(TARGET_URL);
    const proxyResponse = await createProxyResponse({
      url: FINAL_URL,
      redirected: true,
      type: 'basic',
    });

    for (const property of [
      'url',
      'redirected',
      'status',
      'statusText',
      'type',
    ]) {
      expect(Object.hasOwn(nativeResponse, property)).toBe(false);
      expect(Object.hasOwn(proxyResponse, property)).toBe(false);
    }
  });

  it('preserves response bytes for text/plain payloads through base64 byte transport', async () => {
    const originalBytes = [0xff, 0xfe, 0xfd];
    const nativeResponse = new Response(Uint8Array.from(originalBytes), {
      status: 200,
      headers: {
        'content-type': 'text/plain',
      },
    });
    const proxyResponse = await createProxyResponse({
      headers: [['content-type', 'text/plain']],
      body: {
        kind: 'base64',
        data: Buffer.from(originalBytes).toString('base64'),
      },
    });

    expect(await readBytes(proxyResponse)).toEqual(
      await readBytes(nativeResponse),
    );
  });

  it.each([
    {
      status: 204,
      statusText: 'No Content',
    },
    {
      status: 205,
      statusText: 'Reset Content',
    },
    {
      status: 304,
      statusText: 'Not Modified',
    },
  ])(
    'returns a null-body Response for status $status',
    async ({ status, statusText }) => {
      const response = await createProxyResponse({
        status,
        statusText,
        body: {
          kind: 'text',
          text: 'service body must not become a response body',
        },
      });

      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(await response.text()).toBe('');
    },
  );
});
