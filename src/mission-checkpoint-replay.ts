import type {
  CachedContextBundleV1,
  CachedFutureEvidenceKindV1,
  CachedReplaySourceBundleV1,
  CheckpointReplayRecordV1,
  ReplayArtifactRefV1,
  ReplayInterventionArtifactV1,
} from './checkpoint-replay.js';
import { createCachedContextBundle, createCachedReplaySourceBundle } from './checkpoint-replay.js';
import type {
  CheckpointInterventionKindV1,
  CheckpointInterventionV1,
  CompositeCheckpointManifestV1,
  ExternalEffectReplayDecisionV1,
} from './composite-checkpoint.js';
import {
  DOMAIN_SCHEMA_VERSION,
  type BranchV1,
  type EventV1,
  type JsonValue,
  type NativeArtifactRefV1,
  type StoredEventV1,
} from './domain.js';

export interface MissionReplayInterventionInputV1 {
  readonly kind: CheckpointInterventionKindV1;
  readonly targetRef: string;
  readonly replacement: string;
  readonly description: string;
  readonly authorityChange?: 'unchanged' | 'narrowed';
  readonly beforeDigest?: string;
}

export interface MissionCheckpointReplayRequestV1 {
  readonly mode: 'playback' | 'cached-replay' | 'counterfactual-resample';
  readonly intervention?: MissionReplayInterventionInputV1;
  readonly childBranchId?: string;
}

export interface PreparedReplayInterventionV1 {
  readonly intervention: CheckpointInterventionV1;
  readonly artifact: ReplayInterventionArtifactV1;
}

export function replayArtifactReference(artifact: NativeArtifactRefV1): ReplayArtifactRefV1 {
  return {
    artifactId: artifact.artifactId,
    contentDigest: `sha256:${artifact.sha256}`,
    fidelity: artifact.redactionCount === 0 ? 'exact-replay-safe' : 'sanitized-lossy',
    evidenceRefs: [`native-artifact:${artifact.artifactId}`],
  };
}

export function cachedReplaySourceFromMission(
  checkpoint: CompositeCheckpointManifestV1,
  events: readonly StoredEventV1[],
): CachedReplaySourceBundleV1 {
  const evidence = events.flatMap((event) => {
    if (
      event.seq <= checkpoint.eventPrefix.throughSeq ||
      event.type !== 'runtime.event' ||
      event.payload.event.branchId !== checkpoint.source.branchId
    ) {
      return [];
    }
    const artifact = replayArtifactReference(event.payload.event.nativeArtifact);
    if (artifact.fidelity !== 'exact-replay-safe') return [];
    return [
      {
        evidenceId: `cached-future-${event.eventId}`,
        sourceSequence: event.seq,
        kind: cachedKind(event.payload.event.semanticKind),
        status:
          event.payload.event.semanticKind === 'failure'
            ? ('failed' as const)
            : ('observed' as const),
        targetRef: `runtime-event:${event.payload.event.runtimeEventId}`,
        contentDigest: artifact.contentDigest,
        artifactRefs: [artifact],
        evidenceRefs: [
          `kernel-event:${event.eventId}@${event.hash}`,
          `runtime-event:${event.payload.event.runtimeEventId}`,
        ],
      },
    ];
  });
  return createCachedReplaySourceBundle({
    checkpointId: checkpoint.checkpointId,
    sourceBranchId: checkpoint.source.branchId,
    sourceEventPrefix: checkpoint.eventPrefix,
    evidence,
  });
}

