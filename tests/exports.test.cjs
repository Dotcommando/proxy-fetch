const { pathToFileURL } = require('node:url');

describe('package exports', () => {
  it('declares Node.js 20+ runtime support', () => {
    const packageJson = require('../package.json');

    expect(packageJson.engines.node).toBe('>=20');
  });

  it('supports CommonJS require consumers', () => {
    const cjsExports = require('../dist/index.cjs');

    expect(cjsExports).toMatchObject({
      DEFAULT_TIMEOUT_MS: 360_000,
      PROXY_FETCH_SERVICE_URL_ENV: 'PROXY_FETCH_SERVICE_URL',
      PROXY_FETCH_DEFAULT_TIMEOUT_MS_ENV: 'PROXY_FETCH_DEFAULT_TIMEOUT_MS',
    });
    expect(cjsExports.createProxyFetch).toEqual(expect.any(Function));
    expect(cjsExports.ProxyFetchServiceError).toEqual(expect.any(Function));
  });

  it('supports ESM import consumers', async () => {
    const esmExports = await import(
      pathToFileURL(`${process.cwd()}/dist/index.js`).href
    );

    expect(esmExports).toMatchObject({
      DEFAULT_TIMEOUT_MS: 360_000,
      PROXY_FETCH_SERVICE_URL_ENV: 'PROXY_FETCH_SERVICE_URL',
      PROXY_FETCH_DEFAULT_TIMEOUT_MS_ENV: 'PROXY_FETCH_DEFAULT_TIMEOUT_MS',
    });
    expect(esmExports.createProxyFetch).toEqual(expect.any(Function));
    expect(esmExports.ProxyFetchServiceError).toEqual(expect.any(Function));
  });
});
