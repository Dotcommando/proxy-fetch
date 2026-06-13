# @echospecter/proxy-fetch

Fetch-compatible client for calling third-party HTTP APIs through your own proxy-fetch microservice.

The main use case is replacing direct application calls like:

```ts
await fetch('https://api.vendor.example/v1/chat/completions', init);
```

with:

```ts
await proxyFetch('https://api.vendor.example/v1/chat/completions', init);
```

Your application keeps a familiar Fetch API surface, while the actual target request is executed by an external microservice. That microservice can run in the right network, use proxy pools, apply routing policy, keep target-side credentials isolated, enforce vendor-specific limits, or add observability.

This package is only the client. It does not run proxies and does not contain production orchestration logic. It serializes a Fetch request, sends it to a configured proxy-fetch service, and reconstructs the service result as a native `Response`.

## Status

`0.1.x` is the first public line. The package aims to be highly compatible with Node.js Fetch for ordinary API calls, but it is not a byte-for-byte replacement for every transport-level behavior of local `fetch`.

The unavoidable boundary is remote execution: native `fetch()` executes the target request inside the current Node.js process; `proxyFetch()` asks a microservice to execute that request and then rebuilds the response locally.

## Requirements

- Node.js 20+.
- Native Fetch API support.
- A compatible proxy-fetch microservice that implements the wire contract below.

## Installation

```sh
npm install @echospecter/proxy-fetch
```

## Environment

```env
PROXY_FETCH_SERVICE_URL=https://proxy-fetch-service.example/fetch
PROXY_FETCH_DEFAULT_TIMEOUT_MS=360000
PROXY_FETCH_SERVICE_API_KEY=
```

`PROXY_FETCH_SERVICE_URL` is required unless `serviceUrl` is passed directly.

`PROXY_FETCH_DEFAULT_TIMEOUT_MS` is optional. The built-in default is `360000` milliseconds, which is 6 minutes. This default is intentionally suitable for LLM-oriented and slow third-party API calls.

## Basic Usage

```ts
import { createProxyFetch } from '@echospecter/proxy-fetch';

const proxyFetch = createProxyFetch({
  apiKey: process.env.PROXY_FETCH_SERVICE_API_KEY,
});

const response = await proxyFetch('https://api.example.com/data.json');

if (!response.ok) {
  throw new Error(`API returned ${response.status}`);
}

const data = await response.json();
```

With explicit service URL:

```ts
const proxyFetch = createProxyFetch({
  serviceUrl: 'https://proxy-fetch-service.example/fetch',
  timeoutMs: 360000,
});
```

With default target headers and request context:

```ts
const proxyFetch = createProxyFetch({
  serviceUrl: 'https://proxy-fetch-service.example/fetch',
  defaultHeaders: {
    'user-agent': 'my-app/1.0',
  },
  defaultContext: {
    useCase: 'llm-provider-api',
    consistency: 'same-session',
    metadata: {
      tenant: 'acme',
    },
  },
});

const response = await proxyFetch('https://api.vendor.example/v1/models', {
  headers: {
    authorization: `Bearer ${process.env.VENDOR_API_KEY}`,
  },
  context: {
    flowKey: 'conversation-123',
  },
});
```

Request headers override `defaultHeaders`. Request context overrides matching `defaultContext` fields and merges `metadata`.

## Service Endpoint

The package sends service requests directly to:

```txt
POST {PROXY_FETCH_SERVICE_URL}
```

`PROXY_FETCH_SERVICE_URL` is the full service endpoint URL. No path is appended automatically.

Examples:

```txt
https://proxy.example/fetch        -> https://proxy.example/fetch
https://proxy.example/api/proxy    -> https://proxy.example/api/proxy
```

Service transport headers are separate from target request headers:

```txt
Accept: application/json, multipart/form-data
Content-Type: application/json
Authorization: Bearer <apiKey>
```

For multipart requests, `Content-Type` includes a generated multipart boundary.

## Timeout And Abort Behavior

`timeoutMs` is enforced in two places.

First, it is serialized into the service request envelope:

```json
{
  "options": {
    "timeoutMs": 360000
  }
}
```

Second, it is enforced locally by this package with an `AbortController`. If the HTTP request to the proxy-fetch microservice hangs longer than `timeoutMs`, the local request is aborted with a `TimeoutError`.

This is intentional. For slow API and LLM workloads, it is not enough to only tell the microservice about the timeout; the client process also needs a local upper bound so a stuck microservice connection does not hang indefinitely.

The effective timeout order is:

1. `proxyFetch(input, { timeoutMs })`
2. `createProxyFetch({ timeoutMs })`
3. `PROXY_FETCH_DEFAULT_TIMEOUT_MS`
4. `DEFAULT_TIMEOUT_MS`

User-provided `AbortSignal` is respected. If the caller aborts the request, the local microservice request is aborted too, and custom abort reasons are preserved where Node.js Fetch preserves them.

The local `AbortController` only controls the client-to-microservice request. The microservice must use the serialized `timeoutMs` and its own cancellation logic to stop an already-started target request.

## Node.js Fetch Compatibility

`proxyFetch(input, init)` accepts ordinary Fetch API inputs and returns a native `Response`.

Covered request bodies include:

- no body;
- string;
- `URLSearchParams`;
- `Blob`;
- `ArrayBuffer`;
- typed arrays;
- `FormData`;
- `ReadableStream` with `duplex: 'half'`;
- existing `Request` objects.

The package serializes non-default request metadata that matters to remote execution:

- `mode`;
- `credentials`;
- `cache`;
- `redirect`;
- `referrer`;
- `referrerPolicy`;
- `integrity`;
- `keepalive`;
- `duplex`.

