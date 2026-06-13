const { ReadableStream } = require('node:stream/web');

const {
  WIRE_PROTOCOL_VERSION,
  createProxyFetch,
} = require('../dist/index.cjs');

const SERVICE_URL = 'https://proxy-fetch-service.example';
const TARGET_URL = 'https://example.com/resource';
const FINAL_URL = 'https://example.com/final';

const createEmptyJsonServiceResponse = () =>
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
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    },
  );

const captureJsonEnvelope = async (init) => {
  let capturedInit;

  const proxyFetch = createProxyFetch({
    serviceUrl: SERVICE_URL,
    fetchImpl: async (_url, serviceInit) => {
      capturedInit = serviceInit;

      return createEmptyJsonServiceResponse();
    },
  });

  await proxyFetch(TARGET_URL, init);

  return JSON.parse(capturedInit.body);
};

const captureMultipartMeta = async (init) => {
  let capturedInit;

  const proxyFetch = createProxyFetch({
    serviceUrl: SERVICE_URL,
    fetchImpl: async (_url, serviceInit) => {
      capturedInit = serviceInit;

      return createEmptyJsonServiceResponse();
    },
  });

  await proxyFetch(TARGET_URL, init);

  return readMultipartMeta(capturedInit);
};

const readMultipartMeta = async (capturedInit) => {
  if (capturedInit.body instanceof FormData) {
    const metaPart = capturedInit.body.get('meta');
    const metaText =
      typeof metaPart === 'string' ? metaPart : await metaPart.text();

    return JSON.parse(metaText);
  }

  const contentType = capturedInit.headers['content-type'];
  const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1];

  expect(boundary).toEqual(expect.any(String));

  const bytes = Buffer.from(
    await new Response(capturedInit.body).arrayBuffer(),
  );
  const metadataHeadersEnd = bytes.indexOf(Buffer.from('\r\n\r\n'));
  const metadataBodyStart = metadataHeadersEnd + '\r\n\r\n'.length;
  const metadataBodyEnd = bytes.indexOf(
    Buffer.from(`\r\n--${boundary}`),
    metadataBodyStart,
  );

  expect(metadataHeadersEnd).toBeGreaterThan(-1);
  expect(metadataBodyEnd).toBeGreaterThan(-1);

  return JSON.parse(
    bytes.subarray(metadataBodyStart, metadataBodyEnd).toString('utf8'),
  );
};

