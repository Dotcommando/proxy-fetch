const { createServer } = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createProxyFetch } = require('../../dist/index.cjs');

const HOSTNAME = '127.0.0.1';
const DEFAULT_PORT = 0;
const HTTP_STATUS_OK = 200;
const STREAM_SETTLEMENT_TIMEOUT_MS = 250;
const TARGET_COMPLETION_DELAY_MS = 120;
const TARGET_COMPLETION_OBSERVATION_MS = 180;
const MOCK_ORCHESTRATOR_BUILD_PATH = path.join(
  process.cwd(),
  '.tmp',
  'mock-orchestrator',
  'mock-orchestrator.js',
);

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

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
};

const importMockOrchestrator = async () => {
  const moduleUrl = pathToFileURL(MOCK_ORCHESTRATOR_BUILD_PATH).href;

  return import(moduleUrl);
};

const startTargetServer = async () => {
  const dripRelease = createDeferred();
  const slowRequestStarted = createDeferred();
  let slowRequestCompleted = false;
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/drip') {
      response.writeHead(HTTP_STATUS_OK, {
        'content-type': 'application/octet-stream',
      });
      response.write('first-');

      void dripRelease.promise.then(() => {
        response.end('second');
      });

      return;
    }

    if (request.method === 'GET' && request.url === '/slow-side-effect') {
      slowRequestStarted.resolve();

      const timeout = setTimeout(() => {
        slowRequestCompleted = true;
        response.writeHead(HTTP_STATUS_OK, {
          'content-type': 'text/plain',
        });
        response.end('completed');
      }, TARGET_COMPLETION_DELAY_MS);
      const cancelSideEffect = () => {
        clearTimeout(timeout);
      };

      request.once('close', cancelSideEffect);
      response.once('close', cancelSideEffect);

      return;
    }

    response.writeHead(404, {
      'content-type': 'text/plain',
    });
    response.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(DEFAULT_PORT, HOSTNAME, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Target test server did not bind to a TCP address.');
  }

  return {
    url: `http://${HOSTNAME}:${address.port}`,
    releaseDrip() {
      dripRelease.resolve();
    },
    waitForSlowRequestStart() {
      return slowRequestStarted.promise;
    },
    isSlowRequestCompleted() {
      return slowRequestCompleted;
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);

            return;
          }

          resolve();
        });
      });
    },
  };
};

describe('Node.js 26 Fetch API orchestrator compatibility', () => {
  let targetServer;
  let orchestrator;
  let proxyFetch;

  beforeAll(async () => {
    const { startMockOrchestrator } = await importMockOrchestrator();

    targetServer = await startTargetServer();
    orchestrator = await startMockOrchestrator();
    proxyFetch = createProxyFetch({
      serviceUrl: orchestrator.url,
    });
  });

  afterAll(async () => {
    targetServer?.releaseDrip();
    await orchestrator?.close();
    await targetServer?.close();
  });

  it('resolves after target response headers are available, before the target body is fully buffered', async () => {
    const responsePromise = proxyFetch(`${targetServer.url}/drip`);
    const observedBeforeFullTargetBody = await observeSettlementWithin(
      responsePromise,
      STREAM_SETTLEMENT_TIMEOUT_MS,
    );

    targetServer.releaseDrip();
    await responsePromise.catch(() => undefined);

    expect(observedBeforeFullTargetBody.status).toBe('fulfilled');
    expect(observedBeforeFullTargetBody.value).toBeInstanceOf(Response);
  });

  it('cancels the active target request when the caller aborts', async () => {
    const controller = new AbortController();
    const requestPromise = proxyFetch(`${targetServer.url}/slow-side-effect`, {
      signal: controller.signal,
    });

    await targetServer.waitForSlowRequestStart();
    controller.abort(new DOMException('Caller aborted.', 'AbortError'));
    await requestPromise.catch(() => undefined);
    await wait(TARGET_COMPLETION_OBSERVATION_MS);

    expect(targetServer.isSlowRequestCompleted()).toBe(false);
  });
});
