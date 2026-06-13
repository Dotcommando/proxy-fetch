const {
  WIRE_PROTOCOL_VERSION,
  createProxyFetch,
} = require('../dist/index.cjs');

const SERVICE_URL = 'https://proxy-fetch-service.example';
const TARGET_URL = 'https://example.com/resource';
const ABORT_ASSERTION_TIMEOUT_MS = 25;
const MULTIPART_BOUNDARY = 'proxy-fetch-abort-test-boundary';
const encoder = new TextEncoder();

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

const createStreamingMultipartServiceResponse = () => {
  let releaseBody;
  const metadata = JSON.stringify({
    version: WIRE_PROTOCOL_VERSION,
    ok: true,
    response: {
      url: TARGET_URL,
      status: 200,
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
      status: 200,
      headers: {
        'content-type': `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
      },
    }),
    releaseBody,
  };
};

describe('Node.js Fetch API abort compatibility', () => {
  it('rejects an already aborted request without starting the service request', async () => {
    const controller = new AbortController();
    const abortReason = new DOMException('Already aborted.', 'AbortError');
    let serviceRequestStarted = false;
    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl: async () => {
        serviceRequestStarted = true;

        return createEmptyServiceResponse();
      },
    });

    controller.abort(abortReason);

    await expect(
      proxyFetch(TARGET_URL, {
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(serviceRequestStarted).toBe(false);
  });

  it('allows aborting after response headers are available without waiting for the full response body', async () => {
    const controller = new AbortController();
    const abortReason = new DOMException('Abort after headers.', 'AbortError');
    let releaseBody;
    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl: async () => {
        const serviceResponse = createStreamingMultipartServiceResponse();

        releaseBody = serviceResponse.releaseBody;

        return serviceResponse.response;
      },
    });
    const requestPromise = proxyFetch(TARGET_URL, {
      signal: controller.signal,
    });
    const observedBeforeFullBody = await observeSettlementWithin(
      requestPromise,
      ABORT_ASSERTION_TIMEOUT_MS,
    );

    controller.abort(abortReason);
    releaseBody();
    await requestPromise.catch(() => undefined);

    expect(observedBeforeFullBody.status).toBe('fulfilled');
    expect(observedBeforeFullBody.value).toBeInstanceOf(Response);
  });
});
