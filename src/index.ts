// @agreely/sdk — the thin, typed TypeScript/Node client for the Agreely /v1
// consent API. The CLI (P3-M3) imports from here.

export { Agreely } from "./client.js";
export { BreakGlass } from "./breakGlass.js";
export { ReceiptVerifier } from "./verify/receipt.js";

export {
  AgreelyError,
  AgreelyAuthError,
  AgreelyValidationError,
  AgreelyNotFoundError,
  AgreelyBillingInactiveError,
  AgreelyRateLimitError,
  AgreelyUnavailableError,
  AgreelyTimeoutError,
  AgreelyAbortError,
  AgreelyConfigError,
} from "./errors.js";
export type { AgreelyErrorCode } from "./errors.js";

export type {
  AgreelyOptions,
  CheckOptions,
  CheckResult,
  Decision,
  Status,
  Assurance,
  Scope,
  Identity,
  ItemLabels,
  IssueItem,
  CreateConsentRequestInput,
  ConsentDocumentDescriptor,
  IssuedRequest,
  ConsentRequestStatus,
  ConsentRequestRecord,
  CancelledRequest,
  ListConsentRequestsInput,
  ListAllConsentRequestsInput,
  WaitForSettlementOptions,
  ConsentRequestPage,
  ManualConsentEvidence,
  RecordManualConsentInput,
  ManualConsentResult,
  CreateClaimLinkInput,
  ClaimLink,
  ManualConsentMutationInput,
  ManualConsentRevocation,
  ManualConsentErasure,
  EndRelationshipInput,
  RelationshipEnded,
  RevertRelationshipInput,
  RelationshipReverted,
  CatalogEntry,
  DegradeMode,
  DegradeContext,
  DegradeOnOutageConfig,
  BreakGlassEvent,
  BreakGlassEngageInput,
  BatchCheckItem,
  BatchDecision,
  CheckFieldsResult,
} from "./types.js";

export type {
  ReceiptVerification,
  ReceiptType,
  CheckStatus,
  OverallStatus,
  DidDocument,
  DidVerificationMethod,
  DidResolver,
  VerifyReceiptOptions,
} from "./verify/types.js";
