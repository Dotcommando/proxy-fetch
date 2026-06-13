const {
  WIRE_PROTOCOL_VERSION,
  createProxyFetch,
} = require('../dist/index.cjs');

const SERVICE_URL = 'https://proxy-fetch-service.example';
const TARGET_URL = 'https://example.com/stream';
const STREAM_ASSERTION_TIMEOUT_MS = 25;
const HTTP_STATUS_OK = 200;
const MULTIPART_BOUNDARY = 'proxy-fetch-streaming-test-boundary';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const observeSettlementWithin = async (promise, timeoutMs) =>
  Promise.race([
    promise.then(
      (value) => ({
        status: 'fulfilled',
        value,
      }),
      (reason) => ({
        status: 'rejected',
        reason,
      }),
    ),
    wait(timeoutMs).then(() => ({
      status: 'pending',
    })),
  ]);

const createStreamingMultipartServiceResponse = () => {
  let releaseBody;
  const metadata = JSON.stringify({
    version: WIRE_PROTOCOL_VERSION,
    ok: true,
    response: {
      url: TARGET_URL,
      status: HTTP_STATUS_OK,
      statusText: 'OK',
      headers: [['content-type', 'text/plain']],
      body: {
        kind: 'binary',
        partName: 'body',
      },
    },
  });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          [
            `--${MULTIPART_BOUNDARY}`,
            'Content-Disposition: form-data; name="meta"',
            'Content-Type: application/json',
            '',
            metadata,
            `--${MULTIPART_BOUNDARY}`,
            'Content-Disposition: form-data; name="body"; filename="body"',
            'Content-Type: application/octet-stream',
            '',
            'first-',
          ].join('\r\n'),
        ),
      );

      releaseBody = () => {
        controller.enqueue(
          encoder.encode(`second\r\n--${MULTIPART_BOUNDARY}--\r\n`),
        );
        controller.close();
      };
    },
  });

  return {
    response: new Response(stream, {
      status: HTTP_STATUS_OK,
      headers: {
        'content-type': `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
      },
    }),
    releaseBody,
  };
};

describe('Node.js Fetch API response streaming compatibility', () => {
  it('resolves proxyFetch after response metadata is available, before the full body is buffered', async () => {
    let releaseBody;
    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl: async () => {
        const serviceResponse = createStreamingMultipartServiceResponse();

        releaseBody = serviceResponse.releaseBody;

        return serviceResponse.response;
      },
    });
    const requestPromise = proxyFetch(TARGET_URL);
    const observedBeforeFullBody = await observeSettlementWithin(
      requestPromise,
      STREAM_ASSERTION_TIMEOUT_MS,
    );

    releaseBody();
    await requestPromise.catch(() => undefined);

    expect(observedBeforeFullBody.status).toBe('fulfilled');
    expect(observedBeforeFullBody.value).toBeInstanceOf(Response);
  });

  it('exposes response.body chunks before the service response body is complete', async () => {
    let releaseBody;
    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl: async () => {
        const serviceResponse = createStreamingMultipartServiceResponse();

        releaseBody = serviceResponse.releaseBody;

        return serviceResponse.response;
      },
    });
    const requestPromise = proxyFetch(TARGET_URL);
    const observedBeforeFullBody = await observeSettlementWithin(
      requestPromise,
      STREAM_ASSERTION_TIMEOUT_MS,
    );
    let firstRead;

    if (observedBeforeFullBody.status === 'fulfilled') {
      const reader = observedBeforeFullBody.value.body.getReader();

      firstRead = await observeSettlementWithin(
        reader.read(),
        STREAM_ASSERTION_TIMEOUT_MS,
      );
    }

    releaseBody();
    await requestPromise.catch(() => undefined);

    expect(observedBeforeFullBody.status).toBe('fulfilled');
    expect(firstRead.status).toBe('fulfilled');
    expect(firstRead.value.done).toBe(false);
    expect(decoder.decode(firstRead.value.value)).toBe('first-');
  });
});
