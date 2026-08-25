import { describe, expect, it } from 'vitest';

import {
  createCompositeCheckpoint,
  type CheckpointInterventionV1,
  type CompositeCheckpointInputV1,
  type CompositeCheckpointManifestV1,
} from './composite-checkpoint.js';
import type { ContextGraphV1 } from './context-graph.js';
import {
  DOMAIN_SCHEMA_VERSION,
  type EffectV1,
  type EventV1,
  type JsonValue,
  type ReceiptV1,
  type StoredEventV1,
} from './domain.js';
import { EXECUTION_FORK_SCHEMA_VERSION, type ExecutionForkRecordV1 } from './execution-fork.js';
import type { DiagnosticVariableV1 } from './failure-intelligence.js';
import {
  deriveMissionFailureIntelligence,
  MissionFailureIntelligenceProjectionError,
  projectDiagnosticBranchOutcome,
  projectMissionFailureIntelligenceInput,
  type BoundAdapterFailureEvidenceV1,
} from './mission-failure-intelligence.js';
import type { RuntimeSemanticFactV1 } from './runtime-semantics.js';
import type { RuntimeDetection, RuntimeRunResult } from './adapters/types.js';
import { computeEventHash, hashPayload } from './store.js';

const MISSION_ID = 'mission-failure-bridge';
const ROOT_BRANCH_ID = 'branch-root';
const CHILD_BRANCH_ID = 'branch-child';
const ATTEMPT_ID = 'attempt-root';
const CHILD_ATTEMPT_ID = 'attempt-child';
const CONTRACT_ID = 'contract-failure-bridge';

