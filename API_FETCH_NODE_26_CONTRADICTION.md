# Technical Specification: Node.js 26 Fetch API Compatibility Tests

## Goal

Create a dedicated compatibility test suite for `@echospecter/proxy-fetch`.

The goal is to make `proxyFetch()` as close as possible to Node.js 26 native `fetch()` from the consumer application's point of view.

The tests must detect all observable differences between:

```ts
await fetch(input, init);
```

and:

```ts
await proxyFetch(input, init);
```

where `proxyFetch()` sends the request to a proxy-fetch microservice and reconstructs a native `Response`.

The test suite must focus on Node.js 26 Fetch API behavior, not browser-only behavior.

## Test Suite Name

Create a dedicated Jest test file:

```txt
tests/node26-fetch-perfect-compat.test.cjs
```

If the file becomes too large, split it into:

```txt
tests/node26-response-compat.test.cjs
tests/node26-request-stream-compat.test.cjs
tests/node26-headers-compat.test.cjs
tests/node26-abort-compat.test.cjs
tests/node26-special-response-compat.test.cjs
```

## General Test Strategy

Every test that can be compared directly must follow this structure:

```js
const nativeResult = await fetch(input, init);
const proxyResult = await proxyFetch(input, init);

compareNativeAndProxy(nativeResult, proxyResult);
```

Where exact equality is impossible because of the remote execution boundary, the test must assert one of two things:

1. `proxyFetch()` matches native Fetch behavior.
2. `proxyFetch()` explicitly rejects unsupported behavior with a documented error instead of silently doing the wrong thing.

Silent approximation must be treated as a failure.

## Required Local Test Infrastructure

Create local HTTP target servers for compatibility tests.

Do not rely only on public APIs. Public APIs are useful for live smoke tests, but exact Node.js Fetch compatibility must be tested against local deterministic servers.

Required local servers:

1. `targetServer`: receives actual target requests and returns controlled responses.
2. `mockOrchestrator`: receives proxy-fetch service envelopes and executes target requests.
3. `manualEnvelopeService`: returns crafted service envelopes without making target requests.

The test suite must be able to compare:

```txt
native fetch -> targetServer
proxyFetch -> mockOrchestrator -> targetServer
proxyFetch -> manualEnvelopeService
```

## Test Group 1: Text Envelope Must Preserve Real Unicode Text

### Problem

The current response reconstruction may try to detect "binary-like" strings by inspecting character codes. This is dangerous.

A service envelope with:

```json
{
  "kind": "text",
  "text": "ð ñ ÿ"
}
```

must be treated as real text, not as byte string.

### Requirement

`body.kind: "text"` must always mean text semantics.

Binary data must be transported only through:

```json
{ "kind": "binary", "partName": "body" }
```

or:

```json
{ "kind": "base64", "data": "..." }
```

### Test 1.1: UTF-8 text with Latin-1-looking characters

Input service response envelope:

```json
{
  "version": "proxy-fetch.v1",
  "ok": true,
  "response": {
    "url": "https://example.test/unicode",
    "status": 200,
    "statusText": "OK",
    "redirected": false,
    "type": "basic",
    "headers": [["content-type", "text/plain; charset=utf-8"]],
    "body": {
      "kind": "text",
      "text": "ð ñ ÿ"
    }
  }
}
```

Expected behavior:

```js
const response = await proxyFetch('https://example.test/unicode');

expect(await response.text()).toBe('ð ñ ÿ');
```

Also compare bytes against native Response:

```js
const native = new Response('ð ñ ÿ', {
  headers: { 'content-type': 'text/plain; charset=utf-8' },
});

const nativeBytes = new Uint8Array(await native.arrayBuffer());
const proxyBytes = new Uint8Array(await response.clone().arrayBuffer());

expect(Array.from(proxyBytes)).toEqual(Array.from(nativeBytes));
```

### Test 1.2: Emoji and non-Latin text

Use text:

```txt
Привет, κόσμε, こんにちは, 😀
```

Expected:

```js
expect(await response.text()).toBe('Привет, κόσμε, こんにちは, 😀');
```

Expected byte behavior:

