import { createHash } from 'node:crypto';

import type { RuntimeOutputLine } from './adapters/types.js';

export const CAPSULE_SCHEMA_VERSION = 'missionbraid.dev/capsule/v1' as const;
export const CAPSULE_ACK_SCHEMA_VERSION = 'missionbraid.dev/handoff-ack/v1' as const;
export const CAPSULE_ACK_PREFIX = 'MISSIONBRAID_ACK ' as const;
export const CAPSULE_ESTIMATOR_VERSION = 'utf8-bytes-div-4/v1' as const;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_ACK_RECURSION_DEPTH = 24;

function compareIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface CapsuleAttemptRefV1 {
  readonly attemptId: string;
  readonly stageId: string;
  readonly profileId: string;
}

export interface CapsuleCheckpointV1 {
  readonly checkpointId: string;
  readonly workspaceDigest: string;
}

export interface CapsuleRemainingCriterionV1 {
  readonly criterionId: string;
  readonly summary: string;
}

export interface CanonicalCapsuleInputV1 {
  readonly missionId: string;
  readonly contractId: string;
  readonly contractSummary: string;
  readonly constraints: readonly string[];
  readonly source: CapsuleAttemptRefV1;
  readonly target: CapsuleAttemptRefV1;
  readonly checkpoint: CapsuleCheckpointV1;
  readonly remainingCriteria: readonly CapsuleRemainingCriterionV1[];
  readonly doNotRepeatEffectIds: readonly string[];
}

export interface CanonicalCapsuleV1 extends CanonicalCapsuleInputV1 {
  readonly schemaVersion: typeof CAPSULE_SCHEMA_VERSION;
  readonly capsuleId: string;
  readonly capsuleHash: string;
}

export interface HandoffAcknowledgementV1 {
  readonly schemaVersion: typeof CAPSULE_ACK_SCHEMA_VERSION;
  readonly capsuleId: string;
  readonly contractId: string;
  readonly checkpointId: string;
  readonly remainingCriterionIds: readonly string[];
  readonly effectIds: readonly string[];
}

export interface CapsuleProjectionV1 {
  readonly schemaVersion: typeof CAPSULE_SCHEMA_VERSION;
  readonly capsuleId: string;
  readonly capsuleHash: string;
  readonly projectionHash: string;
  readonly canonicalJson: string;
  readonly text: string;
  readonly expectedAcknowledgement: HandoffAcknowledgementV1;
  readonly utf8Bytes: number;
  readonly estimatedTokens: number;
  readonly budgetTokens: number;
  readonly estimatorVersion: typeof CAPSULE_ESTIMATOR_VERSION;
}

export interface CapsuleProjectionBudgetError {
  readonly code: 'CAPSULE_CORE_EXCEEDS_BUDGET';
  readonly capsuleId: string;
  readonly utf8Bytes: number;
  readonly requiredTokens: number;
  readonly availableTokens: number;
  readonly shortfallTokens: number;
  readonly estimatorVersion: typeof CAPSULE_ESTIMATOR_VERSION;
  readonly allowedRecovery: readonly [
    'SELECT_LARGER_PROFILE',
    'USER_APPROVED_CONTRACT_PARTITION',
    'ABORT_HANDOFF',
  ];
}

export type CapsuleProjectionResult =
  | { readonly ok: true; readonly projection: CapsuleProjectionV1 }
  | { readonly ok: false; readonly error: CapsuleProjectionBudgetError };

export type AcknowledgementErrorCode =
  | 'ACK_NOT_FOUND'
  | 'ACK_MALFORMED'
  | 'ACK_AMBIGUOUS'
  | 'ACK_UNEXPECTED_FIELD'
  | 'ACK_SCHEMA_MISMATCH'
  | 'ACK_FIELD_TYPE_MISMATCH'
  | 'ACK_FIELD_MISMATCH';

export interface AcknowledgementValidationError {
  readonly code: AcknowledgementErrorCode;
  readonly field?: keyof HandoffAcknowledgementV1;
}

export type AcknowledgementValidationResult =
  | { readonly ok: true; readonly acknowledgement: HandoffAcknowledgementV1 }
  | { readonly ok: false; readonly error: AcknowledgementValidationError };

export class CapsuleValidationError extends Error {}

export class CapsuleIntegrityError extends Error {}