describe('Mission Failure Intelligence bridge', () => {
  it('projects only direct evidence from the selected Branch and keeps uncertainty explicit', () => {
    const directFailure = runtimeEvent(
      'runtime-root-tool-failure',
      ROOT_BRANCH_ID,
      ATTEMPT_ID,
      'native',
      'explicit',
      {
        kind: 'tool_result',
        phase: 'failed',
        toolName: 'fixture-tool',
        isError: true,
        exitCode: 1,
      },
    );
    const derivedFailure = runtimeEvent(
      'runtime-root-derived-failure',
      ROOT_BRANCH_ID,
      ATTEMPT_ID,
      'derived',
      'derived',
      { kind: 'failure', failureKind: 'model', isError: true },
    );
    const otherBranchFailure = runtimeEvent(
      'runtime-child-tool-failure',
      CHILD_BRANCH_ID,
      CHILD_ATTEMPT_ID,
      'native',
      'explicit',
      {
        kind: 'tool_result',
        phase: 'failed',
        toolName: 'child-only-tool',
        isError: true,
        exitCode: 8,
      },
    );
    const events = stored([
      missionCreated(),
      attemptStarted(ATTEMPT_ID, ROOT_BRANCH_ID),
      attemptStarted(CHILD_ATTEMPT_ID, CHILD_BRANCH_ID),
      directFailure,
      derivedFailure,
      otherBranchFailure,
      observation('verification-failed', 'verification.completed', {
        criterionId: 'criterion-output',
        passed: false,
        invocationDigest: 'sha256:verify-command',
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdoutSha256: 'sha256:stdout',
        stdoutBytes: 0,
        stderrSha256: 'sha256:stderr',
        stderrBytes: 0,
      }),
      observation('workspace-diverged', 'failure.observed', {
        classification: 'observed',
        layer: 'workspace-continuity',
        code: 'WORKSPACE_DIVERGED',
        checkpointId: 'checkpoint-before',
        expectedWorkspaceDigest: 'sha256:workspace-before',
        observedWorkspaceDigest: 'sha256:workspace-after',
      }),
      observation('tool-request', 'tool.gate.requested', toolRequest()),
      observation('tool-rejection-intent', 'tool.gate.decided', toolIntent()),
      observation('tool-result', 'tool.gate.result', toolResult()),
      observation('process-finished', 'runtime.process_finished', {
        attemptId: ATTEMPT_ID,
        stageId: 'stage-root',
        harness: 'codex',
        exitCode: 1,
        signal: null,
        aborted: false,
      }),
    ]);

    const projection = deriveMissionFailureIntelligence({
      missionId: MISSION_ID,
      branchId: ROOT_BRANCH_ID,
      events: [...events].reverse(),
      contextGraph: contextGraph(),
    });

    expect(
      projection.failureIntelligenceInput.persistedRuntimeFacts.map((fact) => fact.factId),
    ).toEqual(['fact-runtime-root-tool-failure']);
    expect(
      projection.failureIntelligenceInput.contextGraph?.nodes.map((node) => node.nodeId),
    ).toEqual(['node-runtime-root']);
    expect(projection.failureIntelligenceInput.contextGraph?.contextDiffs).toEqual([]);
    expect(projection.failureIntelligenceInput.verifications).toHaveLength(1);
    expect(projection.failureIntelligenceInput.workspaceComparisons).toEqual([
      expect.objectContaining({
        boundaryId: 'checkpoint-before',
        expectedWorkspaceDigest: 'sha256:workspace-before',
        observedWorkspaceDigest: 'sha256:workspace-after',
      }),
    ]);
    expect(projection.failureIntelligenceInput.toolGateway).toMatchObject({
      requests: [expect.objectContaining({ gateId: 'gate-root' })],
      decisionIntents: [expect.objectContaining({ decision: 'reject' })],
      results: [expect.objectContaining({ outcome: 'failed' })],
    });
    expect(projection.failureIntelligenceInput.toolGateway?.releases).toBeUndefined();
    expect(projection.unavailable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'semantic-fact-derived', status: 'inferred' }),
        expect.objectContaining({
          kind: 'process-failure-without-adapter-record',
          layer: 'harness',
          status: 'observed',
        }),
        expect.objectContaining({ kind: 'context-evidence-outside-branch', status: 'unknown' }),
      ]),
    );
    expect(
      projection.graph.candidates.find((candidate) => candidate.detector === 'tool-error'),
    ).toMatchObject({ layer: 'tool', status: 'observed' });
    expect(
      projection.graph.candidates.find(
        (candidate) => candidate.detector === 'verification-failure',
      ),
    ).toMatchObject({ layer: 'missionbraid', status: 'observed' });
    expect(
      projection.graph.candidates.find(
        (candidate) => candidate.detector === 'workspace-divergence',
      ),
    ).toMatchObject({ layer: 'environment', status: 'observed' });
    expect(
      projection.graph.candidates.find((candidate) => candidate.detector === 'permission-conflict'),
    ).toMatchObject({ status: 'unknown' });
    expect(
      projection.graph.candidates.some((candidate) => candidate.title.includes('child-only-tool')),
    ).toBe(false);
    expect(
      projection.graph.nodes
        .filter((node) => node.kind === 'layer')
        .map((node) => node.layer)
        .sort(),
    ).toEqual(['context', 'environment', 'harness', 'missionbraid', 'model', 'tool']);
  });

  it('rebuilds deterministically and rejects a corrupt Kernel chain or conflicting fact identity', () => {
    const first = runtimeEvent(
      'runtime-conflict-a',
      ROOT_BRANCH_ID,
      ATTEMPT_ID,
      'native',
      'explicit',
      { kind: 'tool_result', phase: 'failed', toolName: 'one', isError: true },
      'fact-conflict',
    );
    const second = runtimeEvent(
      'runtime-conflict-b',
      ROOT_BRANCH_ID,
      ATTEMPT_ID,
      'native',
      'explicit',
      { kind: 'tool_result', phase: 'failed', toolName: 'two', isError: true },
      'fact-conflict',
    );
    const events = stored([
      missionCreated(),
      attemptStarted(ATTEMPT_ID, ROOT_BRANCH_ID),
      first,
      second,
    ]);
    const forward = deriveMissionFailureIntelligence({
      missionId: MISSION_ID,
      branchId: ROOT_BRANCH_ID,
      events,
    });
    const reverse = deriveMissionFailureIntelligence({
      missionId: MISSION_ID,
      branchId: ROOT_BRANCH_ID,
      events: [...events].reverse(),
    });
    expect(reverse).toEqual(forward);
    expect(forward.failureIntelligenceInput.persistedRuntimeFacts).toEqual([]);
    expect(forward.unavailable).toContainEqual(
      expect.objectContaining({ kind: 'semantic-fact-invalid', status: 'unknown' }),
    );
    expect(forward.graph.candidates).toEqual([
      expect.objectContaining({ detector: 'unattributed', status: 'unknown' }),
    ]);

    const corrupt = events.map((event, index) =>
      index === events.length - 1 ? { ...event, payloadHash: 'sha256:corrupt' } : event,
    );
    expect(() =>
      projectMissionFailureIntelligenceInput({
        missionId: MISSION_ID,
        branchId: ROOT_BRANCH_ID,
        events: corrupt,
      }),
    ).toThrow(MissionFailureIntelligenceProjectionError);
  });

  it('marks only a complete recoverable Composite Checkpoint as diagnostic-composite', () => {
    const events = stored([missionCreated(), attemptStarted(ATTEMPT_ID, ROOT_BRANCH_ID)]);
    const complete = checkpoint(events.at(-1)!.hash);
    const completeProjection = deriveMissionFailureIntelligence({
      missionId: MISSION_ID,
      branchId: ROOT_BRANCH_ID,
      events,
      checkpoint: complete,
    });
    expect(completeProjection.failureIntelligenceInput.checkpoint).toMatchObject({
      checkpointId: complete.checkpointId,
      checkpointDigest: complete.manifestHash,
      completeness: 'composite',
    });

    const digestOnly = checkpoint(events.at(-1)!.hash, { workspace: 'digest-only' });
    const boundaryProjection = deriveMissionFailureIntelligence({
      missionId: MISSION_ID,
      branchId: ROOT_BRANCH_ID,
      events,
      checkpoint: digestOnly,
    });
    expect(boundaryProjection.failureIntelligenceInput.checkpoint?.completeness).toBe(
      'boundary-only',
    );
    expect(boundaryProjection.unavailable).toContainEqual(
      expect.objectContaining({ kind: 'diagnostic-checkpoint-incomplete', status: 'unknown' }),
    );

    const unresolved = checkpoint(events.at(-1)!.hash, { effectStatus: 'ambiguous' });
    expect(
      deriveMissionFailureIntelligence({
        missionId: MISSION_ID,
        branchId: ROOT_BRANCH_ID,
        events,
        checkpoint: unresolved,
      }).failureIntelligenceInput.checkpoint?.completeness,
    ).toBe('boundary-only');
  });

  it('uses an exact sanitized Adapter record when bound and never fabricates detection from catalog data', () => {
    const catalog = runtimeCatalogObserved();
    const process = observation('process-failed-adapter', 'runtime.process_finished', {
      attemptId: ATTEMPT_ID,
      stageId: 'stage-root',
      harness: 'codex',
      exitCode: 2,
      signal: null,
      aborted: false,
    });
    const events = stored([
      missionCreated(),
      attemptStarted(ATTEMPT_ID, ROOT_BRANCH_ID),
      catalog,
      process,
    ]);
    const bound: BoundAdapterFailureEvidenceV1[] = [
      {
        sanitized: true,
        sourceEventIds: ['catalog-missing'],
        evidence: {
          evidenceId: 'adapter-codex-missing',
          harness: 'codex',
          detection: detection('missing'),
          evidenceRefs: ['probe:codex'],
        },
      },
      {
        sanitized: true,
        sourceEventIds: ['process-failed-adapter'],
        evidence: {
          evidenceId: 'adapter-codex-run',
          harness: 'codex',
          run: runtimeRun(2),
          evidenceRefs: ['run:codex'],
        },
      },
    ];
    const withExactEvidence = deriveMissionFailureIntelligence({
      missionId: MISSION_ID,
      branchId: ROOT_BRANCH_ID,
      events,
      adapterEvidence: bound,
    });
    expect(withExactEvidence.failureIntelligenceInput.adapters).toHaveLength(2);
    expect(
      withExactEvidence.graph.candidates.filter(
        (candidate) => candidate.detector === 'adapter-failure',
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: 'environment', status: 'observed' }),
        expect.objectContaining({ layer: 'harness', status: 'observed' }),
      ]),
    );
    expect(
      withExactEvidence.unavailable.some(
        (item) => item.kind === 'process-failure-without-adapter-record',
      ),
    ).toBe(false);

    const withoutExactEvidence = deriveMissionFailureIntelligence({
      missionId: MISSION_ID,
      branchId: ROOT_BRANCH_ID,
      events,
    });
    expect(withoutExactEvidence.failureIntelligenceInput.adapters).toBeUndefined();
    expect(withoutExactEvidence.unavailable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'adapter-detection-unavailable',
          status: 'observed',
        }),
        expect.objectContaining({
          kind: 'process-failure-without-adapter-record',
          status: 'observed',
        }),
      ]),
    );
    expect(
      withoutExactEvidence.graph.candidates.some(
        (candidate) => candidate.detector === 'adapter-failure',
      ),
    ).toBe(false);
  });

  it('confirms only a same-Checkpoint single-variable Fork with deterministic Kernel Receipt evidence', () => {
    const failedRuntime = runtimeEvent(
      'runtime-diagnostic-source',
      ROOT_BRANCH_ID,
      ATTEMPT_ID,
      'native',
      'explicit',
      {
        kind: 'tool_result',
        phase: 'failed',
        toolName: 'diagnostic-tool',
        isError: true,
      },
    );
    const prefix = stored([
      missionCreated(),
      attemptStarted(ATTEMPT_ID, ROOT_BRANCH_ID),
      failedRuntime,
    ]);
    const parentCheckpoint = checkpoint(prefix.at(-1)!.hash, { throughSeq: 3 });
    const baseline = deriveMissionFailureIntelligence({
      missionId: MISSION_ID,
      branchId: ROOT_BRANCH_ID,
      events: prefix,
      checkpoint: parentCheckpoint,
    });
    const candidate = baseline.graph.candidates.find((item) => item.detector === 'tool-error')!;
    const changedVariable = baseline.graph.diagnosticBranchProposals.find(
      (item) => item.candidateId === candidate.candidateId,
    )!.changedVariable;
    const fork = executionFork(parentCheckpoint, changedVariable);
    const receipt = verifiedReceipt(prefix.at(-1)!.hash);
    const allEvents = stored([
      missionCreated(),
      attemptStarted(ATTEMPT_ID, ROOT_BRANCH_ID),
      failedRuntime,
      receiptIssued(receipt),
    ]);

    const outcome = projectDiagnosticBranchOutcome({
      candidateId: candidate.candidateId,
      changedVariable,
      fork,
      evaluation: 'deterministic',
      receiptEventId: 'receipt-issued-child',
      evaluationEvidenceRefs: ['verification:diagnostic'],
      events: allEvents,
      checkpoint: parentCheckpoint,
    });
    expect(outcome).toMatchObject({
      candidateId: candidate.candidateId,
      preservedCheckpointDigest: parentCheckpoint.manifestHash,
      evaluation: 'deterministic',
      result: 'mechanism-confirmed',
    });

    const confirmed = deriveMissionFailureIntelligence({
      missionId: MISSION_ID,
      branchId: ROOT_BRANCH_ID,
      events: allEvents,
      checkpoint: parentCheckpoint,
      diagnosticForks: [
        {
          candidateId: candidate.candidateId,
          changedVariable,
          fork,
          evaluation: 'deterministic',
          receiptEventId: 'receipt-issued-child',
          evaluationEvidenceRefs: ['verification:diagnostic'],
        },
      ],
    });
    expect(
      confirmed.graph.candidates.find((item) => item.candidateId === candidate.candidateId)?.status,
    ).toBe('confirmed');

    const receiptRemoved = deriveMissionFailureIntelligence({
      missionId: MISSION_ID,
      branchId: ROOT_BRANCH_ID,
      events: prefix,
      checkpoint: parentCheckpoint,
      diagnosticForks: [
        {
          candidateId: candidate.candidateId,
          changedVariable,
          fork,
          evaluation: 'deterministic',
          receiptEventId: 'receipt-issued-child',
          evaluationEvidenceRefs: ['verification:diagnostic'],
        },
      ],
    });
    expect(receiptRemoved.failureIntelligenceInput.diagnosticOutcomes).toEqual([
      expect.objectContaining({ result: 'inconclusive' }),
    ]);
    expect(
      receiptRemoved.graph.candidates.find((item) => item.candidateId === candidate.candidateId)
        ?.status,
    ).toBe('observed');

    expect(
      projectDiagnosticBranchOutcome({
        candidateId: candidate.candidateId,
        changedVariable,
        fork,
        evaluation: 'model-assisted',
        receiptEventId: 'receipt-issued-child',
        evaluationEvidenceRefs: ['verification:diagnostic'],
        events: allEvents,
        checkpoint: parentCheckpoint,
      }).result,
    ).toBe('inconclusive');
  });
});