```js
proxyResponse.arrayBuffer();
```

must match:

```js
new Response(text).arrayBuffer();
```

### Test 1.3: Binary bytes must not be represented as text

Use bytes:

```js
Uint8Array.from([0xff, 0xfe, 0xfd, 0x00, 0x41]);
```

The test must enforce that these bytes are represented as:

```json
{
  "kind": "base64",
  "data": "//79AEE="
}
```

or as multipart binary body.

Expected:

```js
const bytes = new Uint8Array(await response.arrayBuffer());

expect(Array.from(bytes)).toEqual([0xff, 0xfe, 0xfd, 0x00, 0x41]);
```

Do not use `kind: "text"` to transport byte strings.

### Acceptance Criteria

Remove any heuristic that guesses binary data from text character codes.

`kind: "text"` must always behave like:

```js
new Response(text);
```

`kind: "base64"` and `kind: "binary"` must always behave like byte transport.

## Test Group 2: Response Headers Guard Must Match Native Fetch As Closely As Possible

### Problem

Native fetched responses expose immutable response headers. Calling:

```js
response.headers.set('x-test', '1');
```

throws.

The current implementation uses a `Proxy` wrapper over `Headers`. That may be good enough for ordinary calls but may differ for edge cases such as:

```js
Headers.prototype.set.call(response.headers, 'x-test', '1');
```

### Requirement

The observable behavior of `response.headers` from `proxyFetch()` should match native Node.js 26 `fetch()` as closely as possible.

### Test 2.1: Direct mutation methods throw

For both native and proxy responses:

```js
expect(() => response.headers.set('x-test', '1')).toThrow(TypeError);
expect(() => response.headers.append('x-test', '1')).toThrow(TypeError);
expect(() => response.headers.delete('content-type')).toThrow(TypeError);
```

Compare:

```js
const nativeError = captureError(() => native.headers.set('x-test', '1'));
const proxyError = captureError(() => proxy.headers.set('x-test', '1'));

expect(proxyError.name).toBe(nativeError.name);
```

Do not assert exact error message unless Node.js 26 behavior is stable in the test environment.

### Test 2.2: Prototype method calls throw

For both native and proxy responses:

```js
expect(() =>
  Headers.prototype.set.call(response.headers, 'x-test', '1'),
).toThrow(TypeError);

expect(() =>
  Headers.prototype.append.call(response.headers, 'x-test', '1'),
).toThrow(TypeError);

expect(() =>
  Headers.prototype.delete.call(response.headers, 'content-type'),
).toThrow(TypeError);
```

### Test 2.3: Headers object identity and brand behavior

Compare:

```js
expect(proxyResponse.headers instanceof Headers).toBe(true);
expect(Object.prototype.toString.call(proxyResponse.headers)).toBe(
  Object.prototype.toString.call(nativeResponse.headers),
);
```

If exact brand behavior cannot be achieved because of the `Proxy` wrapper, document the mismatch and decide whether to replace the current approach.

### Test 2.4: Read operations still work

The immutable guard must not break read operations.

```js
expect(proxyResponse.headers.get('content-type')).toBe(
  nativeResponse.headers.get('content-type'),
);

expect(Array.from(proxyResponse.headers.entries())).toEqual(
  Array.from(nativeResponse.headers.entries()),
);
```

### Acceptance Criteria

At minimum:

- direct `set`, `append`, `delete` must throw `TypeError`;
- prototype method calls must throw `TypeError`;
- read methods must work exactly as expected;
- `headers instanceof Headers` must remain true.

If true native immutable guard cannot be reproduced, document the remaining edge case in `API_FETCH_NODE_26_CONTRADICTION.md`.

## Test Group 3: Response Prototype And Constructor Identity

### Problem

The implementation may mutate the response prototype using:

```js
Object.setPrototypeOf(response, ProxyFetchResponse.prototype);
```

This can create observable differences from native `fetch()`.

### Requirement

A `proxyFetch()` response must look like a native Node.js 26 `Response` object as much as possible.

### Test 3.1: Basic identity checks

