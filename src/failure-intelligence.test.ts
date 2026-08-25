import { describe, expect, it } from 'vitest';

import {
  deriveFailureIntelligence,
  type AdapterFailureEvidenceV1,
  type ContextFreshnessEvidenceV1,
  type DiagnosticBranchOutcomeV1,
  type DiagnosticCheckpointEvidenceV1,
  type FailureIntelligenceInputV1,
  type FailureVerificationEvidenceV1,
  type WorkspaceComparisonEvidenceV1,
} from './failure-intelligence.js';
import type { RuntimeSemanticFactV1 } from './runtime-semantics.js';
import type { ToolGateRequestV1, ToolReleaseV1, ToolResultV1 } from './tool-gateway.js';

describe('Failure Intelligence', () => {
  it('runs all required deterministic detectors and spans all six failure layers', () => {
    const failedOne = toolResultFact('fact-tool-failed-1', 1, true);
    const failedTwo = toolResultFact('fact-tool-failed-2', 1, true);
    const requests = [
      request('gate-1', 'tool-use-1'),
      request('gate-2', 'tool-use-2'),
      request('gate-3', 'tool-use-3'),
    ];
    const rejected = release(requests[0]!, 'reject');
    const input: FailureIntelligenceInputV1 = {
      persistedRuntimeFacts: [failedOne, failedTwo],
      contextFreshness: [staleContext()],
      workspaceComparisons: [divergedWorkspace()],
      verifications: [verification('verification-failed', 'failed')],
      toolGateway: {
        requests,
        releases: [rejected],
        results: [toolResult(requests[1]!, 'failed', 'same-error')],
      },
      adapters: [missingAdapter()],
    };

    const graph = deriveFailureIntelligence(input);
    const detectors = new Set(graph.candidates.map((candidate) => candidate.detector));
    expect([...detectors]).toEqual(
      expect.arrayContaining([
        'loop',
        'repeated-failure',
        'stale-context',
        'permission-conflict',
        'tool-error',
        'workspace-divergence',
        'verification-failure',
      ]),
    );
    expect(
      graph.nodes
        .filter((node) => node.kind === 'layer')
        .map((node) => node.layer)
        .sort(),
    ).toEqual(['context', 'environment', 'harness', 'missionbraid', 'model', 'tool']);
    expect(graph.candidates.find((candidate) => candidate.detector === 'tool-error')?.status).toBe(
      'observed',
    );
    expect(graph.candidates.find((candidate) => candidate.detector === 'loop')?.status).toBe(
      'inferred',
    );
    expect(graph.edges.some((edge) => edge.kind === 'supports')).toBe(true);
    expect(graph.authority).toBe('derived-evidence-only');
  });

  it('promotes only deterministic single-variable evidence and downgrades when it is removed', () => {
    const baseInput: FailureIntelligenceInputV1 = {
      persistedRuntimeFacts: [toolResultFact('fact-tool-failed', 2, true)],
      checkpoint: compositeCheckpoint(),
    };
    const baseline = deriveFailureIntelligence(baseInput);
    const candidate = baseline.candidates.find((item) => item.detector === 'tool-error');
    const proposal = baseline.diagnosticBranchProposals.find(
      (item) => item.candidateId === candidate?.candidateId,
    );
    expect(candidate?.status).toBe('observed');
    expect(proposal).toMatchObject({
      execution: 'proposal-only',
      ready: true,
      changedVariable: {
        dimension: 'tool',
        key: 'tool-input-or-implementation',
      },
    });

    const decisiveOutcome: DiagnosticBranchOutcomeV1 = {
      outcomeId: 'diagnostic-outcome-1',
      candidateId: candidate!.candidateId,
      changedVariable: proposal!.changedVariable,
      preservedCheckpointDigest: compositeCheckpoint().checkpointDigest,
      evaluation: 'deterministic',
      result: 'mechanism-confirmed',
      evidenceRefs: ['branch-result-1', 'verification-pass-1'],
    };
    const confirmed = deriveFailureIntelligence({
      ...baseInput,
      diagnosticOutcomes: [decisiveOutcome],
    });
    const confirmedCandidate = confirmed.candidates.find(
      (item) => item.candidateId === candidate?.candidateId,
    );
    expect(confirmedCandidate?.status).toBe('confirmed');
    expect(confirmedCandidate?.decisiveEvidenceRefs).toContain('diagnostic-outcome-1');

    const downgraded = deriveFailureIntelligence(baseInput);
    expect(
      downgraded.candidates.find((item) => item.candidateId === candidate?.candidateId)?.status,
    ).toBe('observed');

    const modelOnly = deriveFailureIntelligence({
      ...baseInput,
      diagnosticOutcomes: [{ ...decisiveOutcome, evaluation: 'model-assisted' }],
    });
    const modelOnlyCandidate = modelOnly.candidates.find(
      (item) => item.candidateId === candidate?.candidateId,
    );
    expect(modelOnlyCandidate?.status).toBe('observed');
    expect(modelOnlyCandidate?.missingEvidence).toContain(
      'A deterministic evaluator for the diagnostic Branch outcome',
    );

    const wrongVariable = deriveFailureIntelligence({
      ...baseInput,
      diagnosticOutcomes: [
        {
          ...decisiveOutcome,
          changedVariable: { dimension: 'context', key: 'context-snapshot', operation: 'refresh' },
        },
      ],
    });
    const wrongVariableCandidate = wrongVariable.candidates.find(
      (item) => item.candidateId === candidate?.candidateId,
    );
    expect(wrongVariableCandidate?.status).toBe('observed');
    expect(wrongVariableCandidate?.missingEvidence).toContain(
      'A diagnostic outcome that changes exactly the variable proposed for this candidate',
    );
  });

  it('keeps counter-evidence and missing evidence visible instead of forcing a root cause', () => {
    const graph = deriveFailureIntelligence({
      persistedRuntimeFacts: [
        toolResultFact('fact-tool-failed', 1, true),
        toolResultFact('fact-tool-passed', 0, false),
      ],
    });
    const candidate = graph.candidates.find((item) => item.detector === 'tool-error');
    expect(candidate?.counterEvidenceRefs).toContain('fact-tool-passed');
    expect(candidate?.missingEvidence.length).toBeGreaterThan(0);
    expect(
      graph.edges.some(
        (edge) => edge.kind === 'contradicts' && edge.toNodeId === candidate?.candidateId,
      ),
    ).toBe(true);
  });

  it('returns an honest unknown when deterministic evidence cannot identify a mechanism', () => {
    const graph = deriveFailureIntelligence({ persistedRuntimeFacts: [] });
    expect(graph.candidates).toHaveLength(1);
    expect(graph.candidates[0]).toMatchObject({
      detector: 'unattributed',
      layer: 'unknown',
      status: 'unknown',
    });
    expect(graph.candidates[0]?.missingEvidence.length).toBeGreaterThan(0);
    expect(graph.diagnosticBranchProposals).toEqual([]);
  });

  it('never treats boundary-only evidence as an executable diagnostic Branch', () => {
    const graph = deriveFailureIntelligence({
      persistedRuntimeFacts: [],
      contextFreshness: [staleContext()],
      checkpoint: {
        ...compositeCheckpoint(),
        completeness: 'boundary-only',
      },
    });
    const proposal = graph.diagnosticBranchProposals.find(
      (item) => item.changedVariable.key === 'context-snapshot',
    );
    expect(proposal).toMatchObject({
      execution: 'proposal-only',
      ready: false,
      preserve: ['outcome-contract', 'all-other-observable-inputs'],
    });
    expect(proposal?.missingPreconditions).toContain(
      'The supplied boundary evidence is not a restorable composite Checkpoint',
    );
    expect(Array.isArray(proposal?.changedVariable)).toBe(false);
  });

  it('is independent of supplied array order and does not manufacture temporal causality', () => {
    const facts = [
      toolResultFact('fact-b', 1, true),
      toolResultFact('fact-a', 1, true),
      toolResultFact('fact-c', 0, false),
    ];
    const forward = deriveFailureIntelligence({ persistedRuntimeFacts: facts });
    const reverse = deriveFailureIntelligence({ persistedRuntimeFacts: [...facts].reverse() });
    expect(reverse).toEqual(forward);
    expect(forward.edges.some((edge) => (edge.kind as string) === 'causal')).toBe(false);
  });

  it('separates Harness, environment, and MissionBraid adapter failures', () => {
    const graph = deriveFailureIntelligence({
      persistedRuntimeFacts: [],
      adapters: [
        missingAdapter(),
        {
          evidenceId: 'adapter-unresponsive',
          harness: 'qoder',
          detection: detection('qoder', 'present-unresponsive'),
          evidenceRefs: ['probe-qoder'],
        },
        {
          evidenceId: 'adapter-observer',
          harness: 'claude',
          run: runtimeRunWithObserverFailure(),
          evidenceRefs: ['run-claude'],
        },
      ],
    });
    const layers = graph.candidates
      .filter((candidate) => candidate.detector === 'adapter-failure')
      .map((candidate) => candidate.layer);
    expect(layers).toEqual(expect.arrayContaining(['environment', 'harness', 'missionbraid']));
  });
});