const createTextResponseEnvelope = (responseFields) => ({
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
    ...responseFields,
  },
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

describe('Node.js Fetch API compatibility contract', () => {
  it('serializes Request.mode for the service execution layer', async () => {
    const envelope = await captureJsonEnvelope({
      mode: 'no-cors',
    });

    expect(envelope.request).toMatchObject({
      mode: 'no-cors',
    });
  });

  it('serializes Request.credentials for the service execution layer', async () => {
    const envelope = await captureJsonEnvelope({
      credentials: 'include',
    });

    expect(envelope.request).toMatchObject({
      credentials: 'include',
    });
  });

  it('serializes Request.cache for the service execution layer', async () => {
    const envelope = await captureJsonEnvelope({
      cache: 'no-store',
    });

    expect(envelope.request).toMatchObject({
      cache: 'no-store',
    });
  });

  it('serializes Request.redirect for the service execution layer', async () => {
    const envelope = await captureJsonEnvelope({
      redirect: 'manual',
    });

    expect(envelope.request).toMatchObject({
      redirect: 'manual',
    });
  });

  it('serializes Request.referrer for the service execution layer', async () => {
    const envelope = await captureJsonEnvelope({
      referrer: 'https://referrer.example/path',
    });

    expect(envelope.request).toMatchObject({
      referrer: 'https://referrer.example/path',
    });
  });

  it('serializes Request.referrerPolicy for the service execution layer', async () => {
    const envelope = await captureJsonEnvelope({
      referrerPolicy: 'no-referrer',
    });

    expect(envelope.request).toMatchObject({
      referrerPolicy: 'no-referrer',
    });
  });

  it('serializes Request.integrity for the service execution layer', async () => {
    const envelope = await captureJsonEnvelope({
      integrity: 'sha256-abc',
    });

    expect(envelope.request).toMatchObject({
      integrity: 'sha256-abc',
    });
  });

  it('serializes Request.keepalive for the service execution layer', async () => {
    const envelope = await captureJsonEnvelope({
      keepalive: true,
    });

    expect(envelope.request).toMatchObject({
      keepalive: true,
    });
  });

  it('serializes Request.duplex for ReadableStream request bodies', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    const envelope = await captureMultipartMeta({
      method: 'POST',
      body: stream,
      duplex: 'half',
    });

    expect(envelope.request).toMatchObject({
      duplex: 'half',
    });
  });

  it('does not silently ignore the Node.js fetch dispatcher option', async () => {
    const dispatcher = {
      dispatch() {
        throw new Error('dispatcher should not be invoked by this test');
      },
    };
    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl: async () => createEmptyJsonServiceResponse(),
    });

    await expect(
      proxyFetch(TARGET_URL, {
        dispatcher,
      }),
    ).rejects.toThrow(/dispatcher/i);
  });

  it('serializes Request.duplex when the input is a Request with a stream body', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const request = new Request(TARGET_URL, {
      method: 'POST',
      body: stream,
      duplex: 'half',
    });
    let capturedInit;
    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl: async (_url, serviceInit) => {
        capturedInit = serviceInit;

        return createEmptyJsonServiceResponse();
      },
    });

    await proxyFetch(request);

    const envelope = await readMultipartMeta(capturedInit);

    expect(envelope.request).toMatchObject({
      duplex: 'half',
    });
  });

  it('exposes Response.url from the service response envelope', async () => {
    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl: async () =>
        new Response(
          JSON.stringify(
            createTextResponseEnvelope({
              url: FINAL_URL,
            }),
          ),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        ),
    });

    const response = await proxyFetch(TARGET_URL);

    expect(response.url).toBe(FINAL_URL);
  });

  it('exposes Response.redirected from the service response envelope', async () => {
    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl: async () =>
        new Response(
          JSON.stringify(
            createTextResponseEnvelope({
              redirected: true,
            }),
          ),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        ),
    });

    const response = await proxyFetch(TARGET_URL);

    expect(response.redirected).toBe(true);
  });

  it('exposes Response.type from the service response envelope', async () => {
    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl: async () =>
        new Response(
          JSON.stringify(
            createTextResponseEnvelope({
              type: 'basic',
            }),
          ),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        ),
    });

    const response = await proxyFetch(TARGET_URL);

    expect(response.type).toBe('basic');
  });

  it('reconstructs Response.error-like service envelopes as error responses', async () => {
    const proxyFetch = createProxyFetchForEnvelope({
      version: WIRE_PROTOCOL_VERSION,
      ok: true,
      response: {
        url: '',
        status: 0,
        statusText: '',
        headers: [],
        body: null,
        redirected: false,
        type: 'error',
      },
    });

    const response = await proxyFetch(TARGET_URL);

    expect(response.type).toBe('error');
    expect(response.status).toBe(0);
    expect(response.statusText).toBe('');
    expect(response.ok).toBe(false);
    expect(response.url).toBe('');
    expect(response.body).toBe(null);
  });

  it('does not reconstruct opaque redirect envelopes as normal basic responses', async () => {
    const proxyFetch = createProxyFetchForEnvelope({
      version: WIRE_PROTOCOL_VERSION,
      ok: true,
      response: {
        url: TARGET_URL,
        status: 0,
        statusText: '',
        headers: [],
        body: null,
        redirected: false,
        type: 'opaqueredirect',
      },
    });

    const response = await proxyFetch(TARGET_URL);

    expect(response.type).toBe('opaqueredirect');
    expect(response.status).toBe(0);
    expect(response.ok).toBe(false);
    expect(response.body).toBe(null);
  });
});
