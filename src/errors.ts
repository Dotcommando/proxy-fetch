export interface ProxyFetchErrorOptions {
  cause?: unknown;
}

export class ProxyFetchError extends Error {
  constructor(message: string, options: ProxyFetchErrorOptions = {}) {
    super(message, options);
    this.name = 'ProxyFetchError';
  }
}

export class ProxyFetchConfigError extends ProxyFetchError {
  constructor(message: string, options: ProxyFetchErrorOptions = {}) {
    super(message, options);
    this.name = 'ProxyFetchConfigError';
  }
}

export interface ProxyFetchServiceErrorOptions extends ProxyFetchErrorOptions {
  code: string;
  retryable: boolean;
  details?: unknown;
}

export class ProxyFetchServiceError extends ProxyFetchError {
  readonly code: string;

  readonly retryable: boolean;

  readonly details?: unknown;

  constructor(message: string, options: ProxyFetchServiceErrorOptions) {
    super(message, options);
    this.name = 'ProxyFetchServiceError';
    this.code = options.code;
    this.retryable = options.retryable;

    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export class InvalidServiceResponseError extends ProxyFetchServiceError {
  constructor(message: string, options: ProxyFetchServiceErrorOptions) {
    super(message, options);
    this.name = 'InvalidServiceResponseError';
  }
}
