import {
  BODY_KIND_BASE64,
  BODY_KIND_BINARY,
  BODY_KIND_TEXT,
  HEADER_PAIR_LENGTH,
  INVALID_SERVICE_RESPONSE_CODE,
  WIRE_PROTOCOL_VERSION,
} from '../constants';
import { InvalidServiceResponseError } from '../errors';
import type {
  HeaderPair,
  ResponseEnvelopeType,
  ServiceBodyEnvelope,
  ServiceFetchResponseEnvelope,
  ServiceFetchSuccessEnvelope,
} from '../service/contract';

const RESPONSE_TYPES: ReadonlySet<string> = new Set([
  'basic',
  'cors',
  'default',
  'error',
  'opaque',
  'opaqueredirect',
]);
const isResponseEnvelopeType = (value: string): value is ResponseEnvelopeType =>
  RESPONSE_TYPES.has(value);
const invalidEnvelope = (message: string): InvalidServiceResponseError =>
  new InvalidServiceResponseError(message, {
    code: INVALID_SERVICE_RESPONSE_CODE,
    retryable: false,
  });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const readString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];

  if (typeof value !== 'string') {
    throw invalidEnvelope(`Service response field "${key}" must be a string.`);
  }

  return value;
};
const readNumber = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];

  if (typeof value !== 'number') {
    throw invalidEnvelope(`Service response field "${key}" must be a number.`);
  }

  return value;
};
const readBoolean = (record: Record<string, unknown>, key: string): boolean => {
  const value = record[key];

  if (typeof value !== 'boolean') {
    throw invalidEnvelope(`Service response field "${key}" must be a boolean.`);
  }

  return value;
};
const readOptionalBoolean = (
  record: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw invalidEnvelope(`Service response field "${key}" must be a boolean.`);
  }

  return value;
};
const readOptionalResponseType = (
  record: Record<string, unknown>,
): ResponseEnvelopeType | undefined => {
  const value = record.type;

  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !isResponseEnvelopeType(value)) {
    throw invalidEnvelope('Service response field "type" is unsupported.');
  }

  return value;
};
const validateSpecialResponseShape = (
  response: ServiceFetchSuccessEnvelope['response'],
): void => {
  if (
    response.type !== 'error'
    && response.type !== 'opaque'
    && response.type !== 'opaqueredirect'
  ) {
    return;
  }
  if (
    response.status !== 0
    || response.statusText !== ''
    || response.body !== null
    || response.headers.length > 0
  ) {
    throw invalidEnvelope(
      'Service response special type has an invalid shape.',
    );
  }
};
const readRecord = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const value = record[key];

  if (!isRecord(value)) {
    throw invalidEnvelope(`Service response field "${key}" must be an object.`);
  }

  return value;
};
const parseHeaderPairs = (value: unknown): HeaderPair[] => {
  if (!Array.isArray(value)) {
    throw invalidEnvelope('Service response headers must be an array.');
  }

  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== HEADER_PAIR_LENGTH) {
      throw invalidEnvelope(
        'Service response header entries must be name/value pairs.',
      );
    }

    const [name, headerValue] = entry;

    if (typeof name !== 'string' || typeof headerValue !== 'string') {
      throw invalidEnvelope(
        'Service response header names and values must be strings.',
      );
    }

    return [name, headerValue];
  });
};
const parseBody = (value: unknown): ServiceBodyEnvelope => {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw invalidEnvelope('Service response body must be an object or null.');
  }

  const kind = readString(value, 'kind');

  if (kind === BODY_KIND_TEXT) {
    return {
      kind: BODY_KIND_TEXT,
      text: readString(value, 'text'),
    };
  }
  if (kind === BODY_KIND_BINARY) {
    return {
      kind: BODY_KIND_BINARY,
      partName: readString(value, 'partName'),
    };
  }
  if (kind === BODY_KIND_BASE64) {
    return {
      kind: BODY_KIND_BASE64,
      data: readString(value, 'data'),
    };
  }

  throw invalidEnvelope('Service response body kind is unsupported.');
};

export const parseServiceFetchResponseEnvelope = (
  value: unknown,
): ServiceFetchResponseEnvelope => {
  if (!isRecord(value)) {
    throw invalidEnvelope('Service response envelope must be an object.');
  }

  const version = readString(value, 'version');

  if (version !== WIRE_PROTOCOL_VERSION) {
    throw invalidEnvelope('Service response version is unsupported.');
  }

  const ok = readBoolean(value, 'ok');

  if (!ok) {
    const error = readRecord(value, 'error');
    const details = error.details;
    const parsedError = {
      code: readString(error, 'code'),
      message: readString(error, 'message'),
      retryable: readBoolean(error, 'retryable'),
    };

    if (details !== undefined) {
      return {
        version: WIRE_PROTOCOL_VERSION,
        ok: false,
        error: {
          ...parsedError,
          details,
        },
      };
    }

    return {
      version: WIRE_PROTOCOL_VERSION,
      ok: false,
      error: parsedError,
    };
  }

  const response = readRecord(value, 'response');
  const responseEnvelope: ServiceFetchSuccessEnvelope = {
    version: WIRE_PROTOCOL_VERSION,
    ok: true,
    response: {
      url: readString(response, 'url'),
      status: readNumber(response, 'status'),
      statusText: readString(response, 'statusText'),
      headers: parseHeaderPairs(response.headers),
      body: parseBody(response.body),
    },
  };
  const redirected = readOptionalBoolean(response, 'redirected');
  const type = readOptionalResponseType(response);

  if (redirected !== undefined) {
    responseEnvelope.response.redirected = redirected;
  }
  if (type !== undefined) {
    responseEnvelope.response.type = type;
  }

  validateSpecialResponseShape(responseEnvelope.response);

  return responseEnvelope;
};
