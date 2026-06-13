const { createHash } = require('node:crypto');
const { createServer } = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createProxyFetch } = require('../../dist/index.cjs');

const HOSTNAME = '127.0.0.1';
const DEFAULT_PORT = 0;
const MOCK_ORCHESTRATOR_BUILD_PATH = path.join(
  process.cwd(),
  '.tmp',
  'mock-orchestrator',
  'mock-orchestrator.js',
);

const importMockOrchestrator = async () =>
  import(pathToFileURL(MOCK_ORCHESTRATOR_BUILD_PATH).href);

const readBody = async (request) => {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};

const startTargetServer = async () => {
  const server = createServer(async (request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, {
        location: '/final',
      });
      response.end('redirecting');

      return;
    }

    if (request.url === '/final') {
      response.writeHead(200, {
        'content-type': 'text/plain',
      });
      response.end('final');

      return;
    }

    if (request.url === '/integrity') {
      response.writeHead(200, {
        'content-type': 'text/plain',
      });
      response.end('integrity-body');

      return;
    }

    if (request.url === '/echo') {
      await readBody(request);
      response.writeHead(200, {
        'content-type': 'application/json',
      });
      response.end(
        JSON.stringify({
          referer: request.headers.referer ?? null,
        }),
      );

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
    throw new Error('Target server did not bind to a TCP address.');
  }

  return {
    url: `http://${HOSTNAME}:${address.port}`,
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

describe('Node.js 26 Fetch API orchestrator metadata enforcement', () => {
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
    await orchestrator?.close();
    await targetServer?.close();
  });

  it('matches native redirect: follow behavior', async () => {
    const url = `${targetServer.url}/redirect`;
    const native = await fetch(url, { redirect: 'follow' });
    const proxy = await proxyFetch(url, { redirect: 'follow' });

    expect(proxy.status).toBe(native.status);
    expect(proxy.url).toBe(native.url);
    expect(proxy.redirected).toBe(native.redirected);
    expect(await proxy.text()).toBe(await native.text());
  });

  it('matches native redirect: manual visible response behavior', async () => {
    const url = `${targetServer.url}/redirect`;
    const native = await fetch(url, { redirect: 'manual' });
    const proxy = await proxyFetch(url, { redirect: 'manual' });

    expect(proxy.status).toBe(native.status);
    expect(proxy.redirected).toBe(native.redirected);
    expect(proxy.headers.get('location')).toBe(native.headers.get('location'));
  });

  it('rejects redirects with redirect: error', async () => {
    const url = `${targetServer.url}/redirect`;

    await expect(fetch(url, { redirect: 'error' })).rejects.toThrow();
    await expect(proxyFetch(url, { redirect: 'error' })).rejects.toThrow();
  });

  it('rejects integrity mismatches like native fetch', async () => {
    const url = `${targetServer.url}/integrity`;
    const wrongIntegrity = `sha256-${createHash('sha256')
      .update('different-body')
      .digest('base64')}`;

    await expect(fetch(url, { integrity: wrongIntegrity })).rejects.toThrow();
    await expect(
      proxyFetch(url, { integrity: wrongIntegrity }),
    ).rejects.toThrow();
  });

  it('forwards referrer metadata through the orchestrator', async () => {
    const url = `${targetServer.url}/echo`;
    const referrer = `${targetServer.url}/referrer`;
    const native = await fetch(url, { referrer });
    const proxy = await proxyFetch(url, { referrer });

    expect(await proxy.json()).toEqual(await native.json());
  });
});
