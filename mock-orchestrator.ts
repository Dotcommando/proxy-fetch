import { Buffer } from 'node:buffer';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { pathToFileURL } from 'node:url';

import {
  BODY_KIND_BASE64,
  BODY_KIND_BINARY,
  BODY_KIND_TEXT,
  CONTENT_TYPE_HEADER_NAME,
  JSON_CONTENT_TYPE,
  METADATA_PART_NAME,
  MULTIPART_CONTENT_TYPE_PREFIX,
  WIRE_PROTOCOL_VERSION,
} from './src/constants';
import type {
  BinaryBodyEnvelope,
  HeaderPair,
  ServiceBodyEnvelope,
  ServiceFetchFailureEnvelope,
  ServiceFetchRequestEnvelope,
  ServiceFetchSuccessEnvelope,
} from './src/service/contract';

const DEFAULT_HOSTNAME = '127.0.0.1';
const DEFAULT_PORT = 0;
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_METHOD_NOT_ALLOWED = 405;
const HEADER_PAIR_LENGTH = 2;
const SERVICE_REQUEST_PATH = '/';
const NO_BODY_STATUS_CODES = new Set([204, 205, 304]);
const TEXT_CONTENT_TYPE_PREFIX = 'text/';
const JSON_CONTENT_TYPE_FRAGMENT = 'json';
const XML_CONTENT_TYPE_FRAGMENT = 'xml';
const FORM_URLENCODED_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const GRAPHQL_CONTENT_TYPE = 'application/graphql';
const JAVASCRIPT_CONTENT_TYPE_FRAGMENT = 'javascript';
const SERVICE_ERROR_INVALID_REQUEST = 'INVALID_REQUEST';
const SERVICE_ERROR_UPSTREAM_FETCH = 'UPSTREAM_FETCH_ERROR';
const CRLF = '\r\n';
const BODY_PREVIEW_BYTES = 512;

export interface MockOrchestratorOptions {
  hostname?: string;
  port?: number;
  log?: (message: string) => void;
}

