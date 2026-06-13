import { randomUUID } from 'node:crypto';

import {
  BINARY_BODY_PART_NAME,
  BINARY_BODY_TRANSPORT_JSON_BASE64,
  BODY_KIND_BASE64,
  BODY_KIND_BINARY,
  BODY_KIND_TEXT,
  FORM_URLENCODED_CONTENT_TYPE,
  GRAPHQL_CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  SERVICE_REQUEST_TRANSPORT_JSON,
  SERVICE_REQUEST_TRANSPORT_MULTIPART,
  TEXT_CONTENT_TYPE_PREFIX,
  WIRE_PROTOCOL_VERSION,
  XML_CONTENT_TYPE,
} from '../constants';
import type {
  HeaderPair,
  ServiceBodyEnvelope,
  ServiceFetchRequestEnvelope,
} from '../service/contract';
import type { BinaryBodyTransport, ProxyFetchContext } from '../types';

export type ServiceRequestTransport =
  | typeof SERVICE_REQUEST_TRANSPORT_JSON
  | typeof SERVICE_REQUEST_TRANSPORT_MULTIPART;

export interface SerializedServiceRequest {
  envelope: ServiceFetchRequestEnvelope;
  transport: ServiceRequestTransport;
  body?: BodyInit;
  bodyPart?: Blob;
  contentType?: string;
  uploadCompletion?: Promise<void>;
}

export interface SerializeRequestOptions {
  request: Request;
  requestBody: BodyInit | null | undefined;
  headers: HeaderPair[];
  context: ProxyFetchContext;
  timeoutMs: number;
  binaryBodyTransport: BinaryBodyTransport;
  signal: AbortSignal;
}

interface DuplexRequest extends Request {
  duplex: 'half';
}

const isUrlSearchParams = (value: unknown): value is URLSearchParams =>
  value instanceof URLSearchParams;
const isBlob = (value: unknown): value is Blob => value instanceof Blob;
const isFormData = (value: unknown): value is FormData =>
  value instanceof FormData;
const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  value instanceof ArrayBuffer;
const isArrayBufferView = (value: unknown): value is ArrayBufferView =>
  ArrayBuffer.isView(value);
const isReadableStream = (value: unknown): value is ReadableStream =>
  value instanceof ReadableStream;
const isDuplexRequest = (request: Request): request is DuplexRequest =>
  'duplex' in request && request.duplex === 'half';
