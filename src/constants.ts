export const WIRE_PROTOCOL_VERSION = 'proxy-fetch.v1';

export const PROXY_FETCH_SERVICE_URL_ENV = 'PROXY_FETCH_SERVICE_URL';

export const PROXY_FETCH_DEFAULT_TIMEOUT_MS_ENV =
  'PROXY_FETCH_DEFAULT_TIMEOUT_MS';

export const DEFAULT_TIMEOUT_MS = 360_000;

export const BODY_ENCODING_BASE64 = 'base64';

export const BODY_KIND_TEXT = 'text';

export const BODY_KIND_BINARY = 'binary';

export const BODY_KIND_BASE64 = 'base64';

export const BINARY_BODY_PART_NAME = 'body';

export const METADATA_PART_NAME = 'meta';

export const BINARY_BODY_TRANSPORT_MULTIPART = 'multipart';

export const BINARY_BODY_TRANSPORT_JSON_BASE64 = 'json-base64';

export const SERVICE_REQUEST_TRANSPORT_JSON = 'json';

export const SERVICE_REQUEST_TRANSPORT_MULTIPART = 'multipart';

export const SERVICE_HTTP_METHOD = 'POST';

export const JSON_CONTENT_TYPE = 'application/json';

export const MULTIPART_CONTENT_TYPE_PREFIX = 'multipart/form-data';

export const SERVICE_ACCEPT_HEADER_VALUE = `${JSON_CONTENT_TYPE}, ${MULTIPART_CONTENT_TYPE_PREFIX}`;

export const TEXT_CONTENT_TYPE_PREFIX = 'text/';

export const FORM_URLENCODED_CONTENT_TYPE = 'application/x-www-form-urlencoded';

export const XML_CONTENT_TYPE = 'application/xml';

export const GRAPHQL_CONTENT_TYPE = 'application/graphql';

export const ACCEPT_HEADER_NAME = 'accept';

export const AUTHORIZATION_HEADER_NAME = 'authorization';

export const CONTENT_TYPE_HEADER_NAME = 'content-type';

export const AUTHORIZATION_BEARER_PREFIX = 'Bearer ';

export const HEADER_PAIR_LENGTH = 2;

export const SERVICE_HTTP_ERROR_CODE = 'SERVICE_HTTP_ERROR';

export const INVALID_SERVICE_RESPONSE_CODE = 'INVALID_SERVICE_RESPONSE';