function toolResultFact(factId: string, exitCode: number, isError: boolean): RuntimeSemanticFactV1 {
  return {
    ...factBase(factId),
    kind: 'tool_result',
    toolName: 'Bash',
    toolCallIdDigest: `sha256:${factId.padEnd(64, '0').slice(0, 64)}`,
    phase: isError ? 'failed' : 'completed',
    isError,
    exitCode,
  };
}

function factBase(factId: string) {
  return {
    schemaVersion: 1 as const,
    factId,
    sourceRuntimeEventId: `runtime-${factId}`,
    sourceHarness: 'codex',
    sourceProtocol: 'codex-jsonl',
    artifact: {
      artifactId: `artifact-${factId}`,
      sha256: 'a'.repeat(64),
      relativePath: `sha256/aa/${factId}.json`,
      mediaType: 'application/json' as const,
      byteLength: 2,
      sanitized: true as const,
      redactionCount: 0,
    },
    fidelity: 'native' as const,
    evidence: 'explicit' as const,
  };
}

function request(gateId: string, toolUseSeed: string): ToolGateRequestV1 {
  return {
    schemaVersion: 1,
    gateId,
    effectId: `effect-${gateId}`,
    toolUseIdSha256: digest(toolUseSeed),
    sessionIdSha256: digest('session-1'),
    originalInputSha256: digest('same-input'),
    requestSha256: digest(`request-${gateId}`),
    missionId: 'mission-1',
    attemptId: 'attempt-1',
    hookEventName: 'PreToolUse',
    toolName: 'Bash',
    toolInput: { command: '[SANITIZED]' },
    requestedAt: '2026-08-26T00:00:00.000Z',
  };
}

