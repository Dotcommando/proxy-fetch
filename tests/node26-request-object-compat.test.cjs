const {
  WIRE_PROTOCOL_VERSION,
  createProxyFetch,
} = require('../dist/index.cjs');

const SERVICE_URL = 'https://proxy-fetch-service.example';
const TARGET_URL = 'https://example.test/upload';

const createServiceResponse = () =>
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
      headers: {
        'content-type': 'application/json',
      },
    },
  );

const captureServiceRequest = async (input) => {
  let capturedInit;
  const proxyFetch = createProxyFetch({
    serviceUrl: SERVICE_URL,
    fetchImpl: async (_url, init) => {
      capturedInit = init;

      return createServiceResponse();
    },
  });

  await proxyFetch(input);

  return capturedInit;
};

const readStreamingMultipart = async (capturedInit) => {
  const contentType = capturedInit.headers['content-type'];
  const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1];
  const bytes = Buffer.from(
    await new Response(capturedInit.body).arrayBuffer(),
  );
  const partBoundary = Buffer.from(`\r\n--${boundary}`);
  const metaHeadersEnd = bytes.indexOf(Buffer.from('\r\n\r\n'));
  const metaStart = metaHeadersEnd + '\r\n\r\n'.length;
  const metaEnd = bytes.indexOf(partBoundary, metaStart);
  const bodyHeadersStart = metaEnd + partBoundary.byteLength + '\r\n'.length;
  const bodyHeadersEnd = bytes.indexOf(
    Buffer.from('\r\n\r\n'),
    bodyHeadersStart,
  );
  const bodyStart = bodyHeadersEnd + '\r\n\r\n'.length;
  const bodyEnd = bytes.indexOf(partBoundary, bodyStart);

  return {
    envelope: JSON.parse(bytes.subarray(metaStart, metaEnd).toString('utf8')),
    bodyText: bytes.subarray(bodyStart, bodyEnd).toString('utf8'),
  };
};

describe('Node.js 26 Fetch API Request object body compatibility', () => {
  it('preserves existing Request with string body', async () => {
    const request = new Request(TARGET_URL, {
      method: 'POST',
      body: 'hello',
    });

    const capturedInit = await captureServiceRequest(request.clone());
    const multipart = await readStreamingMultipart(capturedInit);

    expect(multipart.bodyText).toBe('hello');
  });

  it('preserves existing Request with FormData body', async () => {
    const formData = new FormData();

    formData.set('name', 'proxy-fetch');

    const request = new Request(TARGET_URL, {
      method: 'POST',
      body: formData,
    });

    const capturedInit = await captureServiceRequest(request.clone());
    const multipart = await readStreamingMultipart(capturedInit);

    expect(multipart.envelope.request.headers).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          'content-type',
          expect.stringContaining('multipart/form-data; boundary='),
        ]),
      ]),
    );
    expect(multipart.bodyText).toContain('name="name"');
    expect(multipart.bodyText).toContain('proxy-fetch');
  });

  it('rejects consumed Request body like native fetch', async () => {
    const request = new Request(TARGET_URL, {
      method: 'POST',
      body: 'hello',
    });

    await request.text();

    await expect(captureServiceRequest(request)).rejects.toMatchObject({
      name: 'TypeError',
    });
  });
});
