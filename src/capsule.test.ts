import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { RuntimeOutputLine } from './adapters/types.js';
import {
  CAPSULE_ACK_PREFIX,
  CapsuleIntegrityError,
  CapsuleValidationError,
  createCanonicalCapsule,
  estimateUtf8Tokens,
  expectedAcknowledgement,
  extractAndValidateAcknowledgement,
  projectCanonicalCapsule,
  stableCanonicalJson,
  type CanonicalCapsuleInputV1,
  type HandoffAcknowledgementV1,
} from './capsule.js';

function capsuleInput(): CanonicalCapsuleInputV1 {
  return {
    missionId: 'mission-e1',
    contractId: 'contract-e1',
    contractSummary: 'Finish the crash-tolerant Effect Ledger and pass the original verifiers.',
    constraints: [
      'Do not push, publish, deploy, or contact external services.',
      'Do not repeat a confirmed mutable effect.',
    ],
    source: {
      attemptId: 'attempt-codex',
      stageId: 'stage-ledger-core',
      profileId: 'profile-codex',
    },
    target: {
      attemptId: 'attempt-qoder',
      stageId: 'stage-ledger-cli',
      profileId: 'profile-qoder',
    },
    checkpoint: {
      checkpointId: 'checkpoint-after-core',
      workspaceDigest: 'sha256:workspace-after-core',
    },
    remainingCriteria: [
      { criterionId: 'recovery', summary: 'Recover an incomplete final JSONL record.' },
      { criterionId: 'cli', summary: 'Expose the contracted CLI behavior.' },
    ],
    doNotRepeatEffectIds: ['effect-publish', 'effect-push'],
  };
}

function outputLine(line: string, value?: unknown): RuntimeOutputLine {
  return {
    runtime: 'qoder',
    sequence: 1,
    stream: 'stdout',
    line,
    receivedAt: '2026-08-24T00:00:00.000Z',
    ...(value === undefined ? {} : { value }),
  };
}

function ackLine(acknowledgement: HandoffAcknowledgementV1): string {
  return `${CAPSULE_ACK_PREFIX}${stableCanonicalJson(acknowledgement)}`;
}

describe('Canonical Capsule', () => {
  it('normalizes set-like identifiers and creates a stable content identity', () => {
    const input = capsuleInput();
    const first = createCanonicalCapsule(input);
    const second = createCanonicalCapsule({
      ...input,
      remainingCriteria: [...input.remainingCriteria].reverse(),
      doNotRepeatEffectIds: [...input.doNotRepeatEffectIds].reverse(),
      source: { ...input.source },
    });

    expect(second).toEqual(first);
    expect(first.capsuleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.capsuleId).toBe(`capsule-${first.capsuleHash}`);
    expect(first.remainingCriteria.map((criterion) => criterion.criterionId)).toEqual([
      'cli',
      'recovery',
    ]);
    expect(first.doNotRepeatEffectIds).toEqual(['effect-publish', 'effect-push']);
  });

  it('rejects duplicate or malformed core identifiers instead of weakening them', () => {
    const input = capsuleInput();

    expect(() =>
      createCanonicalCapsule({
        ...input,
        doNotRepeatEffectIds: ['effect-push', 'effect-push'],
      }),
    ).toThrow(CapsuleValidationError);
    expect(() =>
      createCanonicalCapsule({
        ...input,
        checkpoint: { ...input.checkpoint, checkpointId: 'contains whitespace' },
      }),
    ).toThrow(CapsuleValidationError);
  });

  it('detects mutation before projection', () => {
    const capsule = createCanonicalCapsule(capsuleInput());
    const tampered = { ...capsule, contractId: 'contract-replaced' };

    expect(() => projectCanonicalCapsule(tampered, 10_000)).toThrow(CapsuleIntegrityError);
  });
});

describe('budgeted Capsule projection', () => {
  it('renders stable canonical JSON and text without truncating core fields', () => {
    const input = capsuleInput();
    const longCore = `${input.contractSummary} ${'不可压缩核心。'.repeat(80)}`;
    const capsule = createCanonicalCapsule({ ...input, contractSummary: longCore });

    const generous = projectCanonicalCapsule(capsule, 100_000);
    expect(generous.ok).toBe(true);
    if (!generous.ok) return;

    expect(generous.projection.canonicalJson).toContain(longCore);
    expect(generous.projection.canonicalJson).toBe(stableCanonicalJson(capsule));
    expect(generous.projection.text).toContain(longCore);
    expect(generous.projection.text).toContain(capsule.capsuleId);
    expect(generous.projection.text).toContain(capsule.capsuleHash);
    expect(generous.projection.text.indexOf(CAPSULE_ACK_PREFIX)).toBeLessThan(
      generous.projection.text.indexOf('CAPSULE_JSON'),
    );
    const renderedWithoutHash = generous.projection.text
      .split('\n')
      .filter((line) => !line.startsWith('PROJECTION_HASH '))
      .join('\n');
    expect(generous.projection.projectionHash).toBe(
      createHash('sha256').update(renderedWithoutHash, 'utf8').digest('hex'),
    );

    const exact = projectCanonicalCapsule(capsule, generous.projection.estimatedTokens);
    expect(exact).toEqual({
      ok: true,
      projection: {
        ...generous.projection,
        budgetTokens: generous.projection.estimatedTokens,
      },
    });
  });

  it('returns a structured failure and no partial projection when core does not fit', () => {
    const capsule = createCanonicalCapsule(capsuleInput());
    const generous = projectCanonicalCapsule(capsule, 100_000);
    expect(generous.ok).toBe(true);
    if (!generous.ok) return;

    const availableTokens = generous.projection.estimatedTokens - 1;
    const result = projectCanonicalCapsule(capsule, availableTokens);

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'CAPSULE_CORE_EXCEEDS_BUDGET',
        capsuleId: capsule.capsuleId,
        utf8Bytes: generous.projection.utf8Bytes,
        requiredTokens: generous.projection.estimatedTokens,
        availableTokens,
        shortfallTokens: 1,
        estimatorVersion: 'utf8-bytes-div-4/v1',
        allowedRecovery: [
          'SELECT_LARGER_PROFILE',
          'USER_APPROVED_CONTRACT_PARTITION',
          'ABORT_HANDOFF',
        ],
      },
    });
    expect(result).not.toHaveProperty('projection');
  });

  it('uses the documented rounded-up UTF-8 byte estimate', () => {
    expect(estimateUtf8Tokens('任务a')).toEqual({ utf8Bytes: 7, estimatedTokens: 2 });
    expect(estimateUtf8Tokens('abcde')).toEqual({ utf8Bytes: 5, estimatedTokens: 2 });
  });
});