```js
expect(proxyResponse instanceof Response).toBe(true);
expect(proxyResponse[Symbol.toStringTag]).toBe(
  nativeResponse[Symbol.toStringTag],
);
```

### Test 3.2: Prototype comparison

```js
expect(Object.getPrototypeOf(proxyResponse)).toBe(
  Object.getPrototypeOf(nativeResponse),
);
```

This test defines the ideal target.

If it fails because custom getters are required to override `url`, `type`, `status`, or `redirected`, keep the test skipped or marked as known limitation and document the reason.

### Test 3.3: Constructor comparison

```js
expect(proxyResponse.constructor).toBe(nativeResponse.constructor);
```

Again, this is the ideal target. If impossible with the current implementation, document the limitation.

### Test 3.4: Clone preserves metadata without changing native behavior

For a response with non-default metadata:

```json
{
  "url": "https://example.test/final",
  "status": 200,
  "statusText": "OK",
  "redirected": true,
  "type": "basic"
}
```

Test:

```js
const clone = proxyResponse.clone();

expect(clone.url).toBe(proxyResponse.url);
expect(clone.status).toBe(proxyResponse.status);
expect(clone.statusText).toBe(proxyResponse.statusText);
expect(clone.redirected).toBe(proxyResponse.redirected);
expect(clone.type).toBe(proxyResponse.type);
expect(await clone.text()).toBe(await proxyResponse.text());
```

### Acceptance Criteria

At minimum:

- `instanceof Response` must be true;
- clone must preserve proxy metadata;
- clone must preserve native body behavior;
- any prototype/constructor mismatch must be documented.

## Test Group 4: Streaming Upload Must Preserve Bytes And Timing

### Problem

Streaming upload now uses `ReadableStream.tee()`.

One branch is sent to the service multipart body. Another branch is consumed by a monitor.

This can differ from native Fetch because native `fetch()` consumes one stream, not two.

### Requirement

For `ReadableStream` request bodies with `duplex: 'half'`, `proxyFetch()` must preserve:

- payload bytes;
- abort behavior;
- stream error propagation;
- response timing as close as possible to Node.js 26 native Fetch.

### Test 4.1: Streaming upload byte equality

Create a stream that emits:

```js
['hello', ' ', 'stream'];
```

Native request:

```js
await fetch(targetUrl, {
  method: 'POST',
  body: stream,
  duplex: 'half',
});
```

Proxy request:

```js
await proxyFetch(targetUrl, {
  method: 'POST',
  body: stream,
  duplex: 'half',
});
```

Target server must echo request body bytes.

Expected:

```js
expect(proxyEchoedBody).toBe(nativeEchoedBody);
expect(proxyEchoedBody).toBe('hello stream');
```

### Test 4.2: Streaming upload error propagation

Create a stream that emits one chunk and then errors:

```js
controller.enqueue(encoder.encode('before-error'));
controller.error(new Error('stream failed'));
```

Expected:

- native `fetch()` rejects;
- `proxyFetch()` rejects;
- error name/type does not have to be byte-for-byte identical, but `proxyFetch()` must not resolve successfully;
- target server must not receive a fake complete successful body.

### Test 4.3: Abort while stream upload is in progress

Create a stream that emits chunks slowly.

Abort after the first chunk.

Expected:

- native `fetch()` rejects with abort-related reason;
- `proxyFetch()` rejects with the same abort reason where possible;
- source stream `cancel()` is called;
- service request stream is cancelled;
- no unhandled promise rejection is produced by the monitor branch.

### Test 4.4: Backpressure observation

Create a source stream that records how many times `pull()` is called.

Use a slow target server that reads request body slowly.

Compare native `fetch()` and `proxyFetch()`.

Expected ideal behavior:

```js
proxyPullCount should not be massively higher than nativePullCount
```

This test should not require exact equality. It should detect runaway eager consumption caused by `tee()` or monitor branch.

Suggested assertion:

```js
expect(proxyPullCount).toBeLessThanOrEqual(nativePullCount + 3);
```

If this cannot be satisfied due to service-protocol design, document it as a known limitation.

### Test 4.5: Response timing with early-response server

Create a target server that:

