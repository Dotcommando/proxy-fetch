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

describe('invalid service responses', () => {
  it('rejects invalid JSON responses with InvalidServiceResponseError', async () => {
    const proxyFetch = createProxyFetchForResponse(
      () =>
        new Response('not-json', {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        }),
    );

    await expect(proxyFetch(TARGET_URL)).rejects.toMatchObject({
      name: 'InvalidServiceResponseError',
      code: INVALID_SERVICE_RESPONSE_CODE,
      retryable: false,
    });
    await expect(proxyFetch(TARGET_URL)).rejects.toBeInstanceOf(
      InvalidServiceResponseError,
    );
  });

  it('rejects unsupported wire protocol versions', async () => {
    const proxyFetch = createProxyFetchForResponse(() =>
      createJsonServiceResponse({
        version: 'proxy-fetch.v2',
        ok: true,
        response: {
          url: TARGET_URL,
          status: 200,
          statusText: 'OK',
          headers: [],
          body: null,
        },
      }),
    );

    await expect(proxyFetch(TARGET_URL)).rejects.toMatchObject({
      name: 'InvalidServiceResponseError',
      code: INVALID_SERVICE_RESPONSE_CODE,
    });
  });

  it('rejects unsupported response body kinds', async () => {
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
            kind: 'stream',
            partName: 'body',
          },
        },
      }),
    );

    await expect(proxyFetch(TARGET_URL)).rejects.toMatchObject({
      name: 'InvalidServiceResponseError',
      code: INVALID_SERVICE_RESPONSE_CODE,
    });
  });

  it('rejects service HTTP errors with ProxyFetchServiceError', async () => {
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
      retryable: false,
      details: {
        status: 500,
        statusText: 'Internal Server Error',
      },
    });
    await expect(proxyFetch(TARGET_URL)).rejects.toBeInstanceOf(
      ProxyFetchServiceError,
    );
  });

  it('rejects multipart responses without metadata part', async () => {
    const formData = new FormData();

    formData.set('body', new Blob(['payload']), 'body');

    const proxyFetch = createProxyFetchForResponse(
      () =>
        new Response(formData, {
          status: 200,
        }),
    );

    await expect(proxyFetch(TARGET_URL)).rejects.toMatchObject({
      name: 'InvalidServiceResponseError',
      code: INVALID_SERVICE_RESPONSE_CODE,
    });
  });

  it('rejects multipart responses with invalid metadata JSON', async () => {
    const formData = new FormData();

    formData.set('meta', 'not-json');
    formData.set('body', new Blob(['payload']), 'body');

    const proxyFetch = createProxyFetchForResponse(
      () =>
        new Response(formData, {
          status: 200,
        }),
    );

    await expect(proxyFetch(TARGET_URL)).rejects.toMatchObject({
      name: 'InvalidServiceResponseError',
      code: INVALID_SERVICE_RESPONSE_CODE,
    });
  });

  it('rejects multipart responses without the referenced body part', async () => {
    const formData = new FormData();

    formData.set(
      'meta',
      JSON.stringify({
        version: WIRE_PROTOCOL_VERSION,
        ok: true,
        response: {
          url: TARGET_URL,
          status: 200,
          statusText: 'OK',
          headers: [],
          body: {
            kind: 'binary',
            partName: 'body',
          },
        },
      }),
    );

    const proxyFetch = createProxyFetchForResponse(
      () =>
        new Response(formData, {
          status: 200,
        }),
    );

    await expect(proxyFetch(TARGET_URL)).rejects.toMatchObject({
      name: 'InvalidServiceResponseError',
      code: INVALID_SERVICE_RESPONSE_CODE,
    });
  });
});