function missionCreated(): EventV1 {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId: 'mission-created',
    missionId: MISSION_ID,
    occurredAt: at(0),
    type: 'mission.created',
    payload: {
      mission: {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        missionId: MISSION_ID,
        title: 'Diagnose one Agent failure',
        workspaceKey: 'workspace-root',
        contractId: CONTRACT_ID,
        initialProfileId: 'profile-root',
        rootBranchId: ROOT_BRANCH_ID,
        status: 'running',
        createdAt: at(0),
      },
      contract: {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        contractId: CONTRACT_ID,
        objective: 'Produce the declared output.',
        acceptanceCriteria: [
          {
            criterionId: 'criterion-output',
            description: 'The output is verified.',
            verifier: { kind: 'command', configuration: {} },
          },
        ],
        createdAt: at(0),
      },
      profile: profile(),
    },
  };
}

function attemptStarted(attemptId: string, branchId: string): EventV1 {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId: `attempt-started-${attemptId}`,
    missionId: MISSION_ID,
    attemptId,
    occurredAt: at(attemptId === ATTEMPT_ID ? 1 : 2),
    type: 'attempt.started',
    payload: {
      attempt: {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        attemptId,
        missionId: MISSION_ID,
        branchId,
        profileId: 'profile-root',
        status: 'running',
        startedAt: at(1),
      },
    },
  };
}

