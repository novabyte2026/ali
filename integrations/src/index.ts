export * from './common/adapter.js';
export * from './common/config.js';
export * from './common/http.js';
export * from './common/mapping.js';
export * from './common/links.js';
export * from './common/resilience.js';
export * from './common/totals.js';

export { AmazonAdapter } from './amazon/index.js';
export { signPaapiRequest, deriveSigningKey, toAmzDate, sha256Hex } from './amazon/signer.js';
export { mapAmazonItem } from './amazon/mapper.js';
export type { PaapiItem, PaapiSearchResponse, PaapiGetItemsResponse } from './amazon/types.js';

export { AliExpressAdapter } from './aliexpress/index.js';
export {
  buildTopRequestBody,
  canonicalString,
  cleanParams,
  signTopRequest,
  topTimestamp,
} from './aliexpress/signer.js';
export { mapAliExpressProduct } from './aliexpress/mapper.js';
export type { AliExpressProduct } from './aliexpress/types.js';

export { TemuAdapter } from './temu/index.js';
export { canonicalize as temuCanonicalize, signTemuRequest } from './temu/signer.js';
export { mapTemuProduct } from './temu/mapper.js';
export { TEMU_FIELD_MAP, readMapped as readTemuField } from './temu/types.js';
export type { TemuProduct, TemuSearchResponse } from './temu/types.js';

export { DemoFixtureAdapter } from './fixtures/demo-adapter.js';
export { DEMO_CATALOG, demoListingsFor } from './fixtures/catalog.js';
export type { DemoListing } from './fixtures/catalog.js';

export * from './registry.js';
