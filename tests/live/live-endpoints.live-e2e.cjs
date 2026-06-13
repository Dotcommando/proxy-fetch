const { Buffer } = require('node:buffer');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createProxyFetch } = require('../../dist/index.cjs');

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const HTTP_STATUS_BAD_GATEWAY = 502;
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
const HTTP_STATUS_GATEWAY_TIMEOUT = 504;
const BODY_PREVIEW_BYTES = 512;
const LIVE_SCENARIO_COUNT = 10;
const STREAM_LINE_COUNT = 10;
const STREAM_BYTE_LENGTH = 1024;
const MIN_NON_EMPTY_BINARY_BYTES = 1;
const WORLD_BANK_MIN_JSON_ITEMS = 2;
const GITHUB_README_MIN_CHARS = 1;
const TEMPORARY_UPSTREAM_FAILURE_STATUSES = new Set([
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_BAD_GATEWAY,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_GATEWAY_TIMEOUT,
]);
const MOCK_ORCHESTRATOR_BUILD_PATH = path.join(
  process.cwd(),
  '.tmp',
  'mock-orchestrator',
  'mock-orchestrator.js',
);

const LIVE_ENDPOINTS = {
  jsonPlaceholder: 'https://jsonplaceholder.typicode.com/posts/1',
  openMeteo:
    'https://api.open-meteo.com/v1/forecast?latitude=34.6851&longitude=33.0442&current=temperature_2m,wind_speed_10m',
  githubReadme: 'https://api.github.com/repos/nodejs/node/readme',
  httpbinBase64: 'https://httpbin.org/base64/SGVsbG8sIGZldGNoIQ==',
  httpbinStream: `https://httpbin.org/stream/${STREAM_LINE_COUNT}`,
  httpbinStreamBytes: `https://httpbin.org/stream-bytes/${STREAM_BYTE_LENGTH}?chunk_size=128`,
  httpbinPost: 'https://httpbin.org/post',
  httpbinGzip: 'https://httpbin.org/gzip',
  picsumImage: 'https://picsum.photos/200/300',
  worldBankXml:
    'https://api.worldbank.org/v2/country/cyp/indicator/NY.GDP.MKTP.CD?date=2023',
  worldBankJson:
    'https://api.worldbank.org/v2/country/cyp/indicator/NY.GDP.MKTP.CD?date=2023&format=json',
};

const logSection = (title, value) => {
  console.log(`\n[live e2e] ${title}\n${JSON.stringify(value, null, 2)}`);
};

const importMockOrchestrator = async () => {
  const moduleUrl = pathToFileURL(MOCK_ORCHESTRATOR_BUILD_PATH).href;

  return import(moduleUrl);
};

const headersToObject = (headers) => {
  const result = {};

  headers.forEach((value, key) => {
    result[key] = value;
  });

  return result;
};

const isJsonContentType = (contentType) =>
  contentType?.toLowerCase().includes('json') === true;

