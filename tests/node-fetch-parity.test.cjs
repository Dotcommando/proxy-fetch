const {
  WIRE_PROTOCOL_VERSION,
  createProxyFetch,
} = require('../dist/index.cjs');

const SERVICE_URL = 'https://proxy-fetch-service.example';
const TARGET_URL = 'https://example.com/resource';
const FINAL_URL = 'https://example.com/final';
const JSON_BODY = JSON.stringify({
  ok: true,
  value: 42,
});
const TEXT_BODY = 'plain response body';
const BINARY_BODY = Uint8Array.from([0, 1, 2, 3, 254, 255]);

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

const createSuccessEnvelope = (response) => ({
  version: WIRE_PROTOCOL_VERSION,
  ok: true,
  response,
});

const expectCoreResponseParity = (proxyResponse, nativeResponse) => {
  expect(proxyResponse.status).toBe(nativeResponse.status);
  expect(proxyResponse.statusText).toBe(nativeResponse.statusText);
  expect(proxyResponse.ok).toBe(nativeResponse.ok);
  expect(proxyResponse.url).toBe(nativeResponse.url);
  expect(proxyResponse.redirected).toBe(nativeResponse.redirected);
  expect(proxyResponse.type).toBe(nativeResponse.type);
};

describe('Node.js Fetch API deterministic parity baseline', () => {
  it('matches native Response semantics for a JSON response', async () => {
    const nativeResponse = new Response(JSON_BODY, {
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'application/json',
      },
    });
    const proxyFetch = createProxyFetchForEnvelope(
      createSuccessEnvelope({
        url: nativeResponse.url,
        status: nativeResponse.status,
        statusText: nativeResponse.statusText,
        headers: Array.from(nativeResponse.headers.entries()),
        body: {
          kind: 'text',
          text: JSON_BODY,
        },
        redirected: nativeResponse.redirected,
        type: nativeResponse.type,
      }),
    );

    const proxyResponse = await proxyFetch(TARGET_URL);

    expectCoreResponseParity(proxyResponse, nativeResponse);
    expect(proxyResponse.headers.get('content-type')).toBe(
      nativeResponse.headers.get('content-type'),
    );
    expect(await proxyResponse.json()).toEqual(await nativeResponse.json());
  });

  it('matches native Response semantics for target HTTP errors without rejecting', async () => {
    const nativeResponse = new Response(TEXT_BODY, {
      status: 404,
      statusText: 'Not Found',
      headers: {
        'content-type': 'text/plain',
      },
    });
    const proxyFetch = createProxyFetchForEnvelope(
      createSuccessEnvelope({
        url: nativeResponse.url,
        status: nativeResponse.status,
        statusText: nativeResponse.statusText,
        headers: Array.from(nativeResponse.headers.entries()),
        body: {
          kind: 'text',
          text: TEXT_BODY,
        },
        redirected: nativeResponse.redirected,
        type: nativeResponse.type,
      }),
    );

    const proxyResponse = await proxyFetch(TARGET_URL);

    expectCoreResponseParity(proxyResponse, nativeResponse);
    expect(proxyResponse.ok).toBe(false);
    expect(await proxyResponse.text()).toBe(await nativeResponse.text());
  });

  it('matches native Response body consumption state for cloned text responses', async () => {
    const proxyFetch = createProxyFetchForEnvelope(
      createSuccessEnvelope({
        url: TARGET_URL,
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'text/plain']],
        body: {
          kind: 'text',
          text: TEXT_BODY,
        },
        redirected: false,
        type: 'default',
      }),
    );

    const proxyResponse = await proxyFetch(TARGET_URL);
    const clone = proxyResponse.clone();

    expect(proxyResponse.bodyUsed).toBe(false);
    expect(clone.bodyUsed).toBe(false);
    expect(await proxyResponse.text()).toBe(TEXT_BODY);
    expect(proxyResponse.bodyUsed).toBe(true);
    expect(clone.bodyUsed).toBe(false);
    expect(await clone.text()).toBe(TEXT_BODY);
    expect(clone.bodyUsed).toBe(true);
  });

  it('matches native Response semantics for binary responses', async () => {
    const nativeResponse = new Response(BINARY_BODY, {
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'application/octet-stream',
      },
    });
    const proxyFetch = createProxyFetchForEnvelope(
      createSuccessEnvelope({
        url: nativeResponse.url,
        status: nativeResponse.status,
        statusText: nativeResponse.statusText,
        headers: Array.from(nativeResponse.headers.entries()),
        body: {
          kind: 'base64',
          data: Buffer.from(BINARY_BODY).toString('base64'),
        },
        redirected: nativeResponse.redirected,
        type: nativeResponse.type,
      }),
    );

    const proxyResponse = await proxyFetch(TARGET_URL);

    expectCoreResponseParity(proxyResponse, nativeResponse);
    expect(
      Array.from(new Uint8Array(await proxyResponse.arrayBuffer())),
    ).toEqual(Array.from(new Uint8Array(await nativeResponse.arrayBuffer())));
  });

  it('matches native Headers set-cookie behavior when duplicate header pairs are returned', async () => {
    const nativeResponse = new Response(TEXT_BODY, {
      status: 200,
      headers: [
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ],
    });
    const proxyFetch = createProxyFetchForEnvelope(
      createSuccessEnvelope({
        url: nativeResponse.url,
        status: nativeResponse.status,
        statusText: nativeResponse.statusText,
        headers: [
          ['set-cookie', 'a=1'],
          ['set-cookie', 'b=2'],
        ],
        body: {
          kind: 'text',
          text: TEXT_BODY,
        },
        redirected: nativeResponse.redirected,
        type: nativeResponse.type,
      }),
    );

    const proxyResponse = await proxyFetch(TARGET_URL);

    expect(proxyResponse.headers.get('set-cookie')).toBe(
      nativeResponse.headers.get('set-cookie'),
    );
    expect(proxyResponse.headers.getSetCookie()).toEqual(
      nativeResponse.headers.getSetCookie(),
    );
  });

  it('preserves final URL and redirected metadata from the service response', async () => {
    const proxyFetch = createProxyFetchForEnvelope(
      createSuccessEnvelope({
        url: FINAL_URL,
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'text/plain']],
        body: {
          kind: 'text',
          text: TEXT_BODY,
        },
        redirected: true,
        type: 'basic',
      }),
    );

    const proxyResponse = await proxyFetch(TARGET_URL);

    expect(proxyResponse.url).toBe(FINAL_URL);
    expect(proxyResponse.redirected).toBe(true);
    expect(proxyResponse.type).toBe('basic');
  });
});