1. receives request headers;
2. immediately sends response headers and a small response body;
3. continues reading request body slowly.

Compare:

```js
const nativeStart = performance.now();
const nativeResponse = await fetch(...streamingBody...);
const nativeResolvedAt = performance.now();

const proxyStart = performance.now();
const proxyResponse = await proxyFetch(...streamingBody...);
const proxyResolvedAt = performance.now();
```

Expected ideal behavior:

`proxyFetch()` should resolve at roughly the same lifecycle point as native Fetch.

If `proxyFetch()` waits for full upload completion because of `await uploadCompletion`, this test will expose the difference.

### Acceptance Criteria

- Streaming upload must not lose bytes.
- Stream errors must not be converted into successful target requests.
- Abort must cancel both upload branches.
- Timing differences must be either fixed or documented.

## Test Group 5: Abort During Body Serialization

### Problem

Some body paths still call:

```js
await request.arrayBuffer();
```

This may not be abort-aware.

### Requirement

If the caller aborts while body serialization is in progress, `proxyFetch()` must stop as early as possible and reject with the abort reason.

### Test 5.1: Already-aborted signal before body serialization

```js
const controller = new AbortController();
const reason = new Error('custom abort reason');

controller.abort(reason);

await expect(
  proxyFetch(url, {
    method: 'POST',
    body: new Blob(['large body']),
    signal: controller.signal,
  }),
).rejects.toBe(reason);
```

Expected:

- service request must not start;
- body serialization must not start.

### Test 5.2: Abort while Blob-like body is being serialized

Use a custom `Blob` or `Request` body that is large enough to observe async behavior.

If Node does not allow slow Blob serialization directly, use a `Request` with a slow stream body and make sure it goes through the path under test.

Expected:

- abort reason is preserved;
- no successful service request is sent after abort;
- no unhandled promise rejection.

### Test 5.3: Timeout while body serialization is in progress

Use `timeoutMs: 10` and a slow request body.

Expected:

```js
await expect(proxyFetch(...)).rejects.toMatchObject({
  name: 'TimeoutError',
});
```

Also assert:

- service request was not completed;
- upload stream was cancelled.

### Acceptance Criteria

- Abort must be checked before and after any potentially long body consumption.
- Slow body serialization must not ignore `AbortSignal`.
- Timeout must be represented as `DOMException` with name `TimeoutError` unless Node.js 26 native behavior suggests another shape for this specific case.

## Test Group 6: Special Response State Validation

### Problem

The service envelope can describe impossible combinations, such as:

```json
{
  "type": "opaque",
  "status": 200
}
```

Native Fetch would not naturally produce some of these states.

### Requirement

The client must not silently create impossible Fetch-like responses unless this is explicitly documented.

### Test 6.1: Valid `Response.error()`-like envelope

Envelope:

```json
{
  "status": 0,
  "statusText": "",
  "type": "error",
  "headers": [],
  "body": null
}
```

Expected:

```js
expect(response.type).toBe('error');
expect(response.status).toBe(0);
expect(response.ok).toBe(false);
```

### Test 6.2: Invalid `error` response with status 200

Envelope:

```json
{
  "status": 200,
  "statusText": "OK",
  "type": "error",
  "headers": [["content-type", "text/plain"]],
  "body": { "kind": "text", "text": "impossible" }
}
```

Expected preferred behavior:

```js
await expect(proxyFetch(...)).rejects.toThrow(InvalidServiceResponseError);
```

### Test 6.3: Invalid `opaque` response with visible body

Envelope:

```json
{
  "status": 200,
  "statusText": "OK",
  "type": "opaque",
  "headers": [["content-type", "text/plain"]],
  "body": { "kind": "text", "text": "visible body" }
}
```

Expected preferred behavior:

```js
await expect(proxyFetch(...)).rejects.toThrow(InvalidServiceResponseError);
```

### Test 6.4: `opaqueredirect` must only be accepted in documented shape

Test an envelope with:

```json
{
  "status": 0,
  "type": "opaqueredirect",
  "headers": [],
  "body": null
}
```

Expected:

