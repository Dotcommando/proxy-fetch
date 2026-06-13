import {
  BODY_KIND_BASE64,
  BODY_KIND_BINARY,
  BODY_KIND_TEXT,
  WIRE_PROTOCOL_VERSION,
} from '../constants';
import type { ProxyFetchContext } from '../types';

export type HeaderPair = [name: string, value: string];

export type ResponseEnvelopeType =
  | 'basic'
  | 'cors'
  | 'default'
  | 'error'
  | 'opaque'
  | 'opaqueredirect';

export interface TextBodyEnvelope {
  kind: typeof BODY_KIND_TEXT;
  text: string;
}

export interface BinaryBodyEnvelope {
  kind: typeof BODY_KIND_BINARY;
  partName: string;
}

export interface Base64BodyEnvelope {
  kind: typeof BODY_KIND_BASE64;
  data: string;
}

export type ServiceBodyEnvelope =
  | TextBodyEnvelope
  | BinaryBodyEnvelope
  | Base64BodyEnvelope
  | null;

export interface ServiceFetchRequestEnvelope {
  version: typeof WIRE_PROTOCOL_VERSION;
  request: {
    url: string;
    method: string;
    headers: HeaderPair[];
    body: ServiceBodyEnvelope;
    mode?: RequestMode;
    credentials?: RequestCredentials;
    cache?: RequestCache;
    redirect?: RequestRedirect;
    referrer?: string;
    referrerPolicy?: ReferrerPolicy;
    integrity?: string;
    keepalive?: boolean;
    duplex?: 'half';
  };
  options: {
    timeoutMs: number;
  };
  context: ProxyFetchContext;
}

export interface ServiceFetchSuccessEnvelope {
  version: typeof WIRE_PROTOCOL_VERSION;
  ok: true;
  response: {
    url: string;
    status: number;
    statusText: string;
    headers: HeaderPair[];
    body: ServiceBodyEnvelope;
    bodyPart?: BodyInit;
    redirected?: boolean;
    type?: ResponseEnvelopeType;
  };
}

export interface ServiceFetchFailureEnvelope {
  version: typeof WIRE_PROTOCOL_VERSION;
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
}

export type ServiceFetchResponseEnvelope =
  | ServiceFetchSuccessEnvelope
  | ServiceFetchFailureEnvelope;
