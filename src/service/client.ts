import { Buffer } from 'node:buffer';

import {
  ACCEPT_HEADER_NAME,
  AUTHORIZATION_BEARER_PREFIX,
  AUTHORIZATION_HEADER_NAME,
  BINARY_BODY_PART_NAME,
  BODY_KIND_BINARY,
  CONTENT_TYPE_HEADER_NAME,
  INVALID_SERVICE_RESPONSE_CODE,
  JSON_CONTENT_TYPE,
  METADATA_PART_NAME,
  MULTIPART_CONTENT_TYPE_PREFIX,
  SERVICE_ACCEPT_HEADER_VALUE,
  SERVICE_HTTP_ERROR_CODE,
  SERVICE_HTTP_METHOD,
  SERVICE_REQUEST_TRANSPORT_JSON,
} from '../constants';
import { InvalidServiceResponseError, ProxyFetchServiceError } from '../errors';
import type { SerializedServiceRequest } from '../fetch/serialize-request';
import { parseServiceFetchResponseEnvelope } from '../internal/validation';
import type { ServiceFetchSuccessEnvelope } from './contract';

const CRLF = '\r\n';
const MULTIPART_PARSER_LOOKBEHIND_BYTES = 128;

export interface ServiceClientOptions {
  serviceEndpoint: URL;
  apiKey?: string;
  fetchImpl: typeof fetch;
}

export interface ExecuteServiceFetchOptions {
  request: SerializedServiceRequest;
  signal: AbortSignal;
}

export interface ServiceClient {
  execute(
    options: ExecuteServiceFetchOptions,
  ): Promise<ServiceFetchSuccessEnvelope>;
}

export const createServiceClient = ({
  serviceEndpoint,
  apiKey,
  fetchImpl,
}: ServiceClientOptions): ServiceClient => ({
  async execute({ request, signal }) {
    const headers: Record<string, string> = {
      [ACCEPT_HEADER_NAME]: SERVICE_ACCEPT_HEADER_VALUE,
    };

    if (apiKey !== undefined) {
      headers[AUTHORIZATION_HEADER_NAME] =
        `${AUTHORIZATION_BEARER_PREFIX}${apiKey}`;
    }

    const body = createServiceRequestBody(request);

    if (request.contentType !== undefined) {
      headers[CONTENT_TYPE_HEADER_NAME] = request.contentType;
    } else if (request.transport === SERVICE_REQUEST_TRANSPORT_JSON) {
      headers[CONTENT_TYPE_HEADER_NAME] = JSON_CONTENT_TYPE;
    }

    const serviceRequestInit: RequestInit & {
      duplex?: 'half';
    } = {
      method: SERVICE_HTTP_METHOD,
      headers,
      body,
      signal,
    };

    if (body instanceof ReadableStream) {
      serviceRequestInit.duplex = 'half';
    }

    const response = await fetchImpl(serviceEndpoint, serviceRequestInit);

    if (!response.ok) {
      throw new ProxyFetchServiceError(
        `Proxy fetch service returned HTTP ${response.status}.`,
        {
          code: SERVICE_HTTP_ERROR_CODE,
          retryable: false,
          details: {
            status: response.status,
            statusText: response.statusText,
          },
        },
      );
    }

    const parsedEnvelope = await parseServiceResponse(response);

    if (!parsedEnvelope.ok) {
      throw new ProxyFetchServiceError(parsedEnvelope.error.message, {
        code: parsedEnvelope.error.code,
        retryable: parsedEnvelope.error.retryable,
        details: parsedEnvelope.error.details,
      });
    }

    return parsedEnvelope;
  },
});