- if supported, reconstructed response must expose documented fields;
- if unsupported, reject explicitly.

### Acceptance Criteria

- Impossible service envelopes must fail validation.
- Special responses must not silently produce impossible objects.
- The contract must clearly define which special response states the service may return.

## Test Group 7: Multipart Boundary Collision

### Problem

Multipart response parsing identifies the terminal boundary inside a byte stream.

If target body bytes contain:

```txt
\r\n--boundary--\r\n
```

the parser may interpret it as the multipart terminator.

### Requirement

Multipart binary responses must preserve arbitrary bytes.

If full arbitrary byte preservation cannot be guaranteed with multipart, the service must use a boundary that does not occur in the payload or use another transport.

### Test 7.1: Body contains boundary-like bytes not at terminal position

Craft service response manually with boundary:

```txt
test-boundary
```

Binary body contains:

```txt
hello\r\n--test-boundary--\r\nworld
```

Expected ideal behavior:

```js
const bytes = new Uint8Array(await response.arrayBuffer());
expect(Buffer.from(bytes).toString('utf8')).toBe(
  'hello\r\n--test-boundary--\r\nworld',
);
```

If this cannot be supported by multipart design, the test should document the limitation and require orchestrator-side boundary selection.

### Test 7.2: Boundary-like bytes with suffix must not terminate body

Binary body contains:

```txt
hello\r\n--test-boundary--suffix\r\nworld
```

Expected:

```js
body must include the entire payload
```

This should pass with a parser that checks terminal marker boundaries correctly.

### Acceptance Criteria

- Boundary suffix cases must not truncate the body.
- Exact terminal boundary collision must either be prevented by orchestrator boundary selection or documented as a protocol limitation.
- If the client parser cannot distinguish collision from real terminator, add a service contract requirement: generated multipart boundary must not occur in binary body bytes.

## Test Group 8: Default Headers Must Not Create Non-Native Behavior Silently

### Problem

`defaultHeaders` are not part of native Fetch API.

They are merged after native `Request` construction.

This can produce target headers that were not validated as part of the original `RequestInit`.

### Requirement

`defaultHeaders` must behave predictably and must not bypass native header validation in dangerous ways.

### Test 8.1: Invalid default header name fails

```js
const proxyFetch = createProxyFetch({
  defaultHeaders: {
    'bad header name': 'value',
  },
});
```

Expected:

```js
expect(() => createProxyFetch(...)).not.toThrow();
await expect(proxyFetch(url)).rejects.toThrow(TypeError);
```

or, preferably, fail at creation time:

```js
expect(() => createProxyFetch(...)).toThrow(TypeError);
```

Choose one behavior and document it.

### Test 8.2: Request headers override default headers

```js
const proxyFetch = createProxyFetch({
  defaultHeaders: {
    'x-test': 'default',
  },
});

await proxyFetch(url, {
  headers: {
    'x-test': 'request',
  },
});
```

Expected target envelope:

```txt
x-test: request
```

### Test 8.3: Default headers do not mutate user headers

Pass a `Headers` instance as default headers.

After request:

```js
expect(originalDefaultHeaders.get('x-test')).toBe('default');
```

### Acceptance Criteria

- Invalid default headers must be caught through native `Headers` validation.
- Request-level headers must override package defaults.
- Header merging must not mutate caller-owned `Headers`.

## Test Group 9: Fetch Function Surface Compatibility

### Problem

Native `fetch` is a function with observable properties such as `name`, `length`, and `toString()`.

A factory-created arrow function will not match this exactly.

### Requirement

This is low priority, but if the package claims drop-in replacement, the function surface should be tested and either aligned or documented.

### Test 9.1: Function arity

```js
expect(proxyFetch.length).toBe(fetch.length);
```

If exact matching is not desired, document the mismatch.

### Test 9.2: Function name

```js
expect(typeof proxyFetch.name).toBe('string');
```

Preferred:

```js
expect(proxyFetch.name).toBe('fetch');
```

or:

```js
expect(proxyFetch.name).toBe('proxyFetch');
```

Choose one stable behavior.

### Test 9.3: Function can be passed as fetch replacement