type FactDetails =
  | {
      readonly kind: 'tool_result';
      readonly phase: 'failed' | 'completed';
      readonly toolName: string;
      readonly isError: boolean;
      readonly exitCode?: number;
    }
  | {
      readonly kind: 'failure';
      readonly failureKind: 'model' | 'tool' | 'runtime';
      readonly isError: true;
    };

function runtimeEvent(
  runtimeEventId: string,
  branchId: string,
  attemptId: string,
  fidelity: 'native' | 'derived' | 'opaque',
  evidence: 'explicit' | 'derived' | 'unknown',
  details: FactDetails,
  factId = `fact-${runtimeEventId}`,
): EventV1 {
  const artifact = {
    artifactId: `artifact-${runtimeEventId}`,
    sha256: `sha256:${runtimeEventId}`,
    relativePath: `native/${runtimeEventId}.json`,
    mediaType: 'application/json' as const,
    byteLength: 24,
    sanitized: true as const,
    redactionCount: 0,
  };
  const fact = {
    schemaVersion: 1,
    factId,
    sourceRuntimeEventId: runtimeEventId,
    sourceHarness: 'codex',
    sourceProtocol: 'codex-jsonl',
    artifact,
    fidelity,
    evidence,
    ...details,
  } satisfies RuntimeSemanticFactV1;
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId: runtimeEventId,
    missionId: MISSION_ID,
    attemptId,
    occurredAt: at(3),
    type: 'runtime.event',
    payload: {
      event: {
        runtimeEventId,
        missionId: MISSION_ID,
        branchId,
        attemptId,
        bindingId: `binding-${attemptId}`,
        planNodeId: 'stage-root',
        sourceHarness: 'codex',
        sourceProtocol: 'codex-jsonl',
        sourceId: `source-${attemptId}`,
        sourceSequence: 1,
        nativeEventType: 'fixture',
        semanticKind: details.kind === 'failure' ? 'failure' : 'tool',
        causalParentIds: [],
        correlationIds: [],
        observedAt: at(3),
        fidelity,
        normalized: { semanticFacts: [fact] } as unknown as JsonValue,
        nativeArtifact: artifact,
      },
    },
  };
}

