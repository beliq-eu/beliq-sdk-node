// Pure, transport-free helpers and option lists, exposed at `@beliq/sdk/helpers`
// so connectors (n8n, Pipedream, Activepieces) reuse one request builder and
// one set of curated option lists rather than re-deriving them per framework.
export { buildRequest } from './buildRequest';
export type { BuildParams, BuiltRequest, Operation, OutputKind, QueryValue } from './buildRequest';

export {
  mergeDeep,
  compactQuery,
  sniffContentType,
  toBytes,
  decodeUtf8,
  isPlainObject,
} from './internal';
export type { PlainObject, DocumentInput } from './internal';

export {
  DEFAULT_BASE_URL,
  LIVE_GENERATE_STANDARDS,
  LIVE_PROFILES,
  LIVE_VALIDATE_FORMATS,
  LIVE_PARSE_FORMATS,
  LIVE_CONVERT_SOURCE_FORMATS,
  LIVE_CONVERT_TARGET_FORMATS,
} from './constants';
