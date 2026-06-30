// Public type aliases over the generated OpenAPI schema. These re-export the
// shapes beliq actually accepts and returns, so they stay in sync with the API
// via `npm run gen:types` (drift-guarded by `npm run openapi:check`).
import type { operations } from './generated/schema';

type Json200Data<Op extends keyof operations> = operations[Op] extends {
  responses: { 200: { content: { 'application/json': { data?: infer D } } } };
}
  ? NonNullable<D>
  : never;

type Error400<Op extends keyof operations> = operations[Op] extends {
  responses: { 400: { content: { 'application/json': { error: infer E } } } };
}
  ? E
  : never;

type RequestJson<Op extends keyof operations> = operations[Op] extends {
  requestBody?: { content: { 'application/json': infer B } };
}
  ? B
  : never;

type Query<Op extends keyof operations> = NonNullable<
  operations[Op]['parameters']['query']
>;

/** Account, plan, and quota context for the calling key (GET /v1/me). */
export type AccountInfo = Json200Data<'getAccount'>;

/** Validation verdict plus the authority versions it was checked against. */
export type ValidationResult = Json200Data<'validateInvoice'>;
export type ValidationIssue = ValidationResult['errors'][number];
export type Severity = ValidationIssue['severity'];
export type ValidationFormat = ValidationResult['format'];

/** Structured invoice extracted from a document (POST /v1/parse). */
export type ParseResult = Json200Data<'parseInvoice'>;

/** The EN 16931 invoice generate accepts, and every option it carries. */
export type GenerateBody = RequestJson<'generateInvoice'>;
export type Invoice = GenerateBody['invoice'];
export type Standard = GenerateBody['standard'];
export type GenerateProfile = NonNullable<GenerateBody['profile']>;
export type FacturxProfile = NonNullable<GenerateBody['facturxProfile']>;

/** The uniform error envelope and its closed code set. */
export type ApiError = Error400<'validateInvoice'>;
export type ApiErrorCode = ApiError['code'];

/** Query enums, faithful to what each endpoint accepts. */
export type ValidateFormat = NonNullable<Query<'validateInvoice'>['format']>;
export type ParseFormat = NonNullable<Query<'parseInvoice'>['format']>;
export type ConvertSourceFormat = NonNullable<Query<'convertInvoice'>['sourceFormat']>;
export type ConvertTargetFormat = Query<'convertInvoice'>['targetFormat'];