The compatible microservice is responsible for enforcing this metadata when it executes the target request. The included mock orchestrator used by e2e tests does this with native Node.js `fetch`.

Node.js-specific `dispatcher` is intentionally not supported. Passing a non-`undefined` `dispatcher` option throws a `TypeError`, because the target request is executed by the microservice and cannot use a local Undici dispatcher.

## Known Boundaries

These are design boundaries, not ordinary bugs:

- Target networking happens in the microservice, not in the local process.
- Local Undici `dispatcher` cannot affect target execution.
- The microservice must enforce redirect, integrity, referrer, cache, credentials, mode, timeout, and target-side cancellation.
- Response `url`, `redirected`, `type`, status, status text, headers, and body are reconstructed from the service envelope.
- Special Fetch response states such as `error`, `opaque`, and `opaqueredirect` must be represented by the documented service envelope shape.
- Binary bodies should use multipart transport by default. JSON Base64 is available as an explicit fallback.

## Request Contract

No-body and text requests are sent as JSON.

```json
{
  "version": "proxy-fetch.v1",
  "request": {
    "url": "https://api.example.com",
    "method": "GET",
    "headers": [],
    "body": null
  },
  "options": {
    "timeoutMs": 360000
  },
  "context": {}
}
```

Text body:

```json
{
  "version": "proxy-fetch.v1",
  "request": {
    "url": "https://api.example.com/v1/messages",
    "method": "POST",
    "headers": [["content-type", "application/json"]],
    "body": {
      "kind": "text",
      "text": "{\"prompt\":\"Summarize this\"}"
    }
  },
  "options": {
    "timeoutMs": 360000
  },
  "context": {}
}
```

When non-default Fetch request metadata is present, the envelope may also include these fields inside `request`:

```json
{
  "request": {
    "mode": "no-cors",
    "credentials": "include",
    "cache": "no-store",
    "redirect": "manual",
    "referrer": "https://referrer.example/path",
    "referrerPolicy": "no-referrer",
    "integrity": "sha256-abc",
    "keepalive": true,
    "duplex": "half"
  }
}
```

Default Fetch metadata is omitted to keep envelopes small and backwards-compatible.

Binary bodies are sent as `multipart/form-data` by default:

```txt
part "meta": JSON request envelope
part "body": raw target request bytes
```

The `meta` body reference:

```json
{
  "body": {
    "kind": "binary",
    "partName": "body"
  }
}
```

JSON Base64 fallback is available explicitly:

```ts
const proxyFetch = createProxyFetch({
  binaryBodyTransport: 'json-base64',
});
```

Fallback body format:

```json
{
  "kind": "base64",
  "data": "AAECAw=="
}
```

`kind: "text"` always means text semantics. Arbitrary binary bytes must use `kind: "binary"` or `kind: "base64"`.

## Response Contract

Successful service execution returns `ok: true`, even when the target server returns `404`, `403`, or `500`.

```json
{
  "version": "proxy-fetch.v1",
  "ok": true,
  "response": {
    "url": "https://api.example.com/data.json",
    "status": 200,
    "statusText": "OK",
    "redirected": false,
    "type": "basic",
    "headers": [["content-type", "application/json"]],
    "body": {
      "kind": "text",
      "text": "{\"ok\":true}"
    }
  }
}
```

`url`, `redirected`, and `type` are used to restore the corresponding native `Response` properties in Node.js.

Binary responses may be returned as multipart:

```txt
part "meta": JSON response envelope
part "body": raw target response bytes
```

For multipart binary responses, the package parses the metadata part first and exposes the response body as a native `ReadableStream` backed by the remaining multipart body part.

The `meta` body reference:

```json
{
  "body": {
    "kind": "binary",
    "partName": "body"
  }
}
```

JSON Base64 response fallback is also supported:

```json
{
  "kind": "base64",
  "data": "AAECAw=="
}
```

Null-body response statuses `204`, `205`, and `304` expose native null-body semantics. If the service envelope includes a body for one of these statuses, the local `Response` body is ignored.

Special response envelopes must use the documented shape. For `type: "error"`, `type: "opaque"`, or `type: "opaqueredirect"`, the response must have `status: 0`, empty `statusText`, no headers, and `body: null`. Impossible combinations are rejected as invalid service responses.

## Error Contract

Service-level failures use `ok: false`:

```json
{
  "version": "proxy-fetch.v1",
  "ok": false,
  "error": {
    "code": "REQUEST_TIMEOUT",
    "message": "Request timed out.",
    "retryable": true,
    "details": {}
  }
}
```

Target HTTP errors are not service errors. A target `404` is returned as a normal native `Response` with `response.status === 404`.

Service HTTP errors reject with `ProxyFetchServiceError` and code `SERVICE_HTTP_ERROR`.

Invalid service envelopes reject with `InvalidServiceResponseError` and code `INVALID_SERVICE_RESPONSE`.

Target network failures reported by the service as `ok: false` reject with `ProxyFetchServiceError` using the service-provided error code, for example `UPSTREAM_FETCH_ERROR`.

## Testing

Run the ordinary test suite:

```sh
npm test
```

Run deterministic e2e tests through the mock orchestrator:

```sh
npm run test:e2e
```

Run optional live smoke tests against public APIs through the mock orchestrator:

```sh
npm run test:e2e:live
```

Live tests depend on public endpoints and network availability. They are useful before a release, but deterministic local tests are the compatibility source of truth.

## Mock Orchestrator

`mock-orchestrator.ts` is a development and test utility. It compiles separately with:

```sh
npm run build:mock-orchestrator
```

It is not included in the published package bundle. Production users should run their own compatible proxy-fetch microservice.

## License

MIT