export interface MockOrchestrator {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

interface MultipartPart {
  readonly headers: Headers;
  readonly data: Buffer;
  readonly filename?: string;
}

interface ParsedServiceRequest {
  readonly envelope: ServiceFetchRequestEnvelope;
  readonly parts: Map<string, MultipartPart>;
}

interface ExtendedRequestInit extends RequestInit {
  duplex?: 'half';
}

export const startMockOrchestrator = async (
  options: MockOrchestratorOptions = {},
): Promise<MockOrchestrator> => {
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const port = options.port ?? DEFAULT_PORT;
  const server = createServer((request, response) => {
    void handleRequest(request, response, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Mock orchestrator did not bind to a TCP address.');
  }

  const url = `http://${hostname}:${address.port}`;

  options.log?.(`mock orchestrator listening on ${url}`);

  return {
    server,
    url,
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

const handleRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  options: MockOrchestratorOptions,
): Promise<void> => {
  const targetAbortController = new AbortController();
  const abortTargetRequest = (): void => {
    if (!response.writableEnded) {
      targetAbortController.abort(
        new DOMException('Proxy fetch client disconnected.', 'AbortError'),
      );
    }
  };

  response.once('close', abortTargetRequest);

  try {
    if (request.method === 'GET' && request.url === '/health') {
      sendText(response, HTTP_STATUS_OK, 'ok');

      return;
    }
    if (request.url !== SERVICE_REQUEST_PATH) {
      sendText(response, HTTP_STATUS_NOT_FOUND, 'Not Found');

      return;
    }
    if (request.method !== 'POST') {
      sendText(response, HTTP_STATUS_METHOD_NOT_ALLOWED, 'Method Not Allowed');

      return;
    }

    const serviceRequest = await parseServiceRequest(request);

    logServiceRequest(options, serviceRequest);

    const serviceResponse = await executeServiceRequest(
      serviceRequest,
      options,
      targetAbortController.signal,
    );

    logServiceResponse(options, serviceResponse);

    await sendServiceSuccess(response, serviceResponse);
  } catch (error) {
    options.log?.(
      `mock orchestrator error: ${error instanceof Error ? error.message : String(error)}`,
    );
    sendJson(response, HTTP_STATUS_BAD_REQUEST, createFailureEnvelope(error));
  } finally {
    response.off('close', abortTargetRequest);
  }
};
const parseServiceRequest = async (
  request: IncomingMessage,
): Promise<ParsedServiceRequest> => {
  const contentType = request.headers[CONTENT_TYPE_HEADER_NAME];
  const body = await readIncomingMessage(request);

  if (
    typeof contentType === 'string'
    && contentType.toLowerCase().startsWith(MULTIPART_CONTENT_TYPE_PREFIX)
  ) {
    const boundary = readMultipartBoundary(contentType);
    const parts = parseMultipartBody(body, boundary);
    const metadataPart = parts.get(METADATA_PART_NAME);

    if (metadataPart === undefined) {
      throw new Error('Multipart request is missing meta part.');
    }

    return {
      envelope: parseServiceRequestEnvelope(metadataPart.data.toString('utf8')),
      parts,
    };
  }

  return {
    envelope: parseServiceRequestEnvelope(body.toString('utf8')),
    parts: new Map(),
  };
};
const executeServiceRequest = async (
  { envelope, parts }: ParsedServiceRequest,
  options: MockOrchestratorOptions,
  signal: AbortSignal,
): Promise<ServiceFetchSuccessEnvelope> => {
  const targetRequestInit = createTargetRequestInit(envelope, parts);

  targetRequestInit.signal = signal;
  logTargetRequest(options, envelope, targetRequestInit);

  const targetResponse = await fetch(envelope.request.url, targetRequestInit);
  const responseHeaders = Array.from(targetResponse.headers.entries());
  const responseEnvelope = createBaseSuccessEnvelope(
    targetResponse,
    responseHeaders,
  );

  if (NO_BODY_STATUS_CODES.has(targetResponse.status)) {
    logTargetResponse(options, targetResponse, null);

    responseEnvelope.response.body = null;

    return responseEnvelope;
  }
  if (isTextLikeResponse(targetResponse.headers)) {
    const responseBody = Buffer.from(await targetResponse.arrayBuffer());

    logTargetResponse(options, targetResponse, responseBody);

    if (responseBody.byteLength === 0) {
      responseEnvelope.response.body = null;

      return responseEnvelope;
    }

    responseEnvelope.response.body = {
      kind: BODY_KIND_TEXT,
      text: responseBody.toString('utf8'),
    };

    return responseEnvelope;
  }

  logTargetResponse(options, targetResponse, null);

  responseEnvelope.response.body = {
    kind: BODY_KIND_BINARY,
    partName: 'body',
  };
  responseEnvelope.response.bodyPart = targetResponse.body ?? new Blob();

  return responseEnvelope;
};
const createTargetRequestInit = (
  envelope: ServiceFetchRequestEnvelope,
  parts: Map<string, MultipartPart>,
): ExtendedRequestInit => {
  const body = createTargetRequestBody(envelope.request.body, parts);
  const init: ExtendedRequestInit = {
    method: envelope.request.method,
    headers: new Headers(envelope.request.headers),
  };

  if (
    body !== null
    && envelope.request.method !== 'GET'
    && envelope.request.method !== 'HEAD'
  ) {
    init.body = body;
  }
  if (envelope.request.mode !== undefined) {
    init.mode = envelope.request.mode;
  }
  if (envelope.request.credentials !== undefined) {
    init.credentials = envelope.request.credentials;
  }
  if (envelope.request.cache !== undefined) {
    init.cache = envelope.request.cache;
  }
  if (envelope.request.redirect !== undefined) {
    init.redirect = envelope.request.redirect;
  }
  if (envelope.request.referrer !== undefined) {
    init.referrer = envelope.request.referrer;
  }
  if (envelope.request.referrerPolicy !== undefined) {
    init.referrerPolicy = envelope.request.referrerPolicy;
  }
  if (envelope.request.integrity !== undefined) {
    init.integrity = envelope.request.integrity;
  }
  if (envelope.request.keepalive !== undefined) {
    init.keepalive = envelope.request.keepalive;
  }
  if (envelope.request.duplex !== undefined) {
    init.duplex = envelope.request.duplex;
  }

  return init;
};
const createTargetRequestBody = (
  body: ServiceBodyEnvelope,
  parts: Map<string, MultipartPart>,
): BodyInit | null => {
  if (body === null) {
    return null;
  }
  if (body.kind === BODY_KIND_TEXT) {
    return body.text;
  }
  if (body.kind === BODY_KIND_BASE64) {
    return new Uint8Array(Buffer.from(body.data, BODY_KIND_BASE64));
  }

  return new Uint8Array(readBinaryBodyPart(body, parts));
};
const readBinaryBodyPart = (
  body: BinaryBodyEnvelope,
  parts: Map<string, MultipartPart>,
): Buffer => {
  const bodyPart = parts.get(body.partName);

  if (bodyPart === undefined) {
    throw new Error(`Multipart request is missing ${body.partName} part.`);
  }

  return bodyPart.data;
};
const createBaseSuccessEnvelope = (
  response: Response,
  headers: HeaderPair[],
): ServiceFetchSuccessEnvelope => ({
  version: WIRE_PROTOCOL_VERSION,
  ok: true,
  response: {
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    redirected: response.redirected,
    type: response.type,
    headers,
    body: null,
  },
});
const sendServiceSuccess = async (
  response: ServerResponse,
  envelope: ServiceFetchSuccessEnvelope,
): Promise<void> => {
  if (envelope.response.body?.kind === BODY_KIND_BINARY) {
    await sendMultipartServiceResponse(
      response,
      envelope,
      envelope.response.bodyPart ?? new Blob(),
    );

    return;
  }

  sendJson(response, HTTP_STATUS_OK, withoutBodyPart(envelope));
};
const sendMultipartServiceResponse = async (
  response: ServerResponse,
  envelope: ServiceFetchSuccessEnvelope,
  bodyPart: BodyInit,
): Promise<void> => {
  const boundary = `proxy-fetch-mock-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const partName =
    envelope.response.body?.kind === BODY_KIND_BINARY
      ? envelope.response.body.partName
      : 'body';

  response.writeHead(HTTP_STATUS_OK, {
    [CONTENT_TYPE_HEADER_NAME]: `${MULTIPART_CONTENT_TYPE_PREFIX}; boundary=${boundary}`,
  });
  response.write(
    createMultipartTextPart(
      boundary,
      METADATA_PART_NAME,
      JSON.stringify(withoutBodyPart(envelope)),
      JSON_CONTENT_TYPE,
    ),
  );
  response.write(createMultipartBinaryPartHeader(boundary, partName));
  await writeBodyPart(response, bodyPart);
  response.end(`${CRLF}--${boundary}--${CRLF}`);
};
const withoutBodyPart = (
  envelope: ServiceFetchSuccessEnvelope,
): ServiceFetchSuccessEnvelope => {
  const response = {
    ...envelope.response,
  };

  delete response.bodyPart;

  return {
    ...envelope,
    response,
  };
};
const logServiceRequest = (
  options: MockOrchestratorOptions,
  request: ParsedServiceRequest,
): void => {
  logSection(options, 'mock orchestrator received service request', {
    envelope: request.envelope,
  });

  const body = request.envelope.request.body;

  if (body?.kind === BODY_KIND_BINARY) {
    const part = request.parts.get(body.partName);
    const partHeaders = new Headers(part?.headers);
    const targetContentType = readHeaderPairValue(
      request.envelope.request.headers,
      CONTENT_TYPE_HEADER_NAME,
    );

    if (targetContentType !== undefined) {
      partHeaders.set(CONTENT_TYPE_HEADER_NAME, targetContentType);
    }

    logSection(options, 'mock orchestrator received binary body part', {
      partName: body.partName,
      headers: part === undefined ? null : headersToObject(partHeaders),
      preview:
        part === undefined
          ? '<missing>'
          : formatBodyPreview(part.data, partHeaders),
    });
  }
};
const logTargetRequest = (
  options: MockOrchestratorOptions,
  envelope: ServiceFetchRequestEnvelope,
  init: ExtendedRequestInit,
): void => {
  logSection(options, 'mock orchestrator executing target request', {
    url: envelope.request.url,
    method: init.method,
    headers: headersToObject(new Headers(init.headers)),
    body: formatServiceBodyForLog(envelope.request.body),
    fetchMetadata: {
      mode: init.mode,
      credentials: init.credentials,
      cache: init.cache,
      redirect: init.redirect,
      referrer: init.referrer,
      referrerPolicy: init.referrerPolicy,
      integrity: init.integrity,
      keepalive: init.keepalive,
      duplex: init.duplex,
    },
  });
};
const logTargetResponse = (
  options: MockOrchestratorOptions,
  response: Response,
  body: Buffer | null,
): void => {
  logSection(options, 'mock orchestrator received target response', {
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    redirected: response.redirected,
    type: response.type,
    headers: headersToObject(response.headers),
    body:
      body === null
        ? '<streaming or empty body>'
        : formatBodyPreview(body, response.headers),
  });
};
const logServiceResponse = (
  options: MockOrchestratorOptions,
  envelope: ServiceFetchSuccessEnvelope,
): void => {
  logSection(options, 'mock orchestrator sending service response', {
    envelope: withoutBodyPart(envelope),
    bodyPart:
      envelope.response.bodyPart === undefined
        ? null
        : `<binary ${readBodyPartSize(envelope.response.bodyPart)} bytes>`,
  });
};
const readBodyPartSize = (bodyPart: BodyInit): number | 'unknown' =>
  bodyPart instanceof Blob ? bodyPart.size : 'unknown';
const logSection = (
  options: MockOrchestratorOptions,
  title: string,
  value: unknown,
): void => {
  options.log?.(`\n[${title}]\n${formatJson(value)}`);
};
const formatJson = (value: unknown): string => JSON.stringify(value, null, 2);
const formatServiceBodyForLog = (body: ServiceBodyEnvelope): unknown => {
  if (body === null) {
    return null;
  }
  if (body.kind === BODY_KIND_TEXT) {
    return formatTextBodyPreview(body.text, new Headers());
  }
  if (body.kind === BODY_KIND_BASE64) {
    const data = Buffer.from(body.data, BODY_KIND_BASE64);

    return formatBodyPreview(data, new Headers());
  }

  return {
    kind: body.kind,
    partName: body.partName,
  };
};
const formatBodyPreview = (body: Buffer, headers: Headers): unknown => {
  const contentType = headers.get(CONTENT_TYPE_HEADER_NAME);

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
  if (isProbablyText(contentType, body)) {
    return formatTextBodyPreview(body.toString('utf8'), headers);
  }

  return {
    kind: 'binary',
    contentType,
    bytes: body.byteLength,
    firstBytesHex: body.subarray(0, BODY_PREVIEW_BYTES).toString('hex'),
  };
};
const formatTextBodyPreview = (text: string, headers: Headers): unknown => ({
  kind: 'text',
  contentType: headers.get(CONTENT_TYPE_HEADER_NAME),
  chars: text.length,
  text:
    text.length > BODY_PREVIEW_BYTES
      ? `${text.slice(0, BODY_PREVIEW_BYTES)}...`
      : text,
});
const isJsonContentType = (contentType: string | null): boolean =>
  contentType?.toLowerCase().includes(JSON_CONTENT_TYPE_FRAGMENT) === true;
const isProbablyText = (contentType: string | null, body: Buffer): boolean => {
  if (contentType !== null && isTextLikeContentType(contentType)) {
    return true;
  }

  return !body.subarray(0, BODY_PREVIEW_BYTES).includes(0);
};
const isTextLikeContentType = (contentType: string): boolean => {
  const normalized = contentType.toLowerCase();

  return (
    normalized.startsWith(TEXT_CONTENT_TYPE_PREFIX)
    || normalized.startsWith(MULTIPART_CONTENT_TYPE_PREFIX)
    || normalized.includes(XML_CONTENT_TYPE_FRAGMENT)
    || normalized.includes(FORM_URLENCODED_CONTENT_TYPE)
    || normalized.includes(GRAPHQL_CONTENT_TYPE)
    || normalized.includes(JAVASCRIPT_CONTENT_TYPE_FRAGMENT)
  );
};
const headersToObject = (headers: Headers): Record<string, string> => {
  const result: Record<string, string> = {};

  headers.forEach((value, key) => {
    result[key] = value;
  });

  return result;
};
const readHeaderPairValue = (
  headers: HeaderPair[],
  headerName: string,
): string | undefined =>
  headers.find(([name]) => name.toLowerCase() === headerName)?.[1];
const createFailureEnvelope = (
  error: unknown,
): ServiceFetchFailureEnvelope => ({
  version: WIRE_PROTOCOL_VERSION,
  ok: false,
  error: {
    code:
      error instanceof TypeError
        ? SERVICE_ERROR_UPSTREAM_FETCH
        : SERVICE_ERROR_INVALID_REQUEST,
    message: error instanceof Error ? error.message : String(error),
    retryable: error instanceof TypeError,
  },
});
const parseServiceRequestEnvelope = (
  text: string,
): ServiceFetchRequestEnvelope => {
  const parsed: unknown = JSON.parse(text);

  if (!isRecord(parsed)) {
    throw new Error('Service request envelope must be an object.');
  }
  if (parsed.version !== WIRE_PROTOCOL_VERSION) {
    throw new Error('Unsupported service request envelope version.');
  }

  const request = readRecord(parsed, 'request');
  const options = readRecord(parsed, 'options');
  const context = isRecord(parsed.context) ? parsed.context : {};

  return {
    version: WIRE_PROTOCOL_VERSION,
    request: {
      url: readString(request, 'url'),
      method: readString(request, 'method'),
      headers: parseHeaderPairs(request.headers),
      body: parseServiceBody(request.body),
      ...parseRequestMetadata(request),
    },
    options: {
      timeoutMs: readNumber(options, 'timeoutMs'),
    },
    context,
  };
};
const parseRequestMetadata = (
  request: Record<string, unknown>,
): Partial<ServiceFetchRequestEnvelope['request']> => {
  const metadata: Partial<ServiceFetchRequestEnvelope['request']> = {};

  copyStringProperty(request, metadata, 'mode');
  copyStringProperty(request, metadata, 'credentials');
  copyStringProperty(request, metadata, 'cache');
  copyStringProperty(request, metadata, 'redirect');
  copyStringProperty(request, metadata, 'referrer');
  copyStringProperty(request, metadata, 'referrerPolicy');
  copyStringProperty(request, metadata, 'integrity');
  copyStringProperty(request, metadata, 'duplex');

  if (typeof request.keepalive === 'boolean') {
    metadata.keepalive = request.keepalive;
  }

  return metadata;
};
const copyStringProperty = <
  TKey extends keyof ServiceFetchRequestEnvelope['request'],
>(
  source: Record<string, unknown>,
  target: Partial<ServiceFetchRequestEnvelope['request']>,
  key: TKey,
): void => {
  const value = source[String(key)];

  if (typeof value === 'string') {
    Object.assign(target, {
      [key]: value,
    });
  }
};
const parseHeaderPairs = (value: unknown): HeaderPair[] => {
  if (!Array.isArray(value)) {
    throw new Error('Request headers must be an array.');
  }

  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== HEADER_PAIR_LENGTH) {
      throw new Error('Request header entries must be name/value pairs.');
    }

    const [name, headerValue] = entry;

    if (typeof name !== 'string' || typeof headerValue !== 'string') {
      throw new Error('Request header names and values must be strings.');
    }

    return [name, headerValue];
  });
};
const parseServiceBody = (value: unknown): ServiceBodyEnvelope => {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error('Request body must be an object or null.');
  }
  if (value.kind === BODY_KIND_TEXT) {
    return {
      kind: BODY_KIND_TEXT,
      text: readString(value, 'text'),
    };
  }
  if (value.kind === BODY_KIND_BASE64) {
    return {
      kind: BODY_KIND_BASE64,
      data: readString(value, 'data'),
    };
  }
  if (value.kind === BODY_KIND_BINARY) {
    return {
      kind: BODY_KIND_BINARY,
      partName: readString(value, 'partName'),
    };
  }

  throw new Error('Request body kind is unsupported.');
};
const parseMultipartBody = (
  body: Buffer,
  boundary: string,
): Map<string, MultipartPart> => {
  const parts = new Map<string, MultipartPart>();
  const boundaryMarker = Buffer.from(`--${boundary}`);
  const partBoundaryMarker = Buffer.from(`${CRLF}--${boundary}`);
  let boundaryStart = body.indexOf(boundaryMarker);

  while (boundaryStart !== -1) {
    const afterBoundary = boundaryStart + boundaryMarker.byteLength;

    if (
      body.subarray(afterBoundary, afterBoundary + 2).equals(Buffer.from('--'))
    ) {
      break;
    }

    const partStart = afterBoundary + CRLF.length;
    const headersEnd = body.indexOf(Buffer.from(`${CRLF}${CRLF}`), partStart);

    if (headersEnd === -1) {
      break;
    }

    const bodyStart = headersEnd + `${CRLF}${CRLF}`.length;
    const nextBoundary = body.indexOf(partBoundaryMarker, bodyStart);

    if (nextBoundary === -1) {
      break;
    }

    const part = parseMultipartPart(
      body.subarray(partStart, headersEnd).toString('utf8'),
      body.subarray(bodyStart, nextBoundary),
    );

    parts.set(part.name, part.part);
    boundaryStart = nextBoundary + CRLF.length;
  }

  return parts;
};
const parseMultipartPart = (
  headerText: string,
  data: Buffer,
): {
  name: string;
  part: MultipartPart;
} => {
  const headers = new Headers();

  for (const line of headerText.split(CRLF)) {
    const separatorIndex = line.indexOf(':');

    if (separatorIndex === -1) {
      continue;
    }

    headers.set(
      line.slice(0, separatorIndex).trim().toLowerCase(),
      line.slice(separatorIndex + 1).trim(),
    );
  }

  const contentDisposition = headers.get('content-disposition') ?? '';
  const name = readContentDispositionParameter(contentDisposition, 'name');
  const filename = readContentDispositionParameter(
    contentDisposition,
    'filename',
  );

  if (name === undefined) {
    throw new Error('Multipart part is missing name.');
  }

  return {
    name,
    part:
      filename === undefined
        ? {
            headers,
            data,
          }
        : {
            headers,
            data,
            filename,
          },
  };
};
const readContentDispositionParameter = (
  contentDisposition: string,
  parameter: string,
): string | undefined => {
  const match = new RegExp(`${parameter}="([^"]*)"`).exec(contentDisposition);

  return match?.[1];
};
const readMultipartBoundary = (contentType: string): string => {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];

  if (boundary === undefined || boundary === '') {
    throw new Error('Multipart content-type is missing boundary.');
  }

  return boundary;
};
const createMultipartTextPart = (
  boundary: string,
  name: string,
  text: string,
  contentType: string,
): Buffer =>
  Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${name}"`,
      `Content-Type: ${contentType}`,
      '',
      text,
      '',
    ].join(CRLF),
  );
