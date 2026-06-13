import type { ProxyFetchContext } from '../types';

export const mergeContext = (
  defaultContext?: ProxyFetchContext,
  requestContext?: ProxyFetchContext,
): ProxyFetchContext => {
  const context: ProxyFetchContext = {};
  const metadata = {
    ...defaultContext?.metadata,
    ...requestContext?.metadata,
  };

  if (defaultContext?.useCase !== undefined) {
    context.useCase = defaultContext.useCase;
  }
  if (defaultContext?.flowKey !== undefined) {
    context.flowKey = defaultContext.flowKey;
  }
  if (defaultContext?.consistency !== undefined) {
    context.consistency = defaultContext.consistency;
  }
  if (requestContext?.useCase !== undefined) {
    context.useCase = requestContext.useCase;
  }
  if (requestContext?.flowKey !== undefined) {
    context.flowKey = requestContext.flowKey;
  }
  if (requestContext?.consistency !== undefined) {
    context.consistency = requestContext.consistency;
  }
  if (Object.keys(metadata).length > 0) {
    context.metadata = metadata;
  }

  return context;
};
