const { Buffer } = require('node:buffer');
const { createServer } = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createProxyFetch } = require('../../dist/index.cjs');

const HOSTNAME = '127.0.0.1';
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_CREATED = 201;
const DEFAULT_PORT = 0;
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';
const BINARY_CONTENT_TYPE = 'application/octet-stream';
const BODY_PREVIEW_BYTES = 512;
const BINARY_RESPONSE_BYTES = Uint8Array.from([0, 1, 2, 3, 254, 255]);
const MOCK_ORCHESTRATOR_BUILD_PATH = path.join(
  process.cwd(),
  '.tmp',
  'mock-orchestrator',
  'mock-orchestrator.js',
);

const readIncomingMessage = async (request) => {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};

const logSection = (title, value) => {
  console.log(`\n[e2e] ${title}\n${JSON.stringify(value, null, 2)}`);
};

const isJsonContentType = (contentType) =>
  contentType?.toLowerCase().includes('json') === true;

const isTextContentType = (contentType) =>
  contentType?.toLowerCase().startsWith('text/') === true
  || contentType?.toLowerCase().startsWith('multipart/form-data') === true;

const headersToObject = (headers) => {
  const result = {};

  headers.forEach((value, key) => {
    result[key] = value;
  });

  return result;
};

const incomingHeadersToObject = (headers) => {
  const result = {};

  for (const [name, value] of Object.entries(headers)) {
    result[name] = Array.isArray(value) ? value.join(', ') : value;
  }

  return result;
};

const formatBodyForLog = (body, contentType) => {
  if (body.byteLength === 0) {
    return null;
  }

  if (isJsonContentType(contentType)) {
    try {
      return {
        kind: 'json',
        value: JSON.parse(body.toString('utf8')),
      };
    } catch {
      return {
        kind: 'invalid-json',
        text: body.toString('utf8', 0, BODY_PREVIEW_BYTES),
        bytes: body.byteLength,
      };
    }
  }

  if (isTextContentType(contentType) || !body.includes(0)) {
    const text = body.toString('utf8');

    return {
      kind: 'text',
      contentType,
      chars: text.length,
      text:
        text.length > BODY_PREVIEW_BYTES
          ? `${text.slice(0, BODY_PREVIEW_BYTES)}...`
          : text,
    };
  }

  return {
    kind: 'binary',
    contentType,
    bytes: body.byteLength,
    firstBytesHex: body.subarray(0, BODY_PREVIEW_BYTES).toString('hex'),
  };
};

const sendJson = (response, statusCode, payload) => {
  const body = Buffer.from(JSON.stringify(payload));

  response.writeHead(statusCode, {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': String(body.byteLength),
  });
  response.end(body);
};

const sendText = (response, statusCode, text) => {
  response.writeHead(statusCode, {
    'content-type': TEXT_CONTENT_TYPE,
  });
  response.end(text);
};

const sendBinary = (response, statusCode, bytes) => {
  response.writeHead(statusCode, {
    'content-type': BINARY_CONTENT_TYPE,
    'content-length': String(bytes.byteLength),
  });
  response.end(Buffer.from(bytes));
};