function release(requestValue: ToolGateRequestV1, decision: 'approve' | 'reject'): ToolReleaseV1 {
  return {
    schemaVersion: 1,
    releaseId: `release-${requestValue.gateId}`,
    missionId: requestValue.missionId,
    attemptId: requestValue.attemptId,
    gateId: requestValue.gateId,
    effectId: requestValue.effectId,
    requestSha256: requestValue.requestSha256,
    decisionIntentId: `intent-${requestValue.gateId}`,
    decision,
    kernelDecisionEvent: {
      eventId: `event-${requestValue.gateId}`,
      seq: 1,
      hash: 'b'.repeat(64),
      recordedAt: '2026-08-26T00:00:01.000Z',
    },
    releasedAt: '2026-08-26T00:00:02.000Z',
  };
}

function toolResult(
  requestValue: ToolGateRequestV1,
  outcome: 'succeeded' | 'failed',
  resultSeed: string,
): ToolResultV1 {
  return {
    schemaVersion: 1,
    resultId: `result-${requestValue.gateId}`,
    missionId: requestValue.missionId,
    attemptId: requestValue.attemptId,
    gateId: requestValue.gateId,
    effectId: requestValue.effectId,
    hookEventName: outcome === 'failed' ? 'PostToolUseFailure' : 'PostToolUse',
    outcome,
    resultSha256: digest(resultSeed),
    observedAt: '2026-08-26T00:00:03.000Z',
  };
}