export function cachedContextFromMission(
  checkpoint: CompositeCheckpointManifestV1,
  events: readonly StoredEventV1[],
): CachedContextBundleV1 {
  const source = events.flatMap((event) => {
    if (
      event.seq > checkpoint.eventPrefix.throughSeq ||
      event.type !== 'runtime.event' ||
      event.payload.event.branchId !== checkpoint.source.branchId ||
      event.payload.event.nativeArtifact.redactionCount !== 0
    ) {
      return [];
    }
    return [event];
  });
  const artifacts = deduplicateArtifacts(
    source.map((event) => replayArtifactReference(event.payload.event.nativeArtifact)),
  );
  const targets = source.map((event) => ({
    targetRef: `runtime-event:${event.payload.event.runtimeEventId}`,
    contentDigest: `sha256:${event.payload.event.nativeArtifact.sha256}`,
  }));
  const contextComponent = checkpoint.components.find(
    (component) => component.component === 'visible-context',
  );
  if (contextComponent === undefined || contextComponent.disposition === 'unavailable') {
    throw new TypeError('Counterfactual resampling requires captured visible Context evidence');
  }
  return createCachedContextBundle({
    checkpointId: checkpoint.checkpointId,
    contextDigest: contextComponent.contentDigest,
    artifactRefs: artifacts,
    targetDigests: deduplicateTargets(targets),
    evidenceRefs: [
      `checkpoint:${checkpoint.checkpointId}`,
      ...source.map((event) => `kernel-event:${event.eventId}@${event.hash}`),
    ],
  });
}

export function confirmedEffectNoRepeatDecisions(
  checkpoint: CompositeCheckpointManifestV1,
): ExternalEffectReplayDecisionV1[] {
  return checkpoint.externalEffectFrontier
    .filter((effect) => effect.status === 'confirmed')
    .map((effect) => ({ effectId: effect.effectId, action: 'inherit-no-repeat' as const }))
    .sort((left, right) => left.effectId.localeCompare(right.effectId));
}

export function replayKernelEvents(
  record: CheckpointReplayRecordV1,
  occurredAt: string,
  includeBranch: boolean,
): readonly EventV1[] {
  const lineage = record.lineage;
  const events: EventV1[] = [];
  if (includeBranch && lineage.mode !== 'playback') {
    const branch: BranchV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      branchId: lineage.childBranchId,
      missionId: lineage.missionId,
      parentBranchId: lineage.parentBranchId,
      baseCheckpointId: lineage.parentCheckpointId,
      status: 'active',
      createdAt: lineage.createdAt,
    };
    events.push({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      eventId: `event-replay-branch-${record.replayId}`,
      missionId: lineage.missionId,
      occurredAt: lineage.createdAt,
      type: 'branch.created',
      payload: { branch },
    });
  }
  events.push({
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId: `event-replay-record-${record.replayId}-${record.phase}`,
    missionId: lineage.missionId,
    occurredAt,
    type: 'runtime.observation',
    payload: {
      kind: 'checkpoint-replay.recorded',
      data: {
        replayId: record.replayId,
        mode: record.mode,
        phase: record.phase,
        lineage: record.lineage,
        plan: record.plan,
        receiptInput: record.receiptInput ?? null,
        failure: record.failure ?? null,
        unknown: record.unknown ?? null,
        modelEvidence: record.modelEvidence,
        evidenceRefs: record.events.map(
          (event) => `checkpoint-replay-event:${event.eventId}@${event.eventHash}`,
        ),
      } as unknown as JsonValue,
    },
  });
  return events;
}

function cachedKind(kind: string): CachedFutureEvidenceKindV1 {
  switch (kind) {
    case 'model':
      return 'model-output';
    case 'message':
      return 'message';
    case 'tool':
      return 'tool-result';
    case 'workspace':
      return 'workspace-change';
    case 'failure':
      return 'failure';
    default:
      return 'unknown';
  }
}

function deduplicateArtifacts(values: readonly ReplayArtifactRefV1[]): ReplayArtifactRefV1[] {
  const indexed = new Map<string, ReplayArtifactRefV1>();
  for (const value of values) indexed.set(value.artifactId, value);
  return [...indexed.values()].sort((left, right) =>
    left.artifactId.localeCompare(right.artifactId),
  );
}

function deduplicateTargets(
  values: readonly { readonly targetRef: string; readonly contentDigest: string }[],
): { readonly targetRef: string; readonly contentDigest: string }[] {
  const indexed = new Map<string, { readonly targetRef: string; readonly contentDigest: string }>();
  for (const value of values) indexed.set(value.targetRef, value);
  return [...indexed.values()].sort((left, right) => left.targetRef.localeCompare(right.targetRef));
}
