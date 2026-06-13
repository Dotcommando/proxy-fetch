const {
  INVALID_SERVICE_RESPONSE_CODE,
  WIRE_PROTOCOL_VERSION,
  createProxyFetch,
  InvalidServiceResponseError,
} = require('../dist/index.cjs');

const SERVICE_URL = 'https://proxy-fetch-service.example';
const TARGET_URL = 'https://example.test/special';

const createProxyFetchForResponse = (response) =>
  createProxyFetch({
    serviceUrl: SERVICE_URL,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          version: WIRE_PROTOCOL_VERSION,
          ok: true,
          response,
        }),
        {
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
  });

describe('Node.js 26 Fetch API special response compatibility', () => {
  it('accepts valid Response.error-like envelopes', async () => {
    const proxyFetch = createProxyFetchForResponse({
      url: '',
      status: 0,
      statusText: '',
      redirected: false,
      type: 'error',
      headers: [],
      body: null,
    });

    const response = await proxyFetch(TARGET_URL);

    expect(response.type).toBe('error');
    expect(response.status).toBe(0);
    expect(response.ok).toBe(false);
  });

  it.each([
    {
      label: 'error with status 200',
      response: {
        url: TARGET_URL,
        status: 200,
        statusText: 'OK',
        redirected: false,
        type: 'error',
        headers: [['content-type', 'text/plain']],
        body: {
          kind: 'text',
          text: 'impossible',
        },
      },
    },
    {
      label: 'opaque with visible body',
      response: {
        url: TARGET_URL,
        status: 200,
        statusText: 'OK',
        redirected: false,
        type: 'opaque',
        headers: [['content-type', 'text/plain']],
        body: {
          kind: 'text',
          text: 'visible body',
        },
      },
    },
  ])(
    'rejects invalid special response envelope: $label',
    async ({ response }) => {
      const proxyFetch = createProxyFetchForResponse(response);

      await expect(proxyFetch(TARGET_URL)).rejects.toMatchObject({
        name: 'InvalidServiceResponseError',
        code: INVALID_SERVICE_RESPONSE_CODE,
      });
      await expect(proxyFetch(TARGET_URL)).rejects.toBeInstanceOf(
        InvalidServiceResponseError,
      );
    },
  );

  it('accepts documented opaqueredirect envelope shape', async () => {
    const proxyFetch = createProxyFetchForResponse({
      url: '',
      status: 0,
      statusText: '',
      redirected: false,
      type: 'opaqueredirect',
      headers: [],
      body: null,
    });

    const response = await proxyFetch(TARGET_URL);

    expect(response.type).toBe('opaqueredirect');
    expect(response.status).toBe(0);
    expect(response.body).toBeNull();
  });
});
