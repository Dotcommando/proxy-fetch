import {
  BODY_KIND_BASE64,
  BODY_KIND_BINARY,
  BODY_KIND_TEXT,
} from '../constants';
import type { ServiceFetchSuccessEnvelope } from '../service/contract';

const SPECIAL_RESPONSE_TYPES = new Set(['error', 'opaque', 'opaqueredirect']);
const NULL_BODY_STATUS_CODES = new Set([204, 205, 304]);
const responseMetadata = new WeakMap<Response, ResponseMetadata>();
const responseHeaders = new WeakMap<Response, Headers>();
const nativeResponseHeadersGetter = Object.getOwnPropertyDescriptor(
  Response.prototype,
  'headers',
)?.get;

interface ResponseMetadata {
  redirected: boolean;
  status: number;
  statusText: string;
  type: ResponseType;
  url: string;
}

class ProxyFetchResponse extends Response {
  override get headers(): Headers {
    return responseHeaders.get(this) ?? super.headers;
  }

  override get ok(): boolean {
    const status = this.status;

    return status >= 200 && status <= 299;
  }

  override get redirected(): boolean {
    return responseMetadata.get(this)?.redirected ?? super.redirected;
  }

  override get status(): number {
    return responseMetadata.get(this)?.status ?? super.status;
  }

  override get statusText(): string {
    return responseMetadata.get(this)?.statusText ?? super.statusText;
  }

  override get type(): ResponseType {
    return responseMetadata.get(this)?.type ?? super.type;
  }

  override get url(): string {
    return responseMetadata.get(this)?.url ?? super.url;
  }

  override clone(): Response {
    const cloned = super.clone();
    const metadata = responseMetadata.get(this);

    if (metadata === undefined) {
      return cloned;
    }

    return wrapResponse(cloned, metadata);
  }
}

export const createResponse = (
  envelope: ServiceFetchSuccessEnvelope,
): Response => {
  const body = NULL_BODY_STATUS_CODES.has(envelope.response.status)
    ? null
    : createResponseBody(envelope);
  const response =
    envelope.response.status === 0
    || SPECIAL_RESPONSE_TYPES.has(envelope.response.type ?? '')
      ? Response.error()
      : new Response(body, {
          status: envelope.response.status,
          statusText: envelope.response.statusText,
          headers: new Headers(envelope.response.headers),
        });

  return wrapResponse(response, {
    redirected: envelope.response.redirected ?? response.redirected,
    status: envelope.response.status,
    statusText: envelope.response.statusText,
    type: envelope.response.type ?? response.type,
    url: envelope.response.url,
  });
};

const createResponseBody = (
  envelope: ServiceFetchSuccessEnvelope,
): BodyInit | null => {
  const body = envelope.response.body;

  if (body === null) {
    return null;
  }
  if (body.kind === BODY_KIND_TEXT) {
    return body.text;
  }
  if (body.kind === BODY_KIND_BASE64) {
    return Uint8Array.from(Buffer.from(body.data, BODY_KIND_BASE64));
  }
  if (
    body.kind === BODY_KIND_BINARY
    && envelope.response.bodyPart !== undefined
  ) {
    return envelope.response.bodyPart;
  }

  return null;
};
const createImmutableHeaders = (headers: Headers): Headers =>
  new Proxy(headers, {
    get(target, property, receiver) {
      if (
        property === 'append'
        || property === 'delete'
        || property === 'set'
      ) {
        return (): never => {
          throw new TypeError('immutable');
        };
      }

      const value = Reflect.get(target, property, receiver);

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
const wrapResponse = (
  response: Response,
  metadata: ResponseMetadata,
): Response => {
  const headers = nativeResponseHeadersGetter?.call(response);

  Object.setPrototypeOf(response, ProxyFetchResponse.prototype);
  responseMetadata.set(response, metadata);

  if (headers !== undefined) {
    responseHeaders.set(response, createImmutableHeaders(headers));
  }

  return response;
};