```js
async function usesFetch(fetchLike) {
  const response = await fetchLike(url);
  return response.text();
}

expect(await usesFetch(proxyFetch)).toBe(await usesFetch(fetch));
```

### Acceptance Criteria

- `proxyFetch` must work when passed as a fetch-like function.
- Exact `name` and `length` mismatches are acceptable only if documented.

## Test Group 10: Request Object Body Semantics

### Problem

`proxyFetch(input, init)` creates a native `Request`.

For existing `Request` input, body behavior must match native Fetch.

### Requirement

These two calls must be equivalent where Node.js Fetch treats them as equivalent:

```js
fetch(url, { method: 'POST', body: 'hello' });
fetch(new Request(url, { method: 'POST', body: 'hello' }));
```

Same for `proxyFetch`.

### Test 10.1: Existing Request with string body

```js
const request = new Request(url, {
  method: 'POST',
  body: 'hello',
});

const nativeResponse = await fetch(request.clone());
const proxyResponse = await proxyFetch(request.clone());
```

Expected target body:

```txt
hello
```

### Test 10.2: Existing Request with FormData body

```js
const form = new FormData();
form.set('name', 'proxy-fetch');

const request = new Request(url, {
  method: 'POST',
  body: form,
});

await proxyFetch(request);
```

Expected:

- target receives multipart form-data;
- field `name` is `proxy-fetch`;
- boundary is valid;
- `content-type` includes multipart boundary.

### Test 10.3: Existing Request bodyUsed behavior

```js
const request = new Request(url, {
  method: 'POST',
  body: 'hello',
});

await request.text();

await expect(proxyFetch(request)).rejects.toThrow();
```

Expected behavior should match native:

```js
await expect(fetch(request)).rejects.toThrow();
```

### Acceptance Criteria

- Existing `Request` bodies must not lose payload bytes.
- `bodyUsed` constraints must match native Fetch.
- `Request.clone()` behavior must be compatible.

## Test Group 11: Null Body Status Responses

### Problem

Native Fetch responses with status `204`, `205`, or `304` must have null body semantics.

### Requirement

If the service envelope includes a body for status `204`, `205`, or `304`, `proxyFetch()` must behave like native Fetch.

### Test 11.1: 204 with text body in service envelope

Envelope status:

```json
{
  "status": 204,
  "body": { "kind": "text", "text": "must be ignored" }
}
```

Expected:

```js
expect(response.body).toBeNull();
expect(await response.text()).toBe('');
```

### Test 11.2: 304 with binary body in service envelope

Expected:

```js
expect(response.body).toBeNull();
expect(await response.arrayBuffer()).toHaveLength(0);
```

### Acceptance Criteria

- Null-body status codes must ignore envelope body.
- Behavior must match native `new Response(null, { status: 204 })`.

## Test Group 12: Redirect, Integrity, Referrer, And Cache Are Orchestrator-Enforced

### Problem

The client serializes request metadata, but the microservice must enforce it.

The local package cannot guarantee that target execution respects:

- `redirect`;
- `integrity`;
- `referrer`;
- `referrerPolicy`;
- `cache`;
- `credentials`;
- `mode`.

### Requirement

The client tests must verify correct serialization.

Integration tests with a compatible orchestrator must verify actual enforcement.

### Test 12.1: redirect metadata is serialized

```js
await proxyFetch(url, {
  redirect: 'manual',
});
```

Expected service envelope:

```json
{
  "redirect": "manual"
}
```

### Test 12.2: redirect behavior against real orchestrator

Target server returns redirect.

Compare:

```js
await fetch(url, { redirect: 'manual' });
await proxyFetch(url, { redirect: 'manual' });
```

Expected:

- status;
- url;
- redirected;
- type;
- headers;
- body behavior should match as closely as Node.js 26 allows.

### Test 12.3: integrity failure

Target server returns content that does not match provided integrity.

Native Fetch should reject or fail according to Node.js 26 behavior.

`proxyFetch()` must match if orchestrator supports integrity enforcement.

If it cannot, document as orchestrator responsibility.

### Acceptance Criteria