describe('structured handoff acknowledgement', () => {
  it('extracts the exact acknowledgement from a raw output line', () => {
    const capsule = createCanonicalCapsule(capsuleInput());
    const acknowledgement = expectedAcknowledgement(capsule);

    expect(
      extractAndValidateAcknowledgement(outputLine(ackLine(acknowledgement)), capsule),
    ).toEqual({ ok: true, acknowledgement });
  });

  it('recursively extracts an acknowledgement from parsed runtime JSON', () => {
    const capsule = createCanonicalCapsule(capsuleInput());
    const acknowledgement = expectedAcknowledgement(capsule);
    const value = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: `I will acknowledge first.\n${ackLine(acknowledgement)}\n`,
          },
        ],
      },
    };

    const result = extractAndValidateAcknowledgement(
      outputLine(stableCanonicalJson(value), value),
      capsule,
    );

    expect(result).toEqual({ ok: true, acknowledgement });
  });

  it('accepts identifier arrays in a different order but rejects missing identities', () => {
    const capsule = createCanonicalCapsule(capsuleInput());
    const expected = expectedAcknowledgement(capsule);
    const reordered = {
      ...expected,
      remainingCriterionIds: [...expected.remainingCriterionIds].reverse(),
      effectIds: [...expected.effectIds].reverse(),
    };

    expect(extractAndValidateAcknowledgement(outputLine(ackLine(reordered)), capsule)).toEqual({
      ok: true,
      acknowledgement: expected,
    });

    const missing = { ...expected, effectIds: expected.effectIds.slice(1) };
    expect(extractAndValidateAcknowledgement(outputLine(ackLine(missing)), capsule)).toEqual({
      ok: false,
      error: { code: 'ACK_FIELD_MISMATCH', field: 'effectIds' },
    });
  });

  it.each([
    ['capsuleId', 'capsule-wrong'],
    ['contractId', 'contract-wrong'],
    ['checkpointId', 'checkpoint-wrong'],
  ] as const)('rejects a mismatched %s', (field, replacement) => {
    const capsule = createCanonicalCapsule(capsuleInput());
    const acknowledgement = expectedAcknowledgement(capsule);
    const mismatched = { ...acknowledgement, [field]: replacement };

    expect(extractAndValidateAcknowledgement(outputLine(ackLine(mismatched)), capsule)).toEqual({
      ok: false,
      error: { code: 'ACK_FIELD_MISMATCH', field },
    });
  });

  it('rejects extra fields, malformed JSON, and ambiguous acknowledgements', () => {
    const capsule = createCanonicalCapsule(capsuleInput());
    const acknowledgement = expectedAcknowledgement(capsule);
    const extra = { ...acknowledgement, understood: true };
    expect(
      extractAndValidateAcknowledgement(
        outputLine(`${CAPSULE_ACK_PREFIX}${stableCanonicalJson(extra)}`),
        capsule,
      ),
    ).toEqual({ ok: false, error: { code: 'ACK_UNEXPECTED_FIELD' } });

    expect(
      extractAndValidateAcknowledgement(outputLine(`${CAPSULE_ACK_PREFIX}{broken`), capsule),
    ).toEqual({ ok: false, error: { code: 'ACK_MALFORMED' } });

    const other = { ...acknowledgement, contractId: 'contract-other' };
    expect(
      extractAndValidateAcknowledgement(
        outputLine(`${ackLine(acknowledgement)}\n${ackLine(other)}`),
        capsule,
      ),
    ).toEqual({ ok: false, error: { code: 'ACK_AMBIGUOUS' } });
  });

  it('does not mistake ordinary model output for an acknowledgement', () => {
    const capsule = createCanonicalCapsule(capsuleInput());

    expect(
      extractAndValidateAcknowledgement(outputLine('I will continue the task now.'), capsule),
    ).toEqual({ ok: false, error: { code: 'ACK_NOT_FOUND' } });
  });
});
