// @agreely/sdk — the thin, typed TypeScript/Node client for the Agreely /v1
// consent API. The CLI (P3-M3) imports from here.

export { Agreely } from "./client.js";
export { BreakGlass } from "./breakGlass.js";

export {
  AgreelyError,
  AgreelyAuthError,
  AgreelyValidationError,
  AgreelyNotFoundError,
  AgreelyRateLimitError,
  AgreelyUnavailableError,
  AgreelyConfigError,
} from "./errors.js";
export type { AgreelyErrorCode } from "./errors.js";

export type {
  AgreelyOptions,
  CheckOptions,
  CheckResult,
  Decision,
  Status,
  ItemLabels,
  IssueItem,
  CreateConsentRequestInput,
  IssuedRequest,
  ConsentRequestStatus,
  ConsentRequestRecord,
  ListConsentRequestsInput,
  ConsentRequestPage,
  CatalogEntry,
  DegradeMode,
  DegradeContext,
  DegradeOnOutageConfig,
  BreakGlassEvent,
  BreakGlassEngageInput,
} from "./types.js";
