const {
  WIRE_PROTOCOL_VERSION,
  createProxyFetch,
} = require('../dist/index.cjs');

const SERVICE_URL = 'https://proxy-fetch-service.example';
const TARGET_URL = 'https://example.com/upload';
const encoder = new TextEncoder();

const createEmptyServiceResponse = () =>
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

const captureServiceRequest = async (input, init) => {
  let capturedInit;
  const proxyFetch = createProxyFetch({
    serviceUrl: SERVICE_URL,
    fetchImpl: async (_url, serviceInit) => {
      capturedInit = serviceInit;

      return createEmptyServiceResponse();
    },
  });

  await proxyFetch(input, init);

  return capturedInit;
};

const readMultipartText = async (part) =>
  typeof part === 'string' ? part : part.text();

const readMultipartBytes = async (part) =>
  Array.from(new Uint8Array(await part.arrayBuffer()));

const readCapturedMultipart = async (capturedInit) => {
  if (capturedInit.body instanceof ReadableStream) {
    return readCapturedMultipartStream(capturedInit);
  }

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

const readCapturedMultipartStream = async (capturedInit) => {
  const contentType = capturedInit.headers['content-type'];
  const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1];

  expect(boundary).toEqual(expect.any(String));

  const bytes = Buffer.from(
    await new Response(capturedInit.body).arrayBuffer(),
  );
  const boundaryMarker = Buffer.from(`--${boundary}`);
  const partBoundaryMarker = Buffer.from(`\r\n--${boundary}`);
  const metadataHeadersEnd = bytes.indexOf(Buffer.from('\r\n\r\n'));
  const metadataBodyStart = metadataHeadersEnd + '\r\n\r\n'.length;
  const metadataBodyEnd = bytes.indexOf(partBoundaryMarker, metadataBodyStart);
  const bodyHeadersStart =
    metadataBodyEnd + partBoundaryMarker.byteLength + '\r\n'.length;
  const bodyHeadersEnd = bytes.indexOf(
    Buffer.from('\r\n\r\n'),
    bodyHeadersStart,
  );
  const bodyStart = bodyHeadersEnd + '\r\n\r\n'.length;
  const bodyEnd = bytes.indexOf(partBoundaryMarker, bodyStart);

  expect(bytes.indexOf(boundaryMarker)).toBe(0);
  expect(metadataHeadersEnd).toBeGreaterThan(-1);
  expect(metadataBodyEnd).toBeGreaterThan(-1);
  expect(bodyHeadersEnd).toBeGreaterThan(-1);
  expect(bodyEnd).toBeGreaterThan(-1);

  return {
    meta: JSON.parse(
      bytes.subarray(metadataBodyStart, metadataBodyEnd).toString('utf8'),
    ),
    bodyBytes: Array.from(bytes.subarray(bodyStart, bodyEnd)),
  };
};

const createStreamBody = (chunks) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }

      controller.close();
    },
  });

describe('Node.js 26 Fetch API request body compatibility', () => {
  it('preserves ReadableStream request payload bytes', async () => {
    const expectedBytes = Array.from(encoder.encode('hello-stream'));
    const capturedInit = await captureServiceRequest(TARGET_URL, {
      method: 'POST',
      body: createStreamBody(['hello-', 'stream']),
      duplex: 'half',
    });

    const { meta, bodyBytes } = await readCapturedMultipart(capturedInit);

    expect(meta.request.body).toEqual({
      kind: 'binary',
      partName: 'body',
    });
    expect(bodyBytes).toEqual(expectedBytes);
  });

  it.each([
    {
      label: 'string',
      createRequest: () =>
        new Request(TARGET_URL, {
          method: 'POST',
          headers: {
            'content-type': 'text/plain;charset=UTF-8',
          },
          body: 'hello-request',
        }),
      expectedBytes: Array.from(encoder.encode('hello-request')),
    },
    {
      label: 'URLSearchParams',
      createRequest: () =>
        new Request(TARGET_URL, {
          method: 'POST',
          body: new URLSearchParams({
            query: 'node fetch',
          }),
        }),
      expectedBytes: Array.from(
        encoder.encode(new URLSearchParams({ query: 'node fetch' }).toString()),
      ),
    },
    {
      label: 'Uint8Array with text content-type',
      createRequest: () =>
        new Request(TARGET_URL, {
          method: 'POST',
          headers: {
            'content-type': 'text/plain',
          },
          body: Uint8Array.from([0xff, 0xfe, 0xfd]),
        }),
      expectedBytes: [0xff, 0xfe, 0xfd],
    },
    {
      label: 'Blob',
      createRequest: () =>
        new Request(TARGET_URL, {
          method: 'POST',
          body: new Blob([Uint8Array.from([0, 1, 2, 3])], {
            type: 'application/octet-stream',
          }),
        }),
      expectedBytes: [0, 1, 2, 3],
    },
  ])(
    'preserves payload bytes for Request input with $label body',
    async ({ createRequest, expectedBytes }) => {
      const capturedInit = await captureServiceRequest(createRequest());
      const { bodyBytes } = await readCapturedMultipart(capturedInit);

      expect(bodyBytes).toEqual(expectedBytes);
    },
  );

  it('rejects an already consumed Request input like native Fetch', async () => {
    const request = new Request(TARGET_URL, {
      method: 'POST',
      body: 'already consumed',
    });

    await request.text();

    await expect(captureServiceRequest(request)).rejects.toMatchObject({
      name: 'TypeError',
    });
  });
});