const createServiceRequestBody = (
  request: SerializedServiceRequest,
): BodyInit => {
  if (request.body !== undefined) {
    return request.body;
  }
  if (request.transport === SERVICE_REQUEST_TRANSPORT_JSON) {
    return JSON.stringify(request.envelope);
  }

  const formData = new FormData();

  formData.set(METADATA_PART_NAME, JSON.stringify(request.envelope));
  formData.set(
    BINARY_BODY_PART_NAME,
    request.bodyPart ?? new Blob(),
    BINARY_BODY_PART_NAME,
  );

  return formData;
};
const parseServiceResponse = async (response: Response) => {
  const contentType = response.headers.get(CONTENT_TYPE_HEADER_NAME);

  if (
    contentType?.toLowerCase().startsWith(MULTIPART_CONTENT_TYPE_PREFIX)
    === true
  ) {
    return parseMultipartServiceResponse(response);
  }

  return parseJsonServiceResponse(response);
};
const parseJsonServiceResponse = async (response: Response) => {
  let parsedJson: unknown;

  try {
    parsedJson = await response.json();
  } catch (cause) {
    throw new InvalidServiceResponseError(
      'Proxy fetch service response is not valid JSON.',
      {
        code: INVALID_SERVICE_RESPONSE_CODE,
        retryable: false,
        cause,
      },
    );
  }

  return parseServiceFetchResponseEnvelope(parsedJson);
};
const parseMultipartServiceResponse = async (response: Response) => {
  const contentType = response.headers.get(CONTENT_TYPE_HEADER_NAME);

  if (response.body === null || contentType === null) {
    throw new InvalidServiceResponseError(
      'Proxy fetch service response is not valid multipart form data.',
      {
        code: INVALID_SERVICE_RESPONSE_CODE,
        retryable: false,
      },
    );
  }

  const boundary = readMultipartBoundary(contentType);
  const reader = response.body.getReader();
  const { metadataText, initialBody } = await readMultipartMetadataAndBodyStart(
    reader,
    boundary,
  );
  const parsedMetadata = parseMultipartMetadata(metadataText);
  const parsedEnvelope = parseServiceFetchResponseEnvelope(parsedMetadata);

  if (
    !parsedEnvelope.ok
    || parsedEnvelope.response.body?.kind !== BODY_KIND_BINARY
  ) {
    return parsedEnvelope;
  }

  return {
    ...parsedEnvelope,
    response: {
      ...parsedEnvelope.response,
      bodyPart: createMultipartBodyStream(reader, initialBody, boundary),
    },
  };
};
const parseMultipartMetadata = (metadataText: string): unknown => {
  try {
    return JSON.parse(metadataText);
  } catch (cause) {
    throw new InvalidServiceResponseError(
      'Proxy fetch service multipart response metadata part is not valid JSON.',
      {
        code: INVALID_SERVICE_RESPONSE_CODE,
        retryable: false,
        cause,
      },
    );
  }
};
const readMultipartMetadataAndBodyStart = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  boundary: string,
): Promise<{
  metadataText: string;
  initialBody: Buffer;
}> => {
  const boundaryMarker = Buffer.from(`--${boundary}`);
  const partBoundaryMarker = Buffer.from(`${CRLF}--${boundary}`);
  let buffer = Buffer.alloc(0);

  while (true) {
    const parsed = parseMultipartMetadataAndBodyStart(
      buffer,
      boundaryMarker,
      partBoundaryMarker,
    );

    if (parsed !== undefined) {
      return parsed;
    }

    const { done, value } = await reader.read();

    if (done) {
      throw new InvalidServiceResponseError(
        'Proxy fetch service multipart response body part is missing.',
        {
          code: INVALID_SERVICE_RESPONSE_CODE,
          retryable: false,
        },
      );
    }

    buffer = Buffer.concat([buffer, Buffer.from(value)]);
  }
};
const parseMultipartMetadataAndBodyStart = (
  buffer: Buffer,
  boundaryMarker: Buffer,
  partBoundaryMarker: Buffer,
):
  | {
      metadataText: string;
      initialBody: Buffer;
    }
  | undefined => {
  const boundaryStart = buffer.indexOf(boundaryMarker);

  if (boundaryStart === -1) {
    return undefined;
  }

  const metadataHeadersStart =
    boundaryStart + boundaryMarker.byteLength + CRLF.length;
  const metadataHeadersEnd = buffer.indexOf(
    Buffer.from(`${CRLF}${CRLF}`),
    metadataHeadersStart,
  );

  if (metadataHeadersEnd === -1) {
    return undefined;
  }

  const metadataHeaders = parseMultipartHeaders(
    buffer.subarray(metadataHeadersStart, metadataHeadersEnd).toString('utf8'),
  );
  const metadataPartName = readContentDispositionParameter(
    metadataHeaders.get('content-disposition') ?? '',
    'name',
  );

  if (metadataPartName !== METADATA_PART_NAME) {
    throw new InvalidServiceResponseError(
      'Proxy fetch service multipart response metadata part is missing.',
      {
        code: INVALID_SERVICE_RESPONSE_CODE,
        retryable: false,
      },
    );
  }

  const metadataBodyStart = metadataHeadersEnd + `${CRLF}${CRLF}`.length;
  const bodyPartBoundaryStart = buffer.indexOf(
    partBoundaryMarker,
    metadataBodyStart,
  );

  if (bodyPartBoundaryStart === -1) {
    return undefined;
  }

  const metadataText = buffer
    .subarray(metadataBodyStart, bodyPartBoundaryStart)
    .toString('utf8');
  const afterBodyPartBoundary =
    bodyPartBoundaryStart + partBoundaryMarker.byteLength;

  if (
    buffer
      .subarray(afterBodyPartBoundary, afterBodyPartBoundary + 2)
      .equals(Buffer.from('--'))
  ) {
    throw new InvalidServiceResponseError(
      'Proxy fetch service multipart response body part is missing.',
      {
        code: INVALID_SERVICE_RESPONSE_CODE,
        retryable: false,
      },
    );
  }

  const bodyHeadersStart = afterBodyPartBoundary + CRLF.length;
  const bodyHeadersEnd = buffer.indexOf(
    Buffer.from(`${CRLF}${CRLF}`),
    bodyHeadersStart,
  );

  if (bodyHeadersEnd === -1) {
    return undefined;
  }

  const initialBodyStart = bodyHeadersEnd + `${CRLF}${CRLF}`.length;

  return {
    metadataText,
    initialBody: buffer.subarray(initialBodyStart),
  };
};
const createMultipartBodyStream = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  initialBody: Buffer,
  boundary: string,
): ReadableStream<Uint8Array> => {
  const terminalMarker = Buffer.from(`${CRLF}--${boundary}--`);

  return new ReadableStream({
    start(controller) {
      const closeIfTerminalMarkerFound = (buffer: Buffer): boolean => {
        const terminalMarkerIndex = findTerminalMarkerIndex(
          buffer,
          terminalMarker,
        );

        if (terminalMarkerIndex === -1) {
          return false;
        }

        enqueueBuffer(controller, buffer.subarray(0, terminalMarkerIndex));
        controller.close();
        void reader.cancel().catch(() => undefined);

        return true;
      };

      if (closeIfTerminalMarkerFound(initialBody)) {
        return;
      }

      enqueueBuffer(controller, initialBody);

      void (async () => {
        let pending = Buffer.alloc(0);

        try {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              enqueueBuffer(controller, pending);
              controller.close();

              return;
            }

            pending = Buffer.concat([pending, Buffer.from(value)]);

            const terminalMarkerIndex = findTerminalMarkerIndex(
              pending,
              terminalMarker,
            );

            if (terminalMarkerIndex !== -1) {
              enqueueBuffer(
                controller,
                pending.subarray(0, terminalMarkerIndex),
              );
              controller.close();

              return;
            }
            if (pending.byteLength > MULTIPART_PARSER_LOOKBEHIND_BYTES) {
              const flushBytes =
                pending.byteLength - MULTIPART_PARSER_LOOKBEHIND_BYTES;

              enqueueBuffer(controller, pending.subarray(0, flushBytes));
              pending = pending.subarray(flushBytes);
            }
          }
        } catch (error) {
          controller.error(error);
        }
      })();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
};
const findTerminalMarkerIndex = (
  buffer: Buffer,
  terminalMarker: Buffer,
): number => {
  let searchFrom = 0;

  while (true) {
    const markerIndex = buffer.indexOf(terminalMarker, searchFrom);

    if (markerIndex === -1) {
      return -1;
    }

    const afterMarker = markerIndex + terminalMarker.byteLength;
    const markerEndsBuffer = afterMarker === buffer.byteLength;
    const markerLineEnd = afterMarker + CRLF.length;
    const markerEndsLine =
      markerLineEnd === buffer.byteLength
      && buffer.subarray(afterMarker, markerLineEnd).equals(Buffer.from(CRLF));

    if (markerEndsBuffer || markerEndsLine) {
      return markerIndex;
    }

    searchFrom = markerIndex + 1;
  }
};
const enqueueBuffer = (
  controller: ReadableStreamDefaultController<Uint8Array>,
  buffer: Buffer,
): void => {
  if (buffer.byteLength === 0) {
    return;
  }

  controller.enqueue(new Uint8Array(buffer));
};
const parseMultipartHeaders = (headerText: string): Headers => {
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

  return headers;
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
    throw new InvalidServiceResponseError(
      'Proxy fetch service multipart response boundary is missing.',
      {
        code: INVALID_SERVICE_RESPONSE_CODE,
        retryable: false,
      },
    );
  }

  return boundary;
};