const createTargetServer = async () => {
  const server = createServer(async (request, response) => {
    const body = await readIncomingMessage(request);
    const contentType = request.headers['content-type'];
    const requestLog = {
      method: request.method,
      url: request.url,
      headers: incomingHeadersToObject(request.headers),
      body: formatBodyForLog(body, contentType),
    };

    logSection('target server received request', requestLog);

    if (request.method === 'GET' && request.url === '/json') {
      sendJson(response, HTTP_STATUS_OK, {
        ok: true,
        route: '/json',
        request: requestLog,
      });

      return;
    }

    if (request.method === 'GET' && request.url === '/text') {
      sendText(response, HTTP_STATUS_OK, 'plain text target response');

      return;
    }

    if (request.method === 'POST' && request.url === '/echo-json') {
      sendJson(response, HTTP_STATUS_CREATED, {
        ok: true,
        route: '/echo-json',
        request: requestLog,
      });

      return;
    }

    if (request.method === 'POST' && request.url === '/echo-multipart') {
      sendJson(response, HTTP_STATUS_CREATED, {
        ok: true,
        route: '/echo-multipart',
        request: requestLog,
      });

      return;
    }

    if (request.method === 'GET' && request.url === '/binary') {
      sendBinary(response, HTTP_STATUS_OK, BINARY_RESPONSE_BYTES);

      return;
    }

    sendJson(response, 404, {
      ok: false,
      route: request.url,
    });
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
    server,
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

const importMockOrchestrator = async () => {
  const moduleUrl = pathToFileURL(MOCK_ORCHESTRATOR_BUILD_PATH).href;

  return import(moduleUrl);
};

const logProxyFetchCall = (title, url, init) => {
  const body =
    init?.body instanceof FormData
      ? '<FormData body; target server and orchestrator logs show serialized multipart body>'
      : init?.body;

  logSection(title, {
    url,
    method: init?.method ?? 'GET',
    headers: init?.headers ?? {},
    body,
  });
};

const logProxyFetchResponse = async (title, response) => {
  const clone = response.clone();
  const contentType = response.headers.get('content-type');
  const body = Buffer.from(await clone.arrayBuffer());

  logSection(title, {
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    redirected: response.redirected,
    type: response.type,
    headers: headersToObject(response.headers),
    body: formatBodyForLog(body, contentType),
  });
};

describe('mock orchestrator e2e', () => {
  let targetServer;
  let orchestrator;
  let proxyFetch;

  beforeAll(async () => {
    const { startMockOrchestrator } = await importMockOrchestrator();

    targetServer = await createTargetServer();
    orchestrator = await startMockOrchestrator({
      log: console.log,
    });
    proxyFetch = createProxyFetch({
      serviceUrl: orchestrator.url,
    });

    logSection('e2e servers started', {
      targetUrl: targetServer.url,
      orchestratorUrl: orchestrator.url,
    });
  });

  afterAll(async () => {
    await orchestrator?.close();
    await targetServer?.close();
  });

  it('executes a GET request and returns a JSON response', async () => {
    const url = `${targetServer.url}/json`;

    logProxyFetchCall('proxyFetch outgoing request', url);

    const response = await proxyFetch(url);

    await logProxyFetchResponse('proxyFetch received response', response);

    const json = await response.json();

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(response.url).toBe(url);
    expect(json).toMatchObject({
      ok: true,
      route: '/json',
      request: {
        method: 'GET',
        url: '/json',
      },
    });
  });

  it('executes a POST request with formatted JSON body logging', async () => {
    const url = `${targetServer.url}/echo-json`;
    const body = {
      model: 'llm-test-model',
      messages: [
        {
          role: 'user',
          content: 'Return a compact JSON answer.',
        },
      ],
    };
    const init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    };

    logProxyFetchCall('proxyFetch outgoing request', url, init);

    const response = await proxyFetch(url, init);

    await logProxyFetchResponse('proxyFetch received response', response);

    const json = await response.json();

    expect(response.status).toBe(HTTP_STATUS_CREATED);
    expect(json.request.body).toEqual({
      kind: 'json',
      value: body,
    });
  });

  it('executes a POST request with FormData as multipart bytes', async () => {
    const url = `${targetServer.url}/echo-multipart`;
    const formData = new FormData();

    formData.set('prompt', 'describe this file');
    formData.set(
      'file',
      new Blob([BINARY_RESPONSE_BYTES], {
        type: BINARY_CONTENT_TYPE,
      }),
      'input.bin',
    );

    const init = {
      method: 'POST',
      body: formData,
    };

    logProxyFetchCall('proxyFetch outgoing request', url, init);

    const response = await proxyFetch(url, init);

    await logProxyFetchResponse('proxyFetch received response', response);

    const json = await response.json();

    expect(response.status).toBe(HTTP_STATUS_CREATED);
    expect(json.request.headers['content-type']).toContain(
      'multipart/form-data; boundary=',
    );
    expect(json.request.body.kind).toBe('text');
    expect(json.request.body.text).toContain('name="prompt"');
    expect(json.request.body.text).toContain('describe this file');
    expect(json.request.body.text).toContain('filename="input.bin"');
  });

  it('returns non-JSON text responses in readable logs', async () => {
    const url = `${targetServer.url}/text`;

    logProxyFetchCall('proxyFetch outgoing request', url);

    const response = await proxyFetch(url);

    await logProxyFetchResponse('proxyFetch received response', response);

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(await response.text()).toBe('plain text target response');
  });

  it('returns binary responses through multipart service response', async () => {
    const url = `${targetServer.url}/binary`;

    logProxyFetchCall('proxyFetch outgoing request', url);

    const response = await proxyFetch(url);

    await logProxyFetchResponse('proxyFetch received response', response);

    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(response.headers.get('content-type')).toBe(BINARY_CONTENT_TYPE);
    expect(Array.from(bytes)).toEqual(Array.from(BINARY_RESPONSE_BYTES));
  });
});