const createMultipartBinaryPartHeader = (
  boundary: string,
  name: string,
): Buffer =>
  Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${name}"; filename="${name}"`,
      'Content-Type: application/octet-stream',
      '',
      '',
    ].join(CRLF),
  );
const writeBodyPart = async (
  response: ServerResponse,
  bodyPart: BodyInit,
): Promise<void> => {
  const stream = createBodyPartStream(bodyPart);
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        return;
      }

      response.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
};
const createBodyPartStream = (
  bodyPart: BodyInit,
): ReadableStream<Uint8Array> => {
  if (bodyPart instanceof ReadableStream) {
    return bodyPart;
  }
  if (bodyPart instanceof Blob) {
    return bodyPart.stream();
  }
  if (typeof bodyPart === 'string') {
    return new Blob([bodyPart]).stream();
  }
  if (bodyPart instanceof URLSearchParams) {
    return new Blob([bodyPart.toString()]).stream();
  }
  if (bodyPart instanceof ArrayBuffer || ArrayBuffer.isView(bodyPart)) {
    return new Blob([bodyPart]).stream();
  }

  return new Blob().stream();
};
const sendJson = (
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void => {
  const body = Buffer.from(JSON.stringify(payload));

  response.writeHead(statusCode, {
    [CONTENT_TYPE_HEADER_NAME]: JSON_CONTENT_TYPE,
    'content-length': String(body.byteLength),
  });
  response.end(body);
};
const sendText = (
  response: ServerResponse,
  statusCode: number,
  text: string,
): void => {
  response.writeHead(statusCode, {
    [CONTENT_TYPE_HEADER_NAME]: 'text/plain; charset=utf-8',
  });
  response.end(text);
};
const readIncomingMessage = async (
  request: IncomingMessage,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};
const isTextLikeResponse = (headers: Headers): boolean => {
  const contentType = headers.get(CONTENT_TYPE_HEADER_NAME);

  if (contentType === null) {
    return false;
  }

  const normalized = contentType.toLowerCase();

  return (
    normalized.startsWith(TEXT_CONTENT_TYPE_PREFIX)
    || normalized.includes(JSON_CONTENT_TYPE_FRAGMENT)
    || normalized.includes(XML_CONTENT_TYPE_FRAGMENT)
    || normalized.includes(FORM_URLENCODED_CONTENT_TYPE)
    || normalized.includes(GRAPHQL_CONTENT_TYPE)
    || normalized.includes(JAVASCRIPT_CONTENT_TYPE_FRAGMENT)
  );
};
const readRecord = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const value = record[key];

  if (!isRecord(value)) {
    throw new Error(`${key} must be an object.`);
  }

  return value;
};
const readString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];

  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string.`);
  }

  return value;
};
const readNumber = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];

  if (typeof value !== 'number') {
    throw new Error(`${key} must be a number.`);
  }

  return value;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port =
    process.env.PORT === undefined ? DEFAULT_PORT : Number(process.env.PORT);

  void startMockOrchestrator({
    port,
    log: console.error,
  });
}