- Client must serialize all non-default metadata.
- Orchestrator compatibility tests must verify real behavior.
- Any unsupported metadata must be documented.

## Test Group 13: Error Class Compatibility

### Problem

Native Fetch rejects network-level failures with native error types.

`proxyFetch()` introduces package-specific errors for service-layer failures.

### Requirement

Target HTTP errors must resolve as `Response`.

Service-layer failures may throw package-specific errors, but target network failures should be mapped intentionally.

### Test 13.1: Target 404 resolves

```js
const response = await proxyFetch(target404Url);

expect(response.status).toBe(404);
expect(response.ok).toBe(false);
```

### Test 13.2: Service HTTP 500 rejects with ProxyFetchServiceError

```js
await expect(proxyFetch(url)).rejects.toMatchObject({
  name: 'ProxyFetchServiceError',
  code: 'SERVICE_HTTP_ERROR',
});
```

### Test 13.3: Service invalid JSON rejects with InvalidServiceResponseError

```js
await expect(proxyFetch(url)).rejects.toMatchObject({
  name: 'InvalidServiceResponseError',
});
```

### Test 13.4: Target network failure contract

If orchestrator returns:

```json
{
  "ok": false,
  "error": {
    "code": "UPSTREAM_FETCH_ERROR",
    "message": "...",
    "retryable": true
  }
}
```

Expected:

- either `ProxyFetchServiceError` is accepted as service-boundary behavior;
- or map it to native-like `TypeError`.

Choose one behavior and document it.

### Acceptance Criteria

- Target HTTP statuses must not throw.
- Service failures must throw documented package errors.
- Target network failures must have a stable documented mapping.

## Test Group 14: AbortSignal.reason Compatibility

### Problem

Node.js supports abort reasons.

`proxyFetch()` should preserve user abort reasons where possible.

### Requirement

If user aborts with a custom reason, the rejection reason should match native Fetch as closely as possible.

### Test 14.1: Already-aborted custom Error reason

```js
const reason = new Error('custom abort');
const controller = new AbortController();

controller.abort(reason);

await expect(
  proxyFetch(url, {
    signal: controller.signal,
  }),
).rejects.toBe(reason);
```

### Test 14.2: AbortSignal.timeout

```js
const signal = AbortSignal.timeout(10);

await expect(proxyFetch(slowUrl, { signal })).rejects.toMatchObject({
  name: 'TimeoutError',
});
```

### Test 14.3: AbortSignal.any

```js
const controller = new AbortController();
const timeout = AbortSignal.timeout(1000);
const signal = AbortSignal.any([controller.signal, timeout]);

const reason = new Error('manual abort');
controller.abort(reason);

await expect(proxyFetch(slowUrl, { signal })).rejects.toBe(reason);
```

### Acceptance Criteria

- Custom abort reasons must not be replaced by generic package errors.
- Timeout reasons should preserve `TimeoutError`.
- `AbortSignal.any()` behavior should follow native signal semantics.

## Final Acceptance Criteria

The compatibility suite is accepted when:

1. All ordinary request types match native Fetch:

- no body;
- string;
- URLSearchParams;
- Blob;
- ArrayBuffer;
- typed arrays;
- FormData;
- ReadableStream with `duplex: 'half'`;
- existing `Request` objects.

2. All ordinary response body readers match native Fetch:

- `text()`;
- `json()`;
- `arrayBuffer()`;
- `blob()`;
- `formData()`, where applicable;
- `clone()`;
- `bodyUsed`.

3. Response metadata matches native Fetch:

- `status`;
- `statusText`;
- `ok`;
- `headers`;
- `url`;
- `redirected`;
- `type`.

4. Abort behavior matches as closely as possible:

- already aborted;
- abort during service request;
- abort during upload;
- abort during response body consumption;
- custom abort reason;
- timeout signal.

5. Unsupported Node.js Fetch features must fail explicitly:

- local `dispatcher` must not be silently ignored;
- impossible special response envelopes must not be accepted silently.

6. Any remaining mismatch caused by the remote microservice boundary must be documented in `API_FETCH_NODE_26_CONTRADICTION.md`.
