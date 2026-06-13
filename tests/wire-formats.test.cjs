const {
  SERVICE_ACCEPT_HEADER_VALUE,
  WIRE_PROTOCOL_VERSION,
  createProxyFetch,
} = require('../dist/index.cjs');

const SERVICE_URL = 'https://proxy-fetch-service.example';
const TARGET_URL = 'https://example.com/resource';
const TEXT_BODY = JSON.stringify({ prompt: 'Summarize this document.' });
const URL_ENCODED_BODY = new URLSearchParams({ query: 'llm proxy fetch' });
const BINARY_BYTES = new Uint8Array([0, 1, 2, 3, 254, 255]);
const RESPONSE_TEXT = JSON.stringify({ answer: 'done' });

const encodeBase64 = (bytes) => Buffer.from(bytes).toString('base64');

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

const captureServiceRequest = async (requestInit, proxyFetchInit) => {
  let capturedInit;

  const fetchImpl = async (_url, init) => {
    capturedInit = init;

    return createEmptyJsonServiceResponse();
  };

  const proxyFetch = createProxyFetch({
    serviceUrl: SERVICE_URL,
    fetchImpl,
    ...requestInit,
  });

  await proxyFetch(TARGET_URL, proxyFetchInit);

  return capturedInit;
};

const readMultipartText = async (value) => {
  if (typeof value === 'string') {
    return value;
  }

  return value.text();
};

const readMultipartBytes = async (value) =>
  new Uint8Array(await value.arrayBuffer());

const expectJsonEnvelopeRequest = (capturedInit) => {
  expect(capturedInit.body).toEqual(expect.any(String));

  return JSON.parse(capturedInit.body);
};

const expectMultipartEnvelopeRequest = async (capturedInit) => {
  expect(capturedInit.body).toBeInstanceOf(FormData);

  const metaPart = capturedInit.body.get('meta');
  const bodyPart = capturedInit.body.get('body');

  expect(metaPart).toBeTruthy();
  expect(bodyPart).toBeInstanceOf(Blob);

  return {
    meta: JSON.parse(await readMultipartText(metaPart)),
    bodyBytes: await readMultipartBytes(bodyPart),
  };
};

describe('proxy-fetch wire body formats', () => {
  it('sends string request bodies as JSON text, not base64', async () => {
    const capturedInit = await captureServiceRequest(undefined, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: TEXT_BODY,
    });

    expect(capturedInit.headers).toMatchObject({
      accept: SERVICE_ACCEPT_HEADER_VALUE,
      'content-type': 'application/json',
    });

    expect(expectJsonEnvelopeRequest(capturedInit).request.body).toEqual({
      kind: 'text',
      text: TEXT_BODY,
    });
  });

  it('sends URLSearchParams request bodies as JSON text', async () => {
    const capturedInit = await captureServiceRequest(undefined, {
      method: 'POST',
      body: URL_ENCODED_BODY,
    });

    const envelope = expectJsonEnvelopeRequest(capturedInit);

    expect(envelope.request.headers).toContainEqual([
      'content-type',
      'application/x-www-form-urlencoded;charset=UTF-8',
    ]);
    expect(envelope.request.body).toEqual({
      kind: 'text',
      text: URL_ENCODED_BODY.toString(),
    });
  });

  it.each([
    {
      label: 'ArrayBuffer',
      body: BINARY_BYTES.buffer.slice(0),
    },
    {
      label: 'Uint8Array',
      body: BINARY_BYTES,
    },
    {
      label: 'Blob',
      body: new Blob([BINARY_BYTES], {
        type: 'application/octet-stream',
      }),
    },
  ])('sends $label request bodies as multipart raw bytes', async ({ body }) => {
    const capturedInit = await captureServiceRequest(undefined, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
      },
      body,
    });

    const { meta, bodyBytes } =
      await expectMultipartEnvelopeRequest(capturedInit);

    expect(meta.request.body).toEqual({
      kind: 'binary',
      partName: 'body',
    });
    expect(Array.from(bodyBytes)).toEqual(Array.from(BINARY_BYTES));
  });

  it('sends FormData request bodies as multipart raw bytes', async () => {
    const targetFormData = new FormData();

    targetFormData.set('prompt', 'describe this file');
    targetFormData.set('file', new Blob([BINARY_BYTES]), 'input.bin');

    const capturedInit = await captureServiceRequest(undefined, {
      method: 'POST',
      body: targetFormData,
    });

    const { meta, bodyBytes } =
      await expectMultipartEnvelopeRequest(capturedInit);
    const targetMultipartBody = Buffer.from(bodyBytes).toString('utf8');

    expect(meta.request.headers).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['content-type', expect.any(String)]),
      ]),
    );
    expect(
      meta.request.headers.find(([name]) => name === 'content-type')[1],
    ).toContain('multipart/form-data; boundary=');
    expect(meta.request.body).toEqual({
      kind: 'binary',
      partName: 'body',
    });
    expect(targetMultipartBody).toContain('name="prompt"');
    expect(targetMultipartBody).toContain('describe this file');
    expect(targetMultipartBody).toContain('filename="input.bin"');
  });

  it('supports explicit JSON base64 fallback for binary request bodies', async () => {
    const capturedInit = await captureServiceRequest(
      {
        binaryBodyTransport: 'json-base64',
      },
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
        },
        body: BINARY_BYTES,
      },
    );

    expect(expectJsonEnvelopeRequest(capturedInit).request.body).toEqual({
      kind: 'base64',
      data: encodeBase64(BINARY_BYTES),
    });
  });

  it('converts JSON text response bodies into native Response text', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          version: WIRE_PROTOCOL_VERSION,
          ok: true,
          response: {
            url: TARGET_URL,
            status: 200,
            statusText: 'OK',
            headers: [['content-type', 'application/json']],
            body: {
              kind: 'text',
              text: RESPONSE_TEXT,
            },
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );

    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl,
    });

    const response = await proxyFetch(TARGET_URL);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.text()).toBe(RESPONSE_TEXT);
  });

  it('converts multipart binary response bodies into native Response bytes', async () => {
    const fetchImpl = async () => {
      const responseFormData = new FormData();

      responseFormData.set(
        'meta',
        JSON.stringify({
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
        }),
      );
      responseFormData.set('body', new Blob([BINARY_BYTES]), 'response.bin');

      const response = new Response(responseFormData, {
        status: 200,
      });
      const contentType = response.headers
        .get('content-type')
        .replace('multipart/form-data', 'Multipart/Form-Data');

      return new Response(response.body, {
        status: 200,
        headers: {
          'content-type': contentType,
        },
      });
    };

    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl,
    });

    const response = await proxyFetch(TARGET_URL);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
      Array.from(BINARY_BYTES),
    );
  });

  it('supports JSON base64 fallback response bodies', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          version: WIRE_PROTOCOL_VERSION,
          ok: true,
          response: {
            url: TARGET_URL,
            status: 200,
            statusText: 'OK',
            headers: [['content-type', 'application/octet-stream']],
            body: {
              kind: 'base64',
              data: encodeBase64(BINARY_BYTES),
            },
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );

    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl,
    });

    const response = await proxyFetch(TARGET_URL);

    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
      Array.from(BINARY_BYTES),
    );
  });
});