const isTextContentType = (contentType) => {
  const normalized = contentType?.toLowerCase();

  return (
    normalized?.startsWith('text/') === true
    || normalized?.includes('xml') === true
    || normalized?.includes('javascript') === true
  );
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

const formatRequestBodyForLog = (body) => {
  if (body instanceof FormData) {
    return '<FormData body; mock orchestrator logs show serialized multipart body>';
  }

  if (typeof body === 'string') {
    try {
      return {
        kind: 'json',
        value: JSON.parse(body),
      };
    } catch {
      return {
        kind: 'text',
        text: body,
      };
    }
  }

  return body ?? null;
};

const logProxyFetchCall = (label, url, init = {}) => {
  logSection(`${label}: proxyFetch outgoing request`, {
    url,
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    body: formatRequestBodyForLog(init.body),
  });
};

const logProxyFetchResponse = async (label, response) => {
  const clone = response.clone();
  const contentType = response.headers.get('content-type');
  const body = Buffer.from(await clone.arrayBuffer());

  logSection(`${label}: proxyFetch received response`, {
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    redirected: response.redirected,
    type: response.type,
    headers: headersToObject(response.headers),
    body: formatBodyForLog(body, contentType),
  });
};

const fetchWithLog = async (label, proxyFetch, url, init) => {
  logProxyFetchCall(label, url, init);

  const response = await proxyFetch(url, init);

  await logProxyFetchResponse(label, response);

  return response;
};

const shouldSkipStrictChecksForTemporaryUpstreamFailure = (label, response) => {
  if (!TEMPORARY_UPSTREAM_FAILURE_STATUSES.has(response.status)) {
    return false;
  }

  logSection(`${label}: strict live assertions skipped`, {
    reason:
      'Public endpoint returned a temporary upstream failure. The proxy path was still exercised.',
    status: response.status,
    statusText: response.statusText,
    url: response.url,
  });

  return true;
};

describe('live endpoints through mock orchestrator', () => {
  let orchestrator;
  let proxyFetch;

  beforeAll(async () => {
    const { startMockOrchestrator } = await importMockOrchestrator();

    orchestrator = await startMockOrchestrator({
      log: console.log,
    });
    proxyFetch = createProxyFetch({
      serviceUrl: orchestrator.url,
    });

    logSection('live e2e mock orchestrator started', {
      orchestratorUrl: orchestrator.url,
      scenarioCount: LIVE_SCENARIO_COUNT,
      requestUrlCount: Object.keys(LIVE_ENDPOINTS).length,
    });
  });

  afterAll(async () => {
    await orchestrator?.close();
  });

  it('1. JSONPlaceholder - simple JSON GET', async () => {
    const response = await fetchWithLog(
      'JSONPlaceholder',
      proxyFetch,
      LIVE_ENDPOINTS.jsonPlaceholder,
    );

    if (
      shouldSkipStrictChecksForTemporaryUpstreamFailure(
        'JSONPlaceholder',
        response,
      )
    ) {
      return;
    }

    const data = await response.json();

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(data.id).toBe(1);
    expect(typeof data.title).toBe('string');
    expect(typeof data.body).toBe('string');
  });

  it('2. Open-Meteo - real JSON API without API key', async () => {
    const response = await fetchWithLog(
      'Open-Meteo',
      proxyFetch,
      LIVE_ENDPOINTS.openMeteo,
    );

    if (
      shouldSkipStrictChecksForTemporaryUpstreamFailure('Open-Meteo', response)
    ) {
      return;
    }

    const data = await response.json();

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(typeof data.latitude).toBe('number');
    expect(typeof data.longitude).toBe('number');
    expect(typeof data.current).toBe('object');
    expect(typeof data.current.temperature_2m).toBe('number');
    expect(typeof data.current.wind_speed_10m).toBe('number');
  });

  it('3. GitHub REST API - JSON with Base64 file content', async () => {
    const response = await fetchWithLog(
      'GitHub README',
      proxyFetch,
      LIVE_ENDPOINTS.githubReadme,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (
      shouldSkipStrictChecksForTemporaryUpstreamFailure(
        'GitHub README',
        response,
      )
    ) {
      return;
    }

    const data = await response.json();

    if (response.status === HTTP_STATUS_FORBIDDEN) {
      expect(typeof data.message).toBe('string');
      logSection('GitHub README: skipped strict assertions after 403', {
        reason: 'GitHub public API rate limit or access restriction',
        message: data.message,
      });

      return;
    }

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(response.headers.get('content-type')).toContain('json');
    expect(data.name).toBe('README.md');
    expect(data.encoding).toBe('base64');
    expect(typeof data.content).toBe('string');

    const decoded = Buffer.from(
      data.content.replace(/\n/g, ''),
      'base64',
    ).toString('utf8');

    expect(decoded.length).toBeGreaterThan(GITHUB_README_MIN_CHARS);
  });

  it('4. httpbin - Base64 decoded text response', async () => {
    const response = await fetchWithLog(
      'httpbin base64',
      proxyFetch,
      LIVE_ENDPOINTS.httpbinBase64,
    );

    if (
      shouldSkipStrictChecksForTemporaryUpstreamFailure(
        'httpbin base64',
        response,
      )
    ) {
      return;
    }

    const text = await response.text();

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(text).toBe('Hello, fetch!');
  });

  it('5. httpbin - streaming JSON lines', async () => {
    const response = await fetchWithLog(
      'httpbin stream',
      proxyFetch,
      LIVE_ENDPOINTS.httpbinStream,
    );

    if (
      shouldSkipStrictChecksForTemporaryUpstreamFailure(
        'httpbin stream',
        response,
      )
    ) {
      return;
    }

    const text = await response.text();
    const lines = text.trim().split('\n');

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(lines).toHaveLength(STREAM_LINE_COUNT);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('6. httpbin - streamed random binary bytes', async () => {
    const response = await fetchWithLog(
      'httpbin stream bytes',
      proxyFetch,
      LIVE_ENDPOINTS.httpbinStreamBytes,
    );

    if (
      shouldSkipStrictChecksForTemporaryUpstreamFailure(
        'httpbin stream bytes',
        response,
      )
    ) {
      return;
    }

    const buffer = await response.arrayBuffer();

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(buffer.byteLength).toBe(STREAM_BYTE_LENGTH);
  });

  it('7. httpbin - multipart/form-data POST echo', async () => {
    const formData = new FormData();

    formData.set('name', 'proxy-fetch');
    formData.set(
      'file',
      new Blob(['hello from file'], {
        type: 'text/plain',
      }),
      'hello.txt',
    );

    const response = await fetchWithLog(
      'httpbin multipart',
      proxyFetch,
      LIVE_ENDPOINTS.httpbinPost,
      {
        method: 'POST',
        body: formData,
      },
    );

    if (
      shouldSkipStrictChecksForTemporaryUpstreamFailure(
        'httpbin multipart',
        response,
      )
    ) {
      return;
    }

    const data = await response.json();

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(data.form.name).toBe('proxy-fetch');
    expect(data.files.file).toBe('hello from file');
    expect(data.headers['Content-Type']).toContain('multipart/form-data');
  });

  it('8. httpbin - gzip response', async () => {
    const response = await fetchWithLog(
      'httpbin gzip',
      proxyFetch,
      LIVE_ENDPOINTS.httpbinGzip,
    );

    if (
      shouldSkipStrictChecksForTemporaryUpstreamFailure(
        'httpbin gzip',
        response,
      )
    ) {
      return;
    }

    const data = await response.json();

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(data.gzipped).toBe(true);
    expect(typeof data.headers).toBe('object');
  });

  it('9. Picsum - binary image response with redirect', async () => {
    const response = await fetchWithLog(
      'Picsum image',
      proxyFetch,
      LIVE_ENDPOINTS.picsumImage,
    );

    if (
      shouldSkipStrictChecksForTemporaryUpstreamFailure(
        'Picsum image',
        response,
      )
    ) {
      return;
    }

    const contentType = response.headers.get('content-type');
    const buffer = await response.arrayBuffer();

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(contentType).toContain('image/jpeg');
    expect(buffer.byteLength).toBeGreaterThan(MIN_NON_EMPTY_BINARY_BYTES);
  });

  it('10. World Bank API - XML and JSON variants', async () => {
    const xmlResponse = await fetchWithLog(
      'World Bank XML',
      proxyFetch,
      LIVE_ENDPOINTS.worldBankXml,
    );

    if (
      shouldSkipStrictChecksForTemporaryUpstreamFailure(
        'World Bank XML',
        xmlResponse,
      )
    ) {
      return;
    }

    const xml = await xmlResponse.text();

    expect(xmlResponse.status).toBe(HTTP_STATUS_OK);
    expect(xml).toContain('<?xml');

    const jsonResponse = await fetchWithLog(
      'World Bank JSON',
      proxyFetch,
      LIVE_ENDPOINTS.worldBankJson,
    );

    if (
      shouldSkipStrictChecksForTemporaryUpstreamFailure(
        'World Bank JSON',
        jsonResponse,
      )
    ) {
      return;
    }

    const json = await jsonResponse.json();

    expect(jsonResponse.status).toBe(HTTP_STATUS_OK);
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBeGreaterThanOrEqual(WORLD_BANK_MIN_JSON_ITEMS);
  });
});