function requireNonEmpty(value: string, path: string): string {
  if (value.trim().length === 0 || value.includes('\0')) {
    throw new CapsuleValidationError(`${path} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function requireIdentifier(value: string, path: string): string {
  requireNonEmpty(value, path);
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new CapsuleValidationError(`${path} contains unsupported characters`);
  }
  return value;
}

function requireUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    throw new CapsuleValidationError(`${path} must not contain duplicate identifiers`);
  }
}

function normalizeAttemptRef(value: CapsuleAttemptRefV1, path: string): CapsuleAttemptRefV1 {
  return {
    attemptId: requireIdentifier(value.attemptId, `${path}.attemptId`),
    stageId: requireIdentifier(value.stageId, `${path}.stageId`),
    profileId: requireIdentifier(value.profileId, `${path}.profileId`),
  };
}

function canonicalCapsulePayload(
  input: CanonicalCapsuleInputV1,
): Omit<CanonicalCapsuleV1, 'capsuleId' | 'capsuleHash'> {
  const constraints = input.constraints.map((constraint, index) =>
    requireNonEmpty(constraint, `constraints[${index}]`),
  );
  const remainingCriteria = input.remainingCriteria
    .map((criterion, index) => ({
      criterionId: requireIdentifier(
        criterion.criterionId,
        `remainingCriteria[${index}].criterionId`,
      ),
      summary: requireNonEmpty(criterion.summary, `remainingCriteria[${index}].summary`),
    }))
    .sort((left, right) => compareIdentifiers(left.criterionId, right.criterionId));
  requireUnique(
    remainingCriteria.map((criterion) => criterion.criterionId),
    'remainingCriteria',
  );

  const doNotRepeatEffectIds = input.doNotRepeatEffectIds
    .map((effectId, index) => requireIdentifier(effectId, `doNotRepeatEffectIds[${index}]`))
    .sort(compareIdentifiers);
  requireUnique(doNotRepeatEffectIds, 'doNotRepeatEffectIds');

  return {
    schemaVersion: CAPSULE_SCHEMA_VERSION,
    missionId: requireIdentifier(input.missionId, 'missionId'),
    contractId: requireIdentifier(input.contractId, 'contractId'),
    contractSummary: requireNonEmpty(input.contractSummary, 'contractSummary'),
    constraints,
    source: normalizeAttemptRef(input.source, 'source'),
    target: normalizeAttemptRef(input.target, 'target'),
    checkpoint: {
      checkpointId: requireIdentifier(input.checkpoint.checkpointId, 'checkpoint.checkpointId'),
      workspaceDigest: requireNonEmpty(
        input.checkpoint.workspaceDigest,
        'checkpoint.workspaceDigest',
      ),
    },
    remainingCriteria,
    doNotRepeatEffectIds,
  };
}

export function createCanonicalCapsule(input: CanonicalCapsuleInputV1): CanonicalCapsuleV1 {
  const payload = canonicalCapsulePayload(input);
  const capsuleHash = sha256(stableCanonicalJson(payload));
  return {
    ...payload,
    capsuleId: `capsule-${capsuleHash}`,
    capsuleHash,
  };
}

function verifyCapsuleIntegrity(capsule: CanonicalCapsuleV1): void {
  const payload = canonicalCapsulePayload(capsule);
  const expectedHash = sha256(stableCanonicalJson(payload));
  if (
    capsule.schemaVersion !== CAPSULE_SCHEMA_VERSION ||
    capsule.capsuleHash !== expectedHash ||
    capsule.capsuleId !== `capsule-${expectedHash}`
  ) {
    throw new CapsuleIntegrityError('Canonical Capsule identity or hash does not match its core');
  }
}

export function expectedAcknowledgement(capsule: CanonicalCapsuleV1): HandoffAcknowledgementV1 {
  verifyCapsuleIntegrity(capsule);
  return {
    schemaVersion: CAPSULE_ACK_SCHEMA_VERSION,
    capsuleId: capsule.capsuleId,
    contractId: capsule.contractId,
    checkpointId: capsule.checkpoint.checkpointId,
    remainingCriterionIds: capsule.remainingCriteria.map((criterion) => criterion.criterionId),
    effectIds: [...capsule.doNotRepeatEffectIds],
  };
}

export function estimateUtf8Tokens(value: string): {
  readonly utf8Bytes: number;
  readonly estimatedTokens: number;
} {
  const utf8Bytes = Buffer.byteLength(value, 'utf8');
  return {
    utf8Bytes,
    estimatedTokens: Math.ceil(utf8Bytes / 4),
  };
}

export function projectCanonicalCapsule(
  capsule: CanonicalCapsuleV1,
  budgetTokens: number,
): CapsuleProjectionResult {
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens <= 0) {
    throw new CapsuleValidationError('budgetTokens must be a positive safe integer');
  }
  verifyCapsuleIntegrity(capsule);

  const canonicalJson = stableCanonicalJson(capsule);
  const acknowledgement = expectedAcknowledgement(capsule);
  const acknowledgementJson = stableCanonicalJson(acknowledgement);
  const renderedWithoutHash = [
    'MISSIONBRAID_HANDOFF_V1',
    'Before modifying files or invoking any mutable tool, output exactly this one line:',
    `${CAPSULE_ACK_PREFIX}${acknowledgementJson}`,
    'Only after that acknowledgement may you continue the remaining criteria.',
    `CAPSULE_JSON ${canonicalJson}`,
  ].join('\n');
  const projectionHash = sha256(renderedWithoutHash);
  const [heading, ...body] = renderedWithoutHash.split('\n');
  const text = [heading, `PROJECTION_HASH ${projectionHash}`, ...body].join('\n');
  const { utf8Bytes, estimatedTokens } = estimateUtf8Tokens(text);

  if (estimatedTokens > budgetTokens) {
    return {
      ok: false,
      error: {
        code: 'CAPSULE_CORE_EXCEEDS_BUDGET',
        capsuleId: capsule.capsuleId,
        utf8Bytes,
        requiredTokens: estimatedTokens,
        availableTokens: budgetTokens,
        shortfallTokens: estimatedTokens - budgetTokens,
        estimatorVersion: CAPSULE_ESTIMATOR_VERSION,
        allowedRecovery: [
          'SELECT_LARGER_PROFILE',
          'USER_APPROVED_CONTRACT_PARTITION',
          'ABORT_HANDOFF',
        ],
      },
    };
  }

  return {
    ok: true,
    projection: {
      schemaVersion: CAPSULE_SCHEMA_VERSION,
      capsuleId: capsule.capsuleId,
      capsuleHash: capsule.capsuleHash,
      projectionHash,
      canonicalJson,
      text,
      expectedAcknowledgement: acknowledgement,
      utf8Bytes,
      estimatedTokens,
      budgetTokens,
      estimatorVersion: CAPSULE_ESTIMATOR_VERSION,
    },
  };
}

const ACK_KEYS = [
  'capsuleId',
  'checkpointId',
  'contractId',
  'effectIds',
  'remainingCriterionIds',
  'schemaVersion',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function looksLikeAcknowledgement(value: Record<string, unknown>): boolean {
  return (
    'capsuleId' in value &&
    'contractId' in value &&
    'checkpointId' in value &&
    'remainingCriterionIds' in value &&
    'effectIds' in value
  );
}

interface CollectedAcknowledgements {
  readonly candidates: unknown[];
  malformed: boolean;
}

function collectFromString(value: string, collection: CollectedAcknowledgements): void {
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(CAPSULE_ACK_PREFIX)) {
      continue;
    }
    const json = trimmed.slice(CAPSULE_ACK_PREFIX.length);
    try {
      collection.candidates.push(JSON.parse(json) as unknown);
    } catch {
      collection.malformed = true;
    }
  }
}

function collectAcknowledgements(
  value: unknown,
  collection: CollectedAcknowledgements,
  seen: WeakSet<object>,
  depth: number,
): void {
  if (depth > MAX_ACK_RECURSION_DEPTH) {
    return;
  }
  if (typeof value === 'string') {
    collectFromString(value, collection);
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length <= 1_000_000) {
      try {
        collectAcknowledgements(JSON.parse(trimmed) as unknown, collection, seen, depth + 1);
      } catch {
        // Ordinary runtime text may look JSON-like; only ACK-prefixed parse
        // failures are acknowledgement errors.
      }
    }
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const member of value) {
      collectAcknowledgements(member, collection, seen, depth + 1);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  if (looksLikeAcknowledgement(record)) {
    collection.candidates.push(record);
  }
  for (const member of Object.values(record)) {
    collectAcknowledgements(member, collection, seen, depth + 1);
  }
}

function uniqueCandidates(candidates: readonly unknown[]): unknown[] {
  const unique = new Map<string, unknown>();
  let nonCanonicalIndex = 0;
  for (const candidate of candidates) {
    try {
      unique.set(stableCanonicalJson(candidate), candidate);
    } catch {
      nonCanonicalIndex += 1;
      unique.set(`non-canonical-${nonCanonicalIndex}`, candidate);
    }
  }
  return [...unique.values()];
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((member) => typeof member !== 'string')) {
    return null;
  }
  const strings = value as string[];
  return new Set(strings).size === strings.length ? strings : null;
}

function equalSets(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}

function validateAcknowledgementCandidate(
  candidate: unknown,
  expected: HandoffAcknowledgementV1,
): AcknowledgementValidationResult {
  if (!isRecord(candidate)) {
    return { ok: false, error: { code: 'ACK_MALFORMED' } };
  }

  const keys = Object.keys(candidate).sort();
  if (keys.length !== ACK_KEYS.length || keys.some((key, index) => key !== ACK_KEYS[index])) {
    return { ok: false, error: { code: 'ACK_UNEXPECTED_FIELD' } };
  }
  if (candidate.schemaVersion !== CAPSULE_ACK_SCHEMA_VERSION) {
    return {
      ok: false,
      error: { code: 'ACK_SCHEMA_MISMATCH', field: 'schemaVersion' },
    };
  }

  for (const field of ['capsuleId', 'contractId', 'checkpointId'] as const) {
    if (typeof candidate[field] !== 'string') {
      return { ok: false, error: { code: 'ACK_FIELD_TYPE_MISMATCH', field } };
    }
    if (candidate[field] !== expected[field]) {
      return { ok: false, error: { code: 'ACK_FIELD_MISMATCH', field } };
    }
  }

  const remainingCriterionIds = stringArray(candidate.remainingCriterionIds);
  if (remainingCriterionIds === null) {
    return {
      ok: false,
      error: { code: 'ACK_FIELD_TYPE_MISMATCH', field: 'remainingCriterionIds' },
    };
  }
  if (!equalSets(remainingCriterionIds, expected.remainingCriterionIds)) {
    return {
      ok: false,
      error: { code: 'ACK_FIELD_MISMATCH', field: 'remainingCriterionIds' },
    };
  }

  const effectIds = stringArray(candidate.effectIds);
  if (effectIds === null) {
    return {
      ok: false,
      error: { code: 'ACK_FIELD_TYPE_MISMATCH', field: 'effectIds' },
    };
  }
  if (!equalSets(effectIds, expected.effectIds)) {
    return {
      ok: false,
      error: { code: 'ACK_FIELD_MISMATCH', field: 'effectIds' },
    };
  }

  return { ok: true, acknowledgement: expected };
}

/**
 * Extract and validate an acknowledgement from adapter output. A successful
 * match proves only that the critical identifiers were echoed; it does not
 * prove equivalent hidden reasoning or future runtime compliance.
 */
export function extractAndValidateAcknowledgement(
  output: RuntimeOutputLine | readonly RuntimeOutputLine[],
  capsule: CanonicalCapsuleV1,
): AcknowledgementValidationResult {
  const expected = expectedAcknowledgement(capsule);
  const events = Array.isArray(output) ? output : [output];
  const collection: CollectedAcknowledgements = { candidates: [], malformed: false };

  for (const event of events) {
    const seen = new WeakSet<object>();
    if (event.value !== undefined) {
      collectAcknowledgements(event.value, collection, seen, 0);
    }
    collectAcknowledgements(event.line, collection, seen, 0);
  }

  const candidates = uniqueCandidates(collection.candidates);
  if (candidates.length === 0) {
    return {
      ok: false,
      error: { code: collection.malformed ? 'ACK_MALFORMED' : 'ACK_NOT_FOUND' },
    };
  }
  if (candidates.length > 1) {
    return { ok: false, error: { code: 'ACK_AMBIGUOUS' } };
  }
  return validateAcknowledgementCandidate(candidates[0], expected);
}

export function stableCanonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CapsuleValidationError('Canonical JSON forbids non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableCanonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        const member = record[key];
        if (member === undefined) {
          throw new CapsuleValidationError(`Canonical JSON forbids undefined at ${key}`);
        }
        return `${JSON.stringify(key)}:${stableCanonicalJson(member)}`;
      })
      .join(',')}}`;
  }
  throw new CapsuleValidationError(`Value of type ${typeof value} is not canonical JSON`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