function observation(eventId: string, kind: string, data: JsonValue): EventV1 {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId,
    missionId: MISSION_ID,
    attemptId: ATTEMPT_ID,
    occurredAt: at(4),
    type: 'runtime.observation',
    payload: { kind, data },
  };
}

function toolRequest(): JsonValue {
  return {
    schemaVersion: 1,
    gateId: 'gate-root',
    effectId: 'effect-tool-root',
    toolUseIdSha256: 'sha256:tool-use',
    sessionIdSha256: 'sha256:session',
    originalInputSha256: 'sha256:input',
    requestSha256: 'sha256:request',
    missionId: MISSION_ID,
    attemptId: ATTEMPT_ID,
    hookEventName: 'PreToolUse',
    toolName: 'fixture-tool',
    toolInput: { pathDigest: 'sha256:path' },
    requestedAt: at(4),
  };
}

function toolIntent(): JsonValue {
  return {
    schemaVersion: 1,
    decisionIntentId: 'decision-intent-root',
    missionId: MISSION_ID,
    attemptId: ATTEMPT_ID,
    gateId: 'gate-root',
    effectId: 'effect-tool-root',
    expectedRequestSha256: 'sha256:request',
    decision: 'reject',
    createdAt: at(4),
  };
}

function toolResult(): JsonValue {
  return {
    schemaVersion: 1,
    resultId: 'tool-result-root',
    missionId: MISSION_ID,
    attemptId: ATTEMPT_ID,
    gateId: 'gate-root',
    effectId: 'effect-tool-root',
    hookEventName: 'PostToolUseFailure',
    outcome: 'failed',
    resultSha256: 'sha256:tool-result',
    observedAt: at(4),
  };
}