const isTextContentType = (contentType: string | null): boolean => {
  if (contentType === null) {
    return false;
  }

  const normalizedContentType = contentType.toLowerCase();

  return (
    normalizedContentType.startsWith(TEXT_CONTENT_TYPE_PREFIX)
    || normalizedContentType.includes(JSON_CONTENT_TYPE)
    || normalizedContentType.includes(FORM_URLENCODED_CONTENT_TYPE)
    || normalizedContentType.includes(XML_CONTENT_TYPE)
    || normalizedContentType.includes(GRAPHQL_CONTENT_TYPE)
  );
};
const CRLF = '\r\n';
const STREAMING_MULTIPART_BOUNDARY_PREFIX = 'proxy-fetch-stream';
const METADATA_PART_NAME = 'meta';
const OCTET_STREAM_CONTENT_TYPE = 'application/octet-stream';
const MULTIPART_CONTENT_TYPE_PREFIX = 'multipart/form-data';
const textEncoder = new TextEncoder();
const createBaseEnvelope = ({
  request,
  requestBody,
  headers,
  context,
  timeoutMs,
  body,
}: {
  request: Request;
  requestBody: BodyInit | null | undefined;
  headers: HeaderPair[];
  context: ProxyFetchContext;
  timeoutMs: number;
  body: ServiceBodyEnvelope;
}): ServiceFetchRequestEnvelope => ({
  version: WIRE_PROTOCOL_VERSION,
  request: {
    url: request.url,
    method: request.method,
    headers,
    body,
    ...createRequestMetadata(request, requestBody),
  },
  options: {
    timeoutMs,
  },
  context,
});
const createRequestMetadata = (
  request: Request,
  requestBody: BodyInit | null | undefined,
): Partial<ServiceFetchRequestEnvelope['request']> => {
  const metadata: Partial<ServiceFetchRequestEnvelope['request']> = {};

  if (request.mode !== 'cors') {
    metadata.mode = request.mode;
  }
  if (request.credentials !== 'same-origin') {
    metadata.credentials = request.credentials;
  }
  if (request.cache !== 'default') {
    metadata.cache = request.cache;
  }
  if (request.redirect !== 'follow') {
    metadata.redirect = request.redirect;
  }
  if (request.referrer !== 'about:client') {
    metadata.referrer = request.referrer;
  }
  if (request.referrerPolicy !== '') {
    metadata.referrerPolicy = request.referrerPolicy;
  }
  if (request.integrity !== '') {
    metadata.integrity = request.integrity;
  }
  if (request.keepalive) {
    metadata.keepalive = request.keepalive;
  }
  if (isReadableStream(requestBody) && isDuplexRequest(request)) {
    metadata.duplex = request.duplex;
  }

  return metadata;
};
const serializeBinaryBody = async ({
  request,
  requestBody,
  headers,
  context,
  timeoutMs,
  binaryBodyTransport,
}: SerializeRequestOptions): Promise<SerializedServiceRequest> => {
  const body = await request.arrayBuffer();

  if (binaryBodyTransport === BINARY_BODY_TRANSPORT_JSON_BASE64) {
    return {
      transport: SERVICE_REQUEST_TRANSPORT_JSON,
      envelope: createBaseEnvelope({
        request,
        requestBody,
        headers,
        context,
        timeoutMs,
        body: {
          kind: BODY_KIND_BASE64,
          data: Buffer.from(body).toString(BODY_KIND_BASE64),
        },
      }),
    };
  }

  return {
    transport: SERVICE_REQUEST_TRANSPORT_MULTIPART,
    bodyPart: new Blob([body]),
    envelope: createBaseEnvelope({
      request,
      requestBody,
      headers,
      context,
      timeoutMs,
      body: {
        kind: BODY_KIND_BINARY,
        partName: BINARY_BODY_PART_NAME,
      },
    }),
  };
};
const monitorReadableStream = (
  stream: ReadableStream,
  signal: AbortSignal,
  cancelOnAbort?: {
    cancel(reason: unknown): Promise<void>;
  },
): Promise<void> => {
  const reader = stream.getReader();

  return new Promise((resolve, reject) => {
    const rejectWithAbortReason = (): void => {
      const reason = signal.reason;

      void reader.cancel(reason).catch(() => undefined);
      void cancelOnAbort?.cancel(reason).catch(() => undefined);
      reject(reason);
    };

    if (signal.aborted) {
      rejectWithAbortReason();

      return;
    }

    signal.addEventListener('abort', rejectWithAbortReason, {
      once: true,
    });

    void (async () => {
      try {
        while (true) {
          const result = await reader.read();

          if (result.done) {
            resolve();

            return;
          }
        }
      } catch (error) {
        reject(error);
      } finally {
        signal.removeEventListener('abort', rejectWithAbortReason);
        reader.releaseLock();
      }
    })();
  });
};
const createStreamingMultipartBody = ({
  boundary,
  envelope,
  bodyStream,
}: {
  boundary: string;
  envelope: ServiceFetchRequestEnvelope;
  bodyStream: ReadableStream;
}): {
  body: ReadableStream<Uint8Array>;
  cancel(reason: unknown): Promise<void>;
} => {
  const reader = bodyStream.getReader();
  const preamble = textEncoder.encode(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${METADATA_PART_NAME}"`,
      `Content-Type: ${JSON_CONTENT_TYPE}`,
      '',
      JSON.stringify(envelope),
      `--${boundary}`,
      `Content-Disposition: form-data; name="${BINARY_BODY_PART_NAME}"; filename="${BINARY_BODY_PART_NAME}"`,
      `Content-Type: ${OCTET_STREAM_CONTENT_TYPE}`,
      '',
      '',
    ].join(CRLF),
  );
  const closingBoundary = textEncoder.encode(`${CRLF}--${boundary}--${CRLF}`);
  let preambleSent = false;
  let closingBoundarySent = false;
  let cancelled = false;
  let cancelReason: unknown;
  const throwIfCancelled = (): void => {
    if (cancelled) {
      throw cancelReason;
    }
  };

  return {
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        throwIfCancelled();

        if (!preambleSent) {
          preambleSent = true;
          controller.enqueue(preamble);

          return;
        }

        const result = await reader.read();

        throwIfCancelled();

        if (!result.done) {
          controller.enqueue(result.value);

          return;
        }
        if (!closingBoundarySent) {
          closingBoundarySent = true;
          controller.enqueue(closingBoundary);

          return;
        }

        controller.close();
        reader.releaseLock();
      },
      async cancel(reason) {
        cancelled = true;
        cancelReason = reason;
        await reader.cancel(reason);
        reader.releaseLock();
      },
    }),
    async cancel(reason) {
      cancelled = true;
      cancelReason = reason;
      await reader.cancel(reason);
      reader.releaseLock();
    },
  };
};
const serializeStreamingBody = ({
  request,
  requestBody,
  headers,
  context,
  timeoutMs,
  signal,
}: SerializeRequestOptions & {
  requestBody: ReadableStream;
}): SerializedServiceRequest => {
  const [bodyStream, monitorStream] = requestBody.tee();
  const boundary = `${STREAMING_MULTIPART_BOUNDARY_PREFIX}-${randomUUID()}`;
  const envelope = createBaseEnvelope({
    request,
    requestBody,
    headers,
    context,
    timeoutMs,
    body: {
      kind: BODY_KIND_BINARY,
      partName: BINARY_BODY_PART_NAME,
    },
  });
  const streamingBody = createStreamingMultipartBody({
    boundary,
    envelope,
    bodyStream,
  });

  return {
    transport: SERVICE_REQUEST_TRANSPORT_MULTIPART,
    body: streamingBody.body,
    contentType: `${MULTIPART_CONTENT_TYPE_PREFIX}; boundary=${boundary}`,
    uploadCompletion: monitorReadableStream(monitorStream, signal, {
      cancel: streamingBody.cancel,
    }),
    envelope,
  };
};

