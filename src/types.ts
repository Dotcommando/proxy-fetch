export type ProxyFetchInput = RequestInfo | URL;

export type ProxyFetch = (
  input: ProxyFetchInput,
  init?: ProxyFetchInit,
) => Promise<Response>;

export type ProxyFetchConsistency =
  | 'default'
  | 'same-session'
  | 'new-session'
  | 'stateless'
  | (string & {});

export interface ProxyFetchContext {
  useCase?: string;
  flowKey?: string;
  consistency?: ProxyFetchConsistency;
  metadata?: Record<string, unknown>;
}

export type BinaryBodyTransport = 'multipart' | 'json-base64';

export interface ProxyFetchOptions {
  serviceUrl?: string | URL;
  apiKey?: string;
  binaryBodyTransport?: BinaryBodyTransport;
  defaultContext?: ProxyFetchContext;
  defaultHeaders?: HeadersInit;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ProxyFetchInit extends RequestInit {
  context?: ProxyFetchContext;
  timeoutMs?: number;
}