function contextGraph(): ContextGraphV1 {
  return {
    schemaVersion: 1,
    authority: 'derived-evidence-only',
    runtimeEventCount: 2,
    nativeArtifactCount: 2,
    nodes: [
      {
        nodeId: 'node-runtime-root',
        kind: 'runtime-event',
        label: 'root',
        runtimeEventId: 'runtime-root-tool-failure',
        evidenceRefs: ['runtime-root-tool-failure'],
      },
      {
        nodeId: 'node-runtime-child',
        kind: 'runtime-event',
        label: 'child',
        runtimeEventId: 'runtime-child-tool-failure',
        evidenceRefs: ['runtime-child-tool-failure'],
      },
    ],
    edges: [],
    contextDiffs: [
      {
        diffId: 'diff-cross-branch',
        sourceId: 'source-shared',
        fromRuntimeEventId: 'runtime-root-tool-failure',
        toRuntimeEventId: 'runtime-child-tool-failure',
        basis: 'adjacent-native-source-sequence',
        added: [],
        removed: [],
        retained: [],
      },
    ],
    unavailable: [],
  };
}

function profile() {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    profileId: 'profile-root',
    harness: 'codex',
    model: 'fixture-model',
    permissionMode: 'workspace-write',
    capabilities: ['observe', 'workspace-write'],
    configurationDigest: 'sha256:profile-root',
  } as const;
}

function checkpoint(
  headHash: string,
  options: {
    readonly workspace?: 'restorable' | 'digest-only';
    readonly effectStatus?: EffectV1['status'];
    readonly throughSeq?: number;
  } = {},
): CompositeCheckpointManifestV1 {
  const created = missionCreated();
  if (created.type !== 'mission.created') return never();
  const effectStatus = options.effectStatus ?? 'confirmed';
  const effects: EffectV1[] =
    options.effectStatus === undefined
      ? []
      : [
          {
            schemaVersion: DOMAIN_SCHEMA_VERSION,
            effectId: 'effect-external',
            missionId: MISSION_ID,
            attemptId: ATTEMPT_ID,
            kind: 'external.fixture',
            resourceKey: 'fixture:external',
            controlLevel: 'guarded',
            scope: 'mission_global_external',
            status: effectStatus,
            authorityRef: 'grant:fixture',
            idempotencyKey: 'fixture:once',
            evidenceRefs: ['effect:fixture'],
            createdAt: at(1),
          },
        ];
  const input: CompositeCheckpointInputV1 = {
    mission: created.payload.mission,
    branch: {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      branchId: ROOT_BRANCH_ID,
      missionId: MISSION_ID,
      status: 'active',
      createdAt: at(0),
    },
    attempt: {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      attemptId: ATTEMPT_ID,
      missionId: MISSION_ID,
      branchId: ROOT_BRANCH_ID,
      profileId: 'profile-root',
      status: 'failed',
      startedAt: at(1),
      endedAt: at(5),
    },
    contract: created.payload.contract,
    profile: profile(),
    eventPrefix: {
      throughSeq: options.throughSeq ?? 2,
      headHash,
      evidenceRefs: [`kernel-head:${headHash}`],
    },
    visibleContext: {
      status: 'captured',
      contextDigest: 'sha256:context-root',
      artifactRefs: ['artifact:context-root'],
      evidenceRefs: ['runtime:context-root'],
    },
    workspace:
      options.workspace === 'digest-only'
        ? {
            kind: 'git-digest',
            workspaceKey: 'workspace-root',
            snapshot: {
              schemaVersion: 1,
              workspaceRoot: '/fixture/workspace',
              workspaceDigest: 'sha256:workspace-root',
              statusDigest: 'sha256:status-root',
              head: 'fixture-head',
              status: [],
              paths: [],
              capturedAt: at(5),
            },
            evidenceRefs: ['git:workspace-root'],
          }
        : {
            kind: 'restorable-artifact',
            workspaceKey: 'workspace-root',
            workspaceDigest: 'sha256:workspace-root',
            artifactRef: 'git-commit:fixture-head',
            artifactDigest: 'git-tree:fixture-tree',
            evidenceRefs: ['git:fixture-head'],
          },
    permissions: {
      permissionMode: 'workspace-write',
      authorityRef: 'grant:workspace',
      evidenceRefs: ['profile:profile-root'],
    },
    effects,
    process: {
      status: 'stopped',
      stoppedAt: at(5),
      exitCode: 1,
      evidenceRefs: ['process:stopped'],
    },
    nativeSession: {
      status: 'unavailable',
      harness: 'codex',
      reason: 'No native session is required for the fixture.',
      evidenceRefs: ['runtime:session-unavailable'],
    },
    capturedAt: at(6),
  };
  return createCompositeCheckpoint(input);
}