export const serializeRequest = async (
  options: SerializeRequestOptions,
): Promise<SerializedServiceRequest> => {
  const { request, requestBody, headers, context, timeoutMs } = options;

  if (request.body === null) {
    return {
      transport: SERVICE_REQUEST_TRANSPORT_JSON,
      envelope: createBaseEnvelope({
        request,
        requestBody,
        headers,
        context,
        timeoutMs,
        body: null,
      }),
    };
  }
  if (typeof requestBody === 'string' || isUrlSearchParams(requestBody)) {
    return {
      transport: SERVICE_REQUEST_TRANSPORT_JSON,
      envelope: createBaseEnvelope({
        request,
        requestBody,
        headers,
        context,
        timeoutMs,
        body: {
          kind: BODY_KIND_TEXT,
          text: requestBody.toString(),
        },
      }),
    };
  }
  if (isReadableStream(requestBody)) {
    return serializeStreamingBody({
      ...options,
      requestBody,
    });
  }
  if (
    isBlob(requestBody)
    || isFormData(requestBody)
    || isArrayBuffer(requestBody)
    || isArrayBufferView(requestBody)
  ) {
    return serializeBinaryBody(options);
  }
  if (isTextContentType(request.headers.get('content-type'))) {
    return {
      transport: SERVICE_REQUEST_TRANSPORT_JSON,
      envelope: createBaseEnvelope({
        request,
        requestBody,
        headers,
        context,
        timeoutMs,
        body: {
          kind: BODY_KIND_TEXT,
          text: await request.text(),
        },
      }),
    };
  }

  return serializeBinaryBody(options);
};
