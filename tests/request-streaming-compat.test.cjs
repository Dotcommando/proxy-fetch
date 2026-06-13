const {
  WIRE_PROTOCOL_VERSION,
  createProxyFetch,
} = require('../dist/index.cjs');

const SERVICE_URL = 'https://proxy-fetch-service.example';
const TARGET_URL = 'https://example.com/upload';
const STREAM_ASSERTION_TIMEOUT_MS = 25;
const encoder = new TextEncoder();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const consumeServiceRequestBody = async (init) => {
  if (init.body === undefined || init.body === null) {
    return;
  }

  await new Response(init.body).arrayBuffer();
};

describe('Node.js Fetch API request streaming compatibility', () => {
  it('starts the service request before a ReadableStream upload is fully consumed', async () => {
    let serviceRequestStarted = false;
    let releaseUpload;
    const uploadStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('first-'));
      },
      pull(controller) {
        return new Promise((resolve) => {
          releaseUpload = () => {
            controller.enqueue(encoder.encode('second'));
            controller.close();
            resolve();
          };
        });
      },
    });
    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl: async () => {
        serviceRequestStarted = true;

        return createEmptyServiceResponse();
      },
    });
    const requestPromise = proxyFetch(TARGET_URL, {
      method: 'POST',
      body: uploadStream,
      duplex: 'half',
    });

    await wait(STREAM_ASSERTION_TIMEOUT_MS);

    const observedBeforeUploadCompleted = serviceRequestStarted;

    releaseUpload();
    await requestPromise.catch(() => undefined);

    expect(observedBeforeUploadCompleted).toBe(true);
  });

  it('rejects when a ReadableStream upload errors instead of resolving with a fake success', async () => {
    let serviceRequestStarted = false;
    const streamError = new Error('stream failed');
    const uploadStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('before-error'));
      },
      pull(controller) {
        controller.error(streamError);
      },
    });
    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl: async (_url, init) => {
        serviceRequestStarted = true;
        await consumeServiceRequestBody(init);

        return createEmptyServiceResponse();
      },
    });

    await expect(
      proxyFetch(TARGET_URL, {
        method: 'POST',
        body: uploadStream,
        duplex: 'half',
      }),
    ).rejects.toBe(streamError);
    expect(serviceRequestStarted).toBe(true);
  });

  it('cancels a ReadableStream upload when the caller aborts during upload streaming', async () => {
    const controller = new AbortController();
    const abortReason = new DOMException('Caller aborted.', 'AbortError');
    let releaseUpload;
    let uploadCancelled = false;
    const uploadStream = new ReadableStream({
      start(streamController) {
        streamController.enqueue(encoder.encode('first-'));
      },
      pull(streamController) {
        return new Promise((resolve) => {
          releaseUpload = () => {
            streamController.enqueue(encoder.encode('second'));
            streamController.close();
            resolve();
          };
        });
      },
      cancel() {
        uploadCancelled = true;
      },
    });
    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl: async () => createEmptyServiceResponse(),
    });
    const requestPromise = proxyFetch(TARGET_URL, {
      method: 'POST',
      body: uploadStream,
      duplex: 'half',
      signal: controller.signal,
    });
    const rejectionPromise = requestPromise.catch((error) => error);

    await wait(STREAM_ASSERTION_TIMEOUT_MS);
    controller.abort(abortReason);
    await wait(STREAM_ASSERTION_TIMEOUT_MS);

    const observedUploadCancelled = uploadCancelled;

    if (!observedUploadCancelled) {
      releaseUpload();
    }

    await requestPromise.catch(() => undefined);

    expect(observedUploadCancelled).toBe(true);
    await expect(rejectionPromise).resolves.toBe(abortReason);
  });

  it('rejects with TimeoutError while a ReadableStream body is still being serialized', async () => {
    let serviceRequestCompleted = false;
    let serviceRequestStarted = false;
    const uploadStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('first-'));
      },
      pull() {
        return new Promise(() => undefined);
      },
    });
    const proxyFetch = createProxyFetch({
      serviceUrl: SERVICE_URL,
      fetchImpl: async (_url, init) => {
        serviceRequestStarted = true;
        await consumeServiceRequestBody(init);
        serviceRequestCompleted = true;

        return createEmptyServiceResponse();
      },
    });

    await expect(
      proxyFetch(TARGET_URL, {
        method: 'POST',
        body: uploadStream,
        duplex: 'half',
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(serviceRequestStarted).toBe(true);
    expect(serviceRequestCompleted).toBe(false);
  });
});