function runtimeCatalogObserved(): EventV1 {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId: 'catalog-missing',
    missionId: MISSION_ID,
    occurredAt: at(2),
    type: 'runtime.catalog_observed',
    payload: {
      observation: {
        observationId: 'catalog-observation-codex',
        harness: 'codex',
        executablePath: null,
        availability: 'missing',
        version: null,
        authentication: { status: 'unknown', reason: 'not observed' },
        quota: { status: 'unknown', reason: 'not observed' },
        cost: { status: 'unknown', reason: 'not observed' },
        observedAt: at(2),
      },
    },
  };
}

function detection(status: RuntimeDetection['status']): RuntimeDetection {
  return {
    runtime: 'codex',
    command: 'codex',
    executablePath: null,
    available: false,
    responsive: false,
    status,
    version: null,
    versionSource: null,
    checkedAt: at(2),
    durationMs: 1,
    probeExitCode: null,
    probeSignal: null,
  };
}

function runtimeRun(exitCode: number): RuntimeRunResult {
  return {
    runtime: 'codex',
    outputProtocol: 'codex-jsonl',
    process: {
      invocation: { command: 'codex', args: [], cwd: '/fixture/workspace' },
      pid: 42,
      exitCode,
      signal: null,
      startedAt: at(2),
      endedAt: at(3),
      durationMs: 1_000,
      aborted: false,
      stdoutLineCount: 1,
      stderrLineCount: 0,
    },
  };
}

function executionFork(
  parent: CompositeCheckpointManifestV1,
  changedVariable: DiagnosticVariableV1,
): ExecutionForkRecordV1 {
  const intervention: CheckpointInterventionV1 = {
    interventionId: 'intervention-diagnostic-tool',
    kind: 'tool-result',
    targetRef: changedVariable.key,
    beforeDigest: 'sha256:tool-before',
    afterDigest: 'sha256:tool-after',
    description: 'Replace only the failed tool result.',
    authorityChange: 'unchanged',
  };
  const lineage = {
    schemaVersion: EXECUTION_FORK_SCHEMA_VERSION,
    lineageId: 'lineage-diagnostic-child',
    forkId: 'fork-diagnostic-child',
    mode: 'execution-fork' as const,
    missionId: MISSION_ID,
    contractId: CONTRACT_ID,
    profileId: 'profile-root',
    parentAttemptId: ATTEMPT_ID,
    parentBranchId: ROOT_BRANCH_ID,
    childBranchId: CHILD_BRANCH_ID,
    parentCheckpointId: parent.checkpointId,
    parentEventPrefix: { ...parent.eventPrefix },
    intervention,
    repositoryRoot: '/fixture/repository',
    isolatedWorktreePath: '/fixture/child',
    gitBranchName: 'missionbraid/diagnostic-child',
    baseCommit: 'fixture-head',
    baseTree: 'fixture-tree',
    childWorkspaceKey: 'workspace-child',
    inheritedExternalEffectFrontier: [...parent.externalEffectFrontier],
    externalEffectDecisions: [],
    createdAt: at(7),
  };
  const plan = {
    schemaVersion: 'missionbraid.dev/checkpoint-operation/v1' as const,
    mode: 'execution-fork' as const,
    planId: 'checkpoint-operation-diagnostic-child',
    parentCheckpointId: parent.checkpointId,
    parentBranchId: ROOT_BRANCH_ID,
    inheritedExternalEffectFrontier: [...parent.externalEffectFrontier],
    semantics: {
      createsBranch: true,
      producesNewEvidence: true,
      modelExecution: 'live',
      toolExecution: 'live',
      workspaceUse: 'isolated-writable',
      sourceHistory: 'immutable',
    } as const,
    childBranchId: CHILD_BRANCH_ID,
    intervention,
    isolatedWorktree: {
      worktreeId: 'worktree-diagnostic-child',
      workspaceKey: 'workspace-child',
      absolutePath: '/fixture/child',
      isolationMechanism: 'git-worktree' as const,
      baselineWorkspaceDigest: parent.workspace.workspaceDigest!,
      evidenceRefs: ['git:diagnostic-child'],
    },
    externalEffectDecisions: [],
  };
  return {
    forkId: 'fork-diagnostic-child',
    phase: 'finished',
    lineage,
    plan,
    events: [],
    runtimeEvidence: [
      {
        evidenceId: 'fork-verification-evidence',
        kind: 'verification',
        observedAt: at(8),
        contentDigest: 'sha256:verification-diagnostic',
        evidenceRefs: ['verification:diagnostic'],
      },
    ],
    runtimeResult: {
      runtimeRunId: 'runtime-run-diagnostic-child',
      status: 'completed',
      toolExecutionEvidenceRefs: ['tool:diagnostic'],
      verificationEvidenceRefs: ['verification:diagnostic'],
      unresolvedItems: [],
    },
    receiptInput: {
      schemaVersion: EXECUTION_FORK_SCHEMA_VERSION,
      receiptInputId: 'receipt-input-diagnostic-child',
      forkId: 'fork-diagnostic-child',
      missionId: MISSION_ID,
      contractId: CONTRACT_ID,
      parentBranchId: ROOT_BRANCH_ID,
      childBranchId: CHILD_BRANCH_ID,
      parentCheckpointId: parent.checkpointId,
      runtimeRunId: 'runtime-run-diagnostic-child',
      runtimeStatus: 'completed',
      intervention,
      inheritedExternalEffectFrontier: [...parent.externalEffectFrontier],
      externalEffectDecisions: [],
      workspaceEffectInput: {
        effectId: 'effect-workspace-diagnostic-child',
        kind: 'workspace.execution-fork',
        resourceKey: 'workspace-child',
        scope: 'branch_local_workspace',
        controlLevel: 'enforced',
        status: 'executed',
        beforeWorkspaceDigest: parent.workspace.workspaceDigest!,
        afterWorkspaceDigest: 'sha256:workspace-child',
        evidenceRefs: ['git:diagnostic-child'],
      },
      futureEvidenceRefs: ['tool:diagnostic', 'verification:diagnostic'],
      toolExecutionEvidenceRefs: ['tool:diagnostic'],
      verificationEvidenceRefs: ['verification:diagnostic'],
      unresolvedItems: [],
      generatedAt: at(9),
      authority: 'receipt-input-not-kernel-state',
    },
    cleaned: false,
  };
}

