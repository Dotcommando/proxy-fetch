const {
  INVALID_SERVICE_RESPONSE_CODE,
  SERVICE_HTTP_ERROR_CODE,
  WIRE_PROTOCOL_VERSION,
  createProxyFetch,
  InvalidServiceResponseError,
  ProxyFetchServiceError,
} = require('../dist/index.cjs');

const SERVICE_URL = 'https://proxy-fetch-service.example';
const TARGET_URL = 'https://example.com/resource';
const CRLF = '\r\n';

const createProxyFetchForResponse = (createServiceResponse) =>
  createProxyFetch({
    serviceUrl: SERVICE_URL,
    fetchImpl: async () => createServiceResponse(),
  });

const createJsonServiceResponse = (payload, init = {}) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
    ...init,
  });

const createRawMultipartServiceResponse = ({ boundary, metadata, body }) => {
  const payload = Buffer.concat([
    Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="meta"',
        'Content-Type: application/json',
        '',
        JSON.stringify(metadata),
        `--${boundary}`,
        'Content-Disposition: form-data; name="body"; filename="body"',
        'Content-Type: application/octet-stream',
        '',
      ].join(CRLF),
    ),
    Buffer.from(CRLF),
    Buffer.from(body),
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
  ]);

  return new Response(payload, {
    status: 200,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  });
};

describe('Node.js 26 Fetch API service transport compatibility', () => {
  it('preserves binary response bytes that contain a non-terminal multipart boundary terminator', async () => {
    const boundary = 'proxy-fetch-boundary-exact-collision-test';
    const body = Buffer.from(`hello${CRLF}--${boundary}--${CRLF}world`);
    const proxyFetch = createProxyFetchForResponse(() =>
      createRawMultipartServiceResponse({
        boundary,
        metadata: {
          version: WIRE_PROTOCOL_VERSION,
          ok: true,
          response: {
            url: TARGET_URL,
            status: 200,
            statusText: 'OK',
            headers: [['content-type', 'application/octet-stream']],
            body: {
              kind: 'binary',
              partName: 'body',
            },
          },
        },
        body,
      }),
    );

    const response = await proxyFetch(TARGET_URL);
    const bytes = Buffer.from(await response.arrayBuffer());

    expect(bytes.equals(body)).toBe(true);
  });

  it('preserves binary response bytes that contain the multipart boundary marker', async () => {
    const boundary = 'proxy-fetch-boundary-collision-test';
    const body = Buffer.from(`prefix${CRLF}--${boundary}--suffix`);
    const proxyFetch = createProxyFetchForResponse(() =>
      createRawMultipartServiceResponse({
        boundary,
        metadata: {
          version: WIRE_PROTOCOL_VERSION,
          ok: true,
          response: {
            url: TARGET_URL,
            status: 200,
            statusText: 'OK',
            headers: [['content-type', 'application/octet-stream']],
            body: {
              kind: 'binary',
              partName: 'body',
            },
          },
        },
        body,
      }),
    );

    const response = await proxyFetch(TARGET_URL);
    const bytes = Buffer.from(await response.arrayBuffer());

    expect(bytes.equals(body)).toBe(true);
  });

  it('distinguishes target HTTP errors from service HTTP errors', async () => {
    const proxyFetch = createProxyFetchForResponse(() =>
      createJsonServiceResponse({
        version: WIRE_PROTOCOL_VERSION,
        ok: true,
        response: {
          url: TARGET_URL,
          status: 500,
          statusText: 'Internal Server Error',
          headers: [],
          body: null,
        },
      }),
    );

    const response = await proxyFetch(TARGET_URL);

    expect(response.status).toBe(500);
    expect(response.ok).toBe(false);
  });

  it('throws ProxyFetchServiceError for service HTTP errors', async () => {
    const proxyFetch = createProxyFetchForResponse(
      () =>
        new Response('service failed', {
          status: 500,
          statusText: 'Internal Server Error',
        }),
    );

    await expect(proxyFetch(TARGET_URL)).rejects.toMatchObject({
      name: 'ProxyFetchServiceError',
      code: SERVICE_HTTP_ERROR_CODE,
    });
    await expect(proxyFetch(TARGET_URL)).rejects.toBeInstanceOf(
      ProxyFetchServiceError,
    );
  });

  it('throws InvalidServiceResponseError for invalid service envelopes', async () => {
    const proxyFetch = createProxyFetchForResponse(() =>
      createJsonServiceResponse({
        version: WIRE_PROTOCOL_VERSION,
        ok: true,
        response: {
          url: TARGET_URL,
          status: 200,
          statusText: 'OK',
          headers: [],
          body: {
            kind: 'unsupported',
          },
        },
      }),
    );

    await expect(proxyFetch(TARGET_URL)).rejects.toMatchObject({
      name: 'InvalidServiceResponseError',
      code: INVALID_SERVICE_RESPONSE_CODE,
    });
    await expect(proxyFetch(TARGET_URL)).rejects.toBeInstanceOf(
      InvalidServiceResponseError,
    );
  });

  it('maps upstream target fetch failures returned by the service to a stable service error', async () => {
    const proxyFetch = createProxyFetchForResponse(() =>
      createJsonServiceResponse({
        version: WIRE_PROTOCOL_VERSION,
        ok: false,
        error: {
          code: 'UPSTREAM_FETCH_ERROR',
          message: 'fetch failed',
          retryable: true,
        },
      }),
    );

    await expect(proxyFetch(TARGET_URL)).rejects.toMatchObject({
      name: 'ProxyFetchServiceError',
      code: 'UPSTREAM_FETCH_ERROR',
      retryable: true,
      message: 'fetch failed',
    });
  });
});
