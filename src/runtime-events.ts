import { createHash } from 'node:crypto';

import type { RuntimeOutputLine } from './adapters/types.js';
import type {
  AgentRuntimeEventV1,
  JsonValue,
  NativeArtifactRefV1,
  RuntimeSemanticKindV1,
} from './domain.js';

export interface RuntimeEventContext {
  readonly missionId: string;
  readonly branchId: string;
  readonly attemptId: string;
  readonly bindingId: string;
  readonly planNodeId: string;
  readonly sourceProtocol: string;
  /** Only native parent relationships already resolved to Event IR identities. */
  readonly causalParentIds?: readonly string[];
}

export function normalizeRuntimeOutput(
  line: RuntimeOutputLine,
  context: RuntimeEventContext,
  artifact: NativeArtifactRefV1,
): AgentRuntimeEventV1 {
  const sourceId = `${context.attemptId}:${line.runtime}:${context.sourceProtocol}:${line.stream}`;
  const runtimeEventId = `runtime-event-${sha256(`${sourceId}:${String(line.streamSequence)}`).slice(0, 32)}`;
  const nativeEventType = nativeType(line);
  const correlationIds = collectCorrelationIds(line.value);
  const occurredAt = nativeTimestamp(line.value);
  return {
    runtimeEventId,
    missionId: context.missionId,
    branchId: context.branchId,
    attemptId: context.attemptId,
    bindingId: context.bindingId,
    planNodeId: context.planNodeId,
    sourceHarness: line.runtime,
    sourceProtocol: context.sourceProtocol,
    sourceId,
    sourceSequence: line.streamSequence,
    nativeEventType,
    semanticKind: semanticKind(nativeEventType, line.value),
    causalParentIds: [...(context.causalParentIds ?? [])],
    correlationIds,
    observedAt: line.receivedAt,
    ...(occurredAt === undefined ? {} : { nativeOccurredAt: occurredAt }),
    fidelity: line.value === undefined ? 'opaque' : 'native',
    normalized: {
      stream: line.stream,
      structured: line.value !== undefined,
      nativeEventType,
      sourceSequence: line.streamSequence,
      controllerSequence: line.sequence,
    },
    nativeArtifact: artifact,
  };
}

/** Native identifiers owned by this event and safe to use as future causal targets. */
export function nativeEventIdentityIds(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  return uniqueStrings([
    record.uuid,
    record.event_id,
    record.tool_use_id,
    nestedString(record.message, 'id'),
  ]);
}

/** Explicit native parent references. Mere arrival order is never treated as causality. */
export function nativeParentCorrelationIds(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  return uniqueStrings([record.parent_uuid, record.parent_id, record.parent_tool_use_id]);
}

function nativeType(line: RuntimeOutputLine): string {
  if (line.value === null || typeof line.value !== 'object' || Array.isArray(line.value)) {
    return `${line.stream}.text`;
  }
  const record = line.value as Record<string, unknown>;
  for (const key of ['type', 'event', 'kind', 'subtype']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return `${line.stream}.json`;
}

function semanticKind(nativeEventType: string, value: unknown): RuntimeSemanticKindV1 {
  const haystack = `${nativeEventType} ${nativeSubtypes(value)}`.toLowerCase();
  if (haystack.includes('error') || haystack.includes('fail')) return 'failure';
  if (haystack.includes('tool') || haystack.includes('hook')) return 'tool';
  if (haystack.includes('subagent') || haystack.includes('task')) return 'subagent';
  if (haystack.includes('context') || haystack.includes('compact')) return 'context';
  if (haystack.includes('usage') || haystack.includes('cost')) return 'usage';
  if (haystack.includes('session') || haystack.includes('init') || haystack === 'system ') {
    return 'session';
  }
  if (haystack.includes('assistant') || haystack.includes('user') || haystack.includes('message')) {
    return 'message';
  }
  if (haystack.includes('model') || haystack.includes('reasoning')) return 'model';
  if (haystack.includes('turn') || haystack.includes('result')) return 'turn';
  if (haystack.includes('file') || haystack.includes('workspace') || haystack.includes('patch')) {
    return 'workspace';
  }
  if (nativeEventType.endsWith('.text') || nativeEventType.endsWith('.json')) return 'unknown';
  return 'runtime';
}

function nativeSubtypes(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  return ['subtype', 'event', 'kind']
    .map((key) => record[key])
    .filter((member): member is string => typeof member === 'string')
    .join(' ');
}

function collectCorrelationIds(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const values = [
    record.session_id,
    ...nativeEventIdentityIds(value),
    ...nativeParentCorrelationIds(value),
  ];
  return uniqueStrings(values);
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return [
    ...new Set(
      values.filter((member): member is string => typeof member === 'string' && member.length > 0),
    ),
  ];
}

function nativeTimestamp(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['timestamp', 'created_at', 'occurred_at']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && Number.isFinite(Date.parse(candidate))) return candidate;
  }
  return undefined;
}

function nestedString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