function verifiedReceipt(verifiedHeadHash: string): ReceiptV1 {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    receiptId: 'receipt-diagnostic-child',
    missionId: MISSION_ID,
    contractId: CONTRACT_ID,
    branchId: CHILD_BRANCH_ID,
    outcome: 'verified',
    verifications: [
      {
        criterionId: 'criterion-output',
        status: 'passed',
        evidenceRefs: ['verification:diagnostic'],
      },
    ],
    verifiedHeadHash,
    verifiedThroughSeq: 3,
    attemptIds: [CHILD_ATTEMPT_ID],
    unresolvedItems: [],
    issuedAt: at(10),
  };
}

function receiptIssued(receipt: ReceiptV1): EventV1 {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId: 'receipt-issued-child',
    missionId: MISSION_ID,
    attemptId: CHILD_ATTEMPT_ID,
    occurredAt: at(10),
    type: 'receipt.issued',
    payload: { receipt },
  };
}

function stored(events: readonly EventV1[]): StoredEventV1[] {
  let previousHash: string | null = null;
  return events.map((event, index) => {
    const seq = index + 1;
    const recordedAt = new Date(Date.parse(event.occurredAt) + 100).toISOString();
    const payloadHash = hashPayload(event.payload);
    const hash = computeEventHash({
      schemaVersion: event.schemaVersion,
      eventId: event.eventId,
      missionId: event.missionId,
      attemptId: event.attemptId ?? null,
      seq,
      type: event.type,
      occurredAt: event.occurredAt,
      recordedAt,
      payloadHash,
      prevHash: previousHash,
    });
    const result: StoredEventV1 = {
      ...event,
      seq,
      recordedAt,
      payloadHash,
      prevHash: previousHash,
      hash,
    };
    previousHash = hash;
    return result;
  });
}

function at(offsetSeconds: number): string {
  return new Date(Date.parse('2026-08-26T00:00:00.000Z') + offsetSeconds * 1_000).toISOString();
}

function never(): never {
  throw new Error('unreachable fixture branch');
}