function staleContext(): ContextFreshnessEvidenceV1 {
  return {
    evidenceId: 'context-freshness-1',
    contextFactId: 'context-fact-1',
    boundWorkspaceDigest: digest('old-workspace'),
    currentWorkspaceDigest: digest('new-workspace'),
    evidenceRefs: ['context-snapshot-1', 'workspace-snapshot-2'],
  };
}

function divergedWorkspace(): WorkspaceComparisonEvidenceV1 {
  return {
    evidenceId: 'workspace-comparison-1',
    boundaryId: 'checkpoint-boundary-1',
    expectedWorkspaceDigest: digest('expected'),
    observedWorkspaceDigest: digest('observed'),
    evidenceRefs: ['workspace-before', 'workspace-after'],
  };
}

function verification(
  evidenceId: string,
  status: 'passed' | 'failed' | 'inconclusive',
): FailureVerificationEvidenceV1 {
  return {
    evidenceId,
    criterionId: 'criterion-tests',
    result: {
      criterionId: 'criterion-tests',
      status,
      evidenceRefs: [evidenceId],
    },
    evidenceRefs: [evidenceId],
  };
}

function missingAdapter(): AdapterFailureEvidenceV1 {
  return {
    evidenceId: 'adapter-missing',
    harness: 'codex',
    detection: detection('codex', 'missing'),
    evidenceRefs: ['probe-codex'],
  };
}

function detection(
  runtime: 'codex' | 'qoder' | 'claude',
  status: 'ready' | 'present-unresponsive' | 'present-error' | 'missing',
) {
  return {
    runtime,
    command: runtime,
    executablePath: status === 'missing' ? null : `/opt/bin/${runtime}`,
    available: status !== 'missing',
    responsive: status === 'ready',
    status,
    version: status === 'missing' ? null : '1.0.0',
    versionSource: status === 'missing' ? null : ('output' as const),
    checkedAt: '2026-08-26T00:00:00.000Z',
    durationMs: 1,
    probeExitCode: status === 'ready' ? 0 : null,
    probeSignal: null,
  } as const;
}

function runtimeRunWithObserverFailure() {
  return {
    runtime: 'claude' as const,
    outputProtocol: 'claude-stream-json' as const,
    process: {
      invocation: { command: 'claude', args: [], cwd: '/tmp/workspace' },
      pid: 1,
      exitCode: 1,
      signal: null,
      startedAt: '2026-08-26T00:00:00.000Z',
      endedAt: '2026-08-26T00:00:01.000Z',
      durationMs: 1_000,
      aborted: false,
      stdoutLineCount: 0,
      stderrLineCount: 0,
      observerError: { name: 'Error', message: 'observer failed' },
    },
  };
}

function compositeCheckpoint(): DiagnosticCheckpointEvidenceV1 {
  return {
    checkpointId: 'checkpoint-composite-1',
    checkpointDigest: digest('checkpoint-composite-1'),
    completeness: 'composite',
    evidenceRefs: ['checkpoint-event-1'],
  };
}

function digest(value: string): string {
  return value
    .padEnd(64, '0')
    .slice(0, 64)
    .replaceAll(/[^a-f0-9]/g, 'a');
}
