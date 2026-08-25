/**
 * A read-only projection over Runtime Event IR and sanitized native artifacts.
 *
 * This module deliberately owns no Mission state. In particular, source order
 * can make two model calls comparable, but it never creates a causal edge.
 */
import { createHash } from 'node:crypto';

import type { NativeArtifactContent } from './artifact-store.js';
import type { AgentRuntimeEventV1, JsonValue, RuntimeSemanticKindV1 } from './domain.js';
import type { MissionTimelineEntry } from './engine.js';

export const CONTEXT_GRAPH_SCHEMA_VERSION = 1 as const;

export type ContextGraphNodeKind =
  | 'runtime-event'
  | 'correlation'
  | 'context-item'
  | 'tool'
  | 'file'
  | 'test'
  | 'subagent';

export interface ContextGraphNodeV1 {
  readonly nodeId: string;
  readonly kind: ContextGraphNodeKind;
  readonly label: string;
  readonly evidenceRefs: readonly string[];
  readonly runtimeEventId?: string;
  readonly sourceHarness?: string;
  readonly semanticKind?: RuntimeSemanticKindV1;
  readonly digest?: string;
}

export type ContextGraphEdgeKind =
  | 'causal'
  | 'correlation'
  | 'context-membership'
  | 'event-observation'
  | 'tool-file'
  | 'file-test'
  | 'subagent-lineage';

export type ContextGraphEdgeBasis =
  | 'explicit-causal-parent-id'
  | 'explicit-correlation-id'
  | 'observable-model-context'
  | 'controller-prompt-binding'
  | 'explicit-native-artifact-field';

export interface ContextGraphEdgeV1 {
  readonly edgeId: string;
  readonly kind: ContextGraphEdgeKind;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly directed: boolean;
  readonly basis: ContextGraphEdgeBasis;
  readonly evidenceRefs: readonly string[];
}

export interface ObservableContextItemV1 {
  readonly nodeId: string;
  readonly category: string;
  readonly descriptor: string;
  readonly digest: string;
  readonly evidenceRefs: readonly string[];
}

export interface AdjacentModelContextDiffV1 {
  readonly diffId: string;
  readonly sourceId: string;
  readonly fromRuntimeEventId: string;
  readonly toRuntimeEventId: string;
  /** Native source sequence establishes adjacency only, never causality. */
  readonly basis: 'adjacent-native-source-sequence';
  readonly added: readonly ObservableContextItemV1[];
  readonly removed: readonly ObservableContextItemV1[];
  readonly retained: readonly ObservableContextItemV1[];
}

export type ContextUnavailableKind =
  | 'hidden-model-state'
  | 'signed-payload-verification'
  | 'provider-kv-cache'
  | 'redacted-native-content'
  | 'opaque-runtime-event'
  | 'native-artifact-missing'
  | 'native-artifact-integrity'
  | 'native-artifact-unstructured'
  | 'native-artifact-invalid-json'
  | 'causal-parent-unresolved'
  | 'model-context-unavailable'
  | 'model-source-order-ambiguous'
  | 'duplicate-runtime-event'
  | 'timeline-runtime-event-invalid';

export interface ContextUnavailableBoundaryV1 {
  readonly boundaryId: string;
  readonly kind: ContextUnavailableKind;
  readonly reason: string;
  readonly runtimeEventIds: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface ContextGraphV1 {
  readonly schemaVersion: typeof CONTEXT_GRAPH_SCHEMA_VERSION;
  readonly authority: 'derived-evidence-only';
  readonly runtimeEventCount: number;
  readonly nativeArtifactCount: number;
  readonly nodes: readonly ContextGraphNodeV1[];
  readonly edges: readonly ContextGraphEdgeV1[];
  readonly contextDiffs: readonly AdjacentModelContextDiffV1[];
  readonly unavailable: readonly ContextUnavailableBoundaryV1[];
}

export interface ContextGraphInput {
  /** Direct Event IR input, for storage and adapter integrations. */
  readonly runtimeEvents?: readonly AgentRuntimeEventV1[];
  /** Workbench-friendly input; only `runtime.event` entries are consumed. */
  readonly timeline?: readonly MissionTimelineEntry[];
  /** Optional content already read from NativeArtifactStore. */
  readonly nativeArtifacts?: readonly NativeArtifactContent[];
}

interface EvidenceValue {
  readonly value: JsonValue;
  readonly evidenceRef: string;
  readonly artifact: boolean;
}

interface ArtifactResolution {
  readonly values: readonly EvidenceValue[];
  readonly artifactEvidenceRefs: readonly string[];
}

interface MutableNode extends Omit<ContextGraphNodeV1, 'evidenceRefs'> {
  readonly evidenceRefs: string[];
}

interface MutableEdge extends Omit<ContextGraphEdgeV1, 'evidenceRefs'> {
  readonly evidenceRefs: string[];
}

interface MutableContextItem extends Omit<ObservableContextItemV1, 'evidenceRefs'> {
  readonly evidenceRefs: string[];
}

const SEMANTIC_KINDS = new Set<RuntimeSemanticKindV1>([
  'runtime',
  'session',
  'turn',
  'model',
  'context',
  'tool',
  'workspace',
  'subagent',
  'usage',
  'message',
  'failure',
  'unknown',
]);

const DIRECT_CONTEXT_KEYS = new Map<string, string>([
  ['messages', 'messages'],
  ['instructions', 'instructions'],
  ['system', 'instructions'],
  ['system_prompt', 'instructions'],
  ['tools', 'tools'],
  ['skills', 'skills'],
  ['mcp', 'mcp'],
  ['mcp_servers', 'mcp'],
  ['memory', 'memory'],
  ['memories', 'memory'],
  ['documents', 'retrieval'],
  ['retrieval', 'retrieval'],
]);

const CONTEXT_CONTAINER_KEYS = new Set(['context', 'model_context', 'input_context']);
const FILE_FIELD_KEYS = new Set([
  'file',
  'file_path',
  'filename',
  'path',
  'source_file',
  'target_file',
  'test_file',
  'test_path',
]);
const TEST_CONTAINER_PATTERN = /(?:^|[._-])(test|tests|verification|verifications)(?:$|[.[_-])/i;

/** Derive an immutable graph without mutating or supplementing Mission state. */
export function deriveContextGraph(input: ContextGraphInput): ContextGraphV1 {
  const nodes = new Map<string, MutableNode>();
  const edges = new Map<string, MutableEdge>();
  const unavailable = new Map<string, ContextUnavailableBoundaryV1>();
  const artifacts = new Map<string, NativeArtifactContent>();
  for (const artifact of input.nativeArtifacts ?? []) {
    if (!artifacts.has(artifact.artifactId)) artifacts.set(artifact.artifactId, artifact);
  }

  const addUnavailable = (
    kind: ContextUnavailableKind,
    reason: string,
    runtimeEventIds: readonly string[] = [],
    evidenceRefs: readonly string[] = [],
  ): void => {
    const sortedRuntimeEventIds = uniqueSorted(runtimeEventIds);
    const sortedEvidenceRefs = uniqueSorted(evidenceRefs);
    const boundaryId = `unavailable-${shortHash(
      stableStringify([kind, reason, sortedRuntimeEventIds, sortedEvidenceRefs]),
    )}`;
    unavailable.set(boundaryId, {
      boundaryId,
      kind,
      reason,
      runtimeEventIds: sortedRuntimeEventIds,
      evidenceRefs: sortedEvidenceRefs,
    });
  };

  addUnavailable(
    'hidden-model-state',
    'Provider-internal reasoning and other hidden model state are not present in Runtime Event IR.',
  );
  addUnavailable(
    'provider-kv-cache',
    'Provider KV-cache contents and cache topology are outside the observable Runtime Event IR boundary.',
  );

  const events = collectRuntimeEvents(input, addUnavailable);
  const eventById = new Map(events.map((event) => [event.runtimeEventId, event]));
  const evidenceByEvent = new Map<string, ArtifactResolution>();
  const contextByEvent = new Map<string, readonly ObservableContextItemV1[]>();

  const addNode = (candidate: ContextGraphNodeV1): void => {
    const previous = nodes.get(candidate.nodeId);
    if (previous === undefined) {
      nodes.set(candidate.nodeId, { ...candidate, evidenceRefs: [...candidate.evidenceRefs] });
      return;
    }
    previous.evidenceRefs.splice(
      0,
      previous.evidenceRefs.length,
      ...uniqueSorted([...previous.evidenceRefs, ...candidate.evidenceRefs]),
    );
  };

  const addEdge = (candidate: Omit<ContextGraphEdgeV1, 'edgeId'>): void => {
    const edgeId = `edge-${shortHash(
      stableStringify([candidate.kind, candidate.fromNodeId, candidate.toNodeId, candidate.basis]),
    )}`;
    const previous = edges.get(edgeId);
    if (previous === undefined) {
      edges.set(edgeId, { edgeId, ...candidate, evidenceRefs: [...candidate.evidenceRefs] });
      return;
    }
    previous.evidenceRefs.splice(
      0,
      previous.evidenceRefs.length,
      ...uniqueSorted([...previous.evidenceRefs, ...candidate.evidenceRefs]),
    );
  };

  for (const event of events) {
    const eventNodeId = runtimeEventNodeId(event.runtimeEventId);
    addNode({
      nodeId: eventNodeId,
      kind: 'runtime-event',
      label: `${event.sourceHarness} · ${event.semanticKind} · source #${String(event.sourceSequence)}`,
      runtimeEventId: event.runtimeEventId,
      sourceHarness: event.sourceHarness,
      semanticKind: event.semanticKind,
      evidenceRefs: [event.runtimeEventId],
    });

    if (event.fidelity === 'opaque') {
      addUnavailable(
        'opaque-runtime-event',
        'The Runtime reported an event boundary without inspectable native semantics.',
        [event.runtimeEventId],
        [event.runtimeEventId],
      );
    }
    if (event.nativeArtifact.redactionCount > 0) {
      addUnavailable(
        'redacted-native-content',
        'Sanitization removed credential-like native fields before graph derivation.',
        [event.runtimeEventId],
        [event.nativeArtifact.artifactId],
      );
    }

    for (const parentId of event.causalParentIds) {
      if (!eventById.has(parentId)) {
        addUnavailable(
          'causal-parent-unresolved',
          `Explicit causal parent ${parentId} is not present in the supplied event set.`,
          [event.runtimeEventId],
          [event.runtimeEventId, parentId],
        );
        continue;
      }
      addEdge({
        kind: 'causal',
        fromNodeId: runtimeEventNodeId(parentId),
        toNodeId: eventNodeId,
        directed: true,
        basis: 'explicit-causal-parent-id',
        evidenceRefs: [event.runtimeEventId, parentId],
      });
    }

    for (const correlationId of uniqueSorted(event.correlationIds)) {
      const correlationNodeId = entityNodeId('correlation', correlationId);
      addNode({
        nodeId: correlationNodeId,
        kind: 'correlation',
        label: correlationId,
        digest: sha256(correlationId),
        evidenceRefs: [event.runtimeEventId],
      });
      addEdge({
        kind: 'correlation',
        fromNodeId: eventNodeId,
        toNodeId: correlationNodeId,
        directed: false,
        basis: 'explicit-correlation-id',
        evidenceRefs: [event.runtimeEventId],
      });
    }

    const evidence = resolveEvidence(event, artifacts, addUnavailable);
    evidenceByEvent.set(event.runtimeEventId, evidence);
    detectUnavailableProviderFields(event, evidence.values, addUnavailable);

    if (event.semanticKind === 'model') {
      const contextItems = collectObservableContext(event, evidence.values);
      contextByEvent.set(event.runtimeEventId, contextItems);
      for (const item of contextItems) {
        addNode({
          nodeId: item.nodeId,
          kind: 'context-item',
          label: item.descriptor,
          digest: item.digest,
          evidenceRefs: item.evidenceRefs,
        });
        addEdge({
          kind: 'context-membership',
          fromNodeId: eventNodeId,
          toNodeId: item.nodeId,
          directed: true,
          basis: 'observable-model-context',
          evidenceRefs: item.evidenceRefs,
        });
      }
    }

    for (const evidenceValue of evidence.values) {
      collectArtifactRelations(event, evidenceValue, addNode, addEdge);
    }
  }

  for (const entry of input.timeline ?? []) {
    if (entry.kind !== 'context.controller_prompt' || !isJsonRecord(entry.data)) continue;
    const data = entry.data;
    const snapshotId = firstString(data.contextSnapshotId);
    const attemptId = firstString(data.attemptId);
    const artifact = isJsonRecord(data.nativeArtifact) ? data.nativeArtifact : undefined;
    const artifactId = firstString(artifact?.artifactId);
    const artifactSha = firstString(artifact?.sha256);
    if (snapshotId === undefined || attemptId === undefined || artifactId === undefined) continue;
    const contextNodeId = entityNodeId('context-item', snapshotId);
    addNode({
      nodeId: contextNodeId,
      kind: 'context-item',
      label: `controller prompt · ${firstString(data.stageId) ?? attemptId}`,
      ...(artifactSha === undefined ? {} : { digest: artifactSha }),
      evidenceRefs: [`timeline:${String(entry.seq)}`, artifactId],
    });
    for (const event of events) {
      if (event.attemptId !== attemptId) continue;
      addEdge({
        kind: 'context-membership',
        fromNodeId: runtimeEventNodeId(event.runtimeEventId),
        toNodeId: contextNodeId,
        directed: true,
        basis: 'controller-prompt-binding',
        evidenceRefs: [`timeline:${String(entry.seq)}`, artifactId, event.runtimeEventId],
      });
    }
    const content = artifacts.get(artifactId);
    if (content === undefined) {
      addUnavailable(
        'native-artifact-missing',
        'The redacted controller prompt artifact is referenced but its content was not supplied.',
        [],
        [artifactId],
      );
    } else if (artifactSha !== undefined && sha256(content.content) !== artifactSha) {
      addUnavailable(
        'native-artifact-integrity',
        'The supplied controller prompt does not match its recorded digest.',
        [],
        [artifactId],
      );
    }
    const redactionCount = artifact?.redactionCount;
    if (typeof redactionCount === 'number' && redactionCount > 0) {
      addUnavailable(
        'redacted-native-content',
        'Credential-like values were removed from the controller prompt before persistence.',
        [],
        [artifactId],
      );
    }
    for (const unavailableKind of Array.isArray(data.unavailable) ? data.unavailable : []) {
      if (typeof unavailableKind !== 'string') continue;
      const kind: ContextUnavailableKind = unavailableKind.includes('chain_of_thought')
        ? 'hidden-model-state'
        : unavailableKind.includes('kv_cache')
          ? 'provider-kv-cache'
          : unavailableKind.includes('signed')
            ? 'signed-payload-verification'
            : 'model-context-unavailable';
      addUnavailable(
        kind,
        `${unavailableKind} is outside the observable controller context boundary.`,
        [],
        [`timeline:${String(entry.seq)}`],
      );
    }
  }

  const contextDiffs = deriveAdjacentModelDiffs(events, contextByEvent, addUnavailable);
  return {
    schemaVersion: CONTEXT_GRAPH_SCHEMA_VERSION,
    authority: 'derived-evidence-only',
    runtimeEventCount: events.length,
    nativeArtifactCount: artifacts.size,
    nodes: [...nodes.values()]
      .map((node) => ({ ...node, evidenceRefs: uniqueSorted(node.evidenceRefs) }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    edges: [...edges.values()]
      .map((edge) => ({ ...edge, evidenceRefs: uniqueSorted(edge.evidenceRefs) }))
      .sort((left, right) => left.edgeId.localeCompare(right.edgeId)),
    contextDiffs,
    unavailable: [...unavailable.values()].sort((left, right) =>
      left.boundaryId.localeCompare(right.boundaryId),
    ),
  };
}

function collectRuntimeEvents(
  input: ContextGraphInput,
  addUnavailable: (
    kind: ContextUnavailableKind,
    reason: string,
    runtimeEventIds?: readonly string[],
    evidenceRefs?: readonly string[],
  ) => void,
): AgentRuntimeEventV1[] {
  const candidates: AgentRuntimeEventV1[] = [...(input.runtimeEvents ?? [])];
  for (const entry of input.timeline ?? []) {
    if (entry.kind !== 'runtime.event') continue;
    if (!isAgentRuntimeEvent(entry.data)) {
      addUnavailable(
        'timeline-runtime-event-invalid',
        `Timeline entry #${String(entry.seq)} is labelled runtime.event but does not contain valid Event IR.`,
        [],
        [`timeline:${String(entry.seq)}`],
      );
      continue;
    }
    candidates.push(entry.data);
  }

  const byId = new Map<string, AgentRuntimeEventV1>();
  for (const event of candidates) {
    const previous = byId.get(event.runtimeEventId);
    if (previous === undefined) {
      byId.set(event.runtimeEventId, event);
      continue;
    }
    if (stableStringify(previous) !== stableStringify(event)) {
      addUnavailable(
        'duplicate-runtime-event',
        'Conflicting Event IR records share one runtimeEventId; the first supplied record was retained.',
        [event.runtimeEventId],
        [event.runtimeEventId],
      );
    }
  }
  return [...byId.values()].sort(compareRuntimeEvents);
}

function resolveEvidence(
  event: AgentRuntimeEventV1,
  artifacts: ReadonlyMap<string, NativeArtifactContent>,
  addUnavailable: (
    kind: ContextUnavailableKind,
    reason: string,
    runtimeEventIds?: readonly string[],
    evidenceRefs?: readonly string[],
  ) => void,
): ArtifactResolution {
  const values: EvidenceValue[] = [
    {
      value: event.normalized,
      evidenceRef: `${event.runtimeEventId}:normalized`,
      artifact: false,
    },
  ];
  const artifact = artifacts.get(event.nativeArtifact.artifactId);
  if (artifact === undefined) {
    addUnavailable(
      'native-artifact-missing',
      'Sanitized native artifact content was not supplied; only normalized Event IR fields are observable.',
      [event.runtimeEventId],
      [event.nativeArtifact.artifactId],
    );
    return { values, artifactEvidenceRefs: [] };
  }
  if (
    artifact.sha256 !== event.nativeArtifact.sha256 ||
    artifact.mediaType !== event.nativeArtifact.mediaType ||
    sha256(artifact.content) !== event.nativeArtifact.sha256
  ) {
    addUnavailable(
      'native-artifact-integrity',
      'Supplied native artifact content does not match its Event IR digest or media type.',
      [event.runtimeEventId],
      [event.nativeArtifact.artifactId],
    );
    return { values, artifactEvidenceRefs: [] };
  }
  if (artifact.mediaType === 'text/plain') {
    addUnavailable(
      'native-artifact-unstructured',
      'Plain-text native output is retained as evidence but is not interpreted as structured graph facts.',
      [event.runtimeEventId],
      [artifact.artifactId],
    );
    return { values, artifactEvidenceRefs: [artifact.artifactId] };
  }
  try {
    const parsed = JSON.parse(artifact.content) as unknown;
    if (!isJsonValue(parsed)) throw new Error('not JSON-compatible');
    values.push({ value: parsed, evidenceRef: artifact.artifactId, artifact: true });
    return { values, artifactEvidenceRefs: [artifact.artifactId] };
  } catch {
    addUnavailable(
      'native-artifact-invalid-json',
      'The digest-matched application/json artifact could not be parsed as JSON.',
      [event.runtimeEventId],
      [artifact.artifactId],
    );
    return { values, artifactEvidenceRefs: [artifact.artifactId] };
  }
}

function collectObservableContext(
  event: AgentRuntimeEventV1,
  evidenceValues: readonly EvidenceValue[],
): readonly ObservableContextItemV1[] {
  const items = new Map<string, MutableContextItem>();
  const addItem = (category: string, value: JsonValue, evidenceRef: string): void => {
    const digest = sha256(stableStringify(value));
    const nodeId = entityNodeId('context-item', `${category}:${digest}`);
    const descriptor = contextDescriptor(category, value);
    const previous = items.get(nodeId);
    if (previous === undefined) {
      items.set(nodeId, {
        nodeId,
        category,
        descriptor,
        digest,
        evidenceRefs: [evidenceRef],
      });
    } else if (!previous.evidenceRefs.includes(evidenceRef)) {
      previous.evidenceRefs.push(evidenceRef);
    }
  };

  for (const evidence of evidenceValues) {
    walkJsonRecords(evidence.value, (record) => {
      for (const [key, value] of Object.entries(record)) {
        const normalizedKey = key.toLowerCase();
        if (CONTEXT_CONTAINER_KEYS.has(normalizedKey)) {
          collectContextContainer(value, evidence.evidenceRef, addItem);
          continue;
        }
        const category = DIRECT_CONTEXT_KEYS.get(normalizedKey);
        if (category !== undefined)
          collectContextMembers(category, value, evidence.evidenceRef, addItem);
      }
    });
  }
  return [...items.values()]
    .map((item) => ({ ...item, evidenceRefs: uniqueSorted(item.evidenceRefs) }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

function collectContextContainer(
  value: JsonValue,
  evidenceRef: string,
  addItem: (category: string, value: JsonValue, evidenceRef: string) => void,
): void {
  if (isJsonRecord(value)) {
    let recognized = false;
    for (const [key, member] of Object.entries(value)) {
      const category = DIRECT_CONTEXT_KEYS.get(key.toLowerCase());
      if (category === undefined) continue;
      recognized = true;
      collectContextMembers(category, member, evidenceRef, addItem);
    }
    if (!recognized) addItem('context', value, evidenceRef);
    return;
  }
  collectContextMembers('context', value, evidenceRef, addItem);
}

function collectContextMembers(
  category: string,
  value: JsonValue,
  evidenceRef: string,
  addItem: (category: string, value: JsonValue, evidenceRef: string) => void,
): void {
  if (Array.isArray(value)) {
    for (const member of value) addItem(category, member, evidenceRef);
    return;
  }
  if (isJsonRecord(value) && ['tools', 'skills', 'mcp'].includes(category)) {
    for (const [name, member] of Object.entries(value))
      addItem(category, { name, value: member }, evidenceRef);
    return;
  }
  addItem(category, value, evidenceRef);
}

function deriveAdjacentModelDiffs(
  events: readonly AgentRuntimeEventV1[],
  contextByEvent: ReadonlyMap<string, readonly ObservableContextItemV1[]>,
  addUnavailable: (
    kind: ContextUnavailableKind,
    reason: string,
    runtimeEventIds?: readonly string[],
    evidenceRefs?: readonly string[],
  ) => void,
): AdjacentModelContextDiffV1[] {
  const bySource = new Map<string, AgentRuntimeEventV1[]>();
  for (const event of events) {
    if (event.semanticKind !== 'model') continue;
    const group = bySource.get(event.sourceId) ?? [];
    group.push(event);
    bySource.set(event.sourceId, group);
  }

  const diffs: AdjacentModelContextDiffV1[] = [];
  for (const [sourceId, sourceEvents] of [...bySource.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    sourceEvents.sort((left, right) =>
      left.sourceSequence === right.sourceSequence
        ? left.runtimeEventId.localeCompare(right.runtimeEventId)
        : left.sourceSequence - right.sourceSequence,
    );
    const ambiguousSequences = new Set<number>();
    for (let index = 1; index < sourceEvents.length; index += 1) {
      const previous = sourceEvents[index - 1];
      const current = sourceEvents[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        previous.sourceSequence === current.sourceSequence
      ) {
        ambiguousSequences.add(current.sourceSequence);
      }
    }
    if (ambiguousSequences.size > 0) {
      addUnavailable(
        'model-source-order-ambiguous',
        'Multiple model calls share a native source sequence, so adjacency across that sequence is not derived.',
        sourceEvents
          .filter((event) => ambiguousSequences.has(event.sourceSequence))
          .map((event) => event.runtimeEventId),
        sourceEvents
          .filter((event) => ambiguousSequences.has(event.sourceSequence))
          .map((event) => event.runtimeEventId),
      );
    }

    for (let index = 1; index < sourceEvents.length; index += 1) {
      const from = sourceEvents[index - 1];
      const to = sourceEvents[index];
      if (from === undefined || to === undefined) continue;
      if (
        ambiguousSequences.has(from.sourceSequence) ||
        ambiguousSequences.has(to.sourceSequence)
      ) {
        continue;
      }
      const fromItems = contextByEvent.get(from.runtimeEventId) ?? [];
      const toItems = contextByEvent.get(to.runtimeEventId) ?? [];
      if (fromItems.length === 0 || toItems.length === 0) {
        addUnavailable(
          'model-context-unavailable',
          'At least one adjacent model call lacks an observable context snapshot; an empty context is not assumed.',
          [from.runtimeEventId, to.runtimeEventId],
          [from.nativeArtifact.artifactId, to.nativeArtifact.artifactId],
        );
        continue;
      }
      const fromByNode = new Map(fromItems.map((item) => [item.nodeId, item]));
      const toByNode = new Map(toItems.map((item) => [item.nodeId, item]));
      const added = toItems.filter((item) => !fromByNode.has(item.nodeId));
      const removed = fromItems.filter((item) => !toByNode.has(item.nodeId));
      const retained = toItems.filter((item) => fromByNode.has(item.nodeId));
      diffs.push({
        diffId: `context-diff-${shortHash(`${sourceId}:${from.runtimeEventId}:${to.runtimeEventId}`)}`,
        sourceId,
        fromRuntimeEventId: from.runtimeEventId,
        toRuntimeEventId: to.runtimeEventId,
        basis: 'adjacent-native-source-sequence',
        added,
        removed,
        retained,
      });
    }
  }
  return diffs.sort((left, right) => left.diffId.localeCompare(right.diffId));
}

function collectArtifactRelations(
  event: AgentRuntimeEventV1,
  evidence: EvidenceValue,
  addNode: (node: ContextGraphNodeV1) => void,
  addEdge: (edge: Omit<ContextGraphEdgeV1, 'edgeId'>) => void,
): void {
  const eventNodeId = runtimeEventNodeId(event.runtimeEventId);
  walkJsonRecords(evidence.value, (record, path) => {
    const tool = explicitTool(record, path, event);
    if (tool !== undefined) {
      const toolNodeId = entityNodeId(
        'tool',
        `${event.sourceHarness}:${tool.identity ?? `${event.runtimeEventId}:${path}:${tool.name}`}`,
      );
      addNode({
        nodeId: toolNodeId,
        kind: 'tool',
        label: tool.name,
        digest: sha256(tool.identity ?? `${event.runtimeEventId}:${path}:${tool.name}`),
        evidenceRefs: [evidence.evidenceRef],
      });
      addEdge({
        kind: 'event-observation',
        fromNodeId: eventNodeId,
        toNodeId: toolNodeId,
        directed: true,
        basis: 'explicit-native-artifact-field',
        evidenceRefs: [evidence.evidenceRef],
      });
      for (const file of collectFileReferences(record)) {
        const fileNodeId = entityNodeId('file', file);
        addNode({
          nodeId: fileNodeId,
          kind: 'file',
          label: file,
          digest: sha256(file),
          evidenceRefs: [evidence.evidenceRef],
        });
        addEdge({
          kind: 'tool-file',
          fromNodeId: toolNodeId,
          toNodeId: fileNodeId,
          directed: true,
          basis: 'explicit-native-artifact-field',
          evidenceRefs: [evidence.evidenceRef],
        });
      }
    }

    const test = explicitTest(record, path, event);
    if (test !== undefined) {
      const testNodeId = entityNodeId(
        'test',
        `${event.sourceHarness}:${test.identity ?? `${event.runtimeEventId}:${path}:${test.name}`}`,
      );
      addNode({
        nodeId: testNodeId,
        kind: 'test',
        label: test.name,
        digest: sha256(test.identity ?? `${event.runtimeEventId}:${path}:${test.name}`),
        evidenceRefs: [evidence.evidenceRef],
      });
      addEdge({
        kind: 'event-observation',
        fromNodeId: eventNodeId,
        toNodeId: testNodeId,
        directed: true,
        basis: 'explicit-native-artifact-field',
        evidenceRefs: [evidence.evidenceRef],
      });
      for (const file of collectFileReferences(record)) {
        const fileNodeId = entityNodeId('file', file);
        addNode({
          nodeId: fileNodeId,
          kind: 'file',
          label: file,
          digest: sha256(file),
          evidenceRefs: [evidence.evidenceRef],
        });
        addEdge({
          kind: 'file-test',
          fromNodeId: fileNodeId,
          toNodeId: testNodeId,
          directed: true,
          basis: 'explicit-native-artifact-field',
          evidenceRefs: [evidence.evidenceRef],
        });
      }
    }

    const lineage = explicitSubagentLineage(record, path, event);
    if (lineage === undefined) return;
    const childNodeId = entityNodeId('subagent', `${event.sourceHarness}:${lineage.childId}`);
    const parentNodeId = entityNodeId('subagent', `${event.sourceHarness}:${lineage.parentId}`);
    addNode({
      nodeId: childNodeId,
      kind: 'subagent',
      label: lineage.childId,
      digest: sha256(lineage.childId),
      evidenceRefs: [evidence.evidenceRef],
    });
    addNode({
      nodeId: parentNodeId,
      kind: 'subagent',
      label: lineage.parentId,
      digest: sha256(lineage.parentId),
      evidenceRefs: [evidence.evidenceRef],
    });
    addEdge({
      kind: 'event-observation',
      fromNodeId: eventNodeId,
      toNodeId: childNodeId,
      directed: true,
      basis: 'explicit-native-artifact-field',
      evidenceRefs: [evidence.evidenceRef],
    });
    addEdge({
      kind: 'subagent-lineage',
      fromNodeId: parentNodeId,
      toNodeId: childNodeId,
      directed: true,
      basis: 'explicit-native-artifact-field',
      evidenceRefs: [evidence.evidenceRef],
    });
  });
}

function explicitTool(
  record: Readonly<Record<string, JsonValue>>,
  path: string,
  event: AgentRuntimeEventV1,
): { readonly name: string; readonly identity?: string } | undefined {
  const marker = recordMarker(record);
  const functionRecord = isJsonRecord(record.function) ? record.function : undefined;
  const name = firstString(record.name, record.tool_name, functionRecord?.name);
  const explicitMarker = /(?:^|[._-])(tool|function)(?:$|[._-])/.test(marker);
  const eventRoot = path === '$' && event.semanticKind === 'tool';
  if (!explicitMarker && !eventRoot) return undefined;
  const identity = firstString(record.tool_use_id, record.tool_call_id, record.call_id, record.id);
  return {
    name: name ?? (marker.length > 0 ? marker : event.nativeEventType),
    ...(identity === undefined ? {} : { identity }),
  };
}

function explicitTest(
  record: Readonly<Record<string, JsonValue>>,
  path: string,
  event: AgentRuntimeEventV1,
): { readonly name: string; readonly identity?: string } | undefined {
  const marker = recordMarker(record);
  const explicitMarker = TEST_CONTAINER_PATTERN.test(marker) || TEST_CONTAINER_PATTERN.test(path);
  const eventRoot = path === '$' && /test|verification/i.test(event.nativeEventType);
  if (!explicitMarker && !eventRoot) return undefined;
  const name = firstString(record.test_name, record.name, record.title, record.case, record.id);
  const identity = firstString(record.test_id, record.id);
  return {
    name: name ?? (marker.length > 0 ? marker : path),
    ...(identity === undefined ? {} : { identity }),
  };
}

function explicitSubagentLineage(
  record: Readonly<Record<string, JsonValue>>,
  path: string,
  event: AgentRuntimeEventV1,
): { readonly childId: string; readonly parentId: string } | undefined {
  const marker = recordMarker(record);
  const explicitMarker = /subagent|sub_agent|spawn_agent|agent_task/.test(marker);
  const eventRoot = path === '$' && event.semanticKind === 'subagent';
  if (!explicitMarker && !eventRoot) return undefined;
  const childId = firstString(
    record.subagent_id,
    record.sub_agent_id,
    record.child_agent_id,
    record.agent_id,
    record.task_id,
  );
  const parentId = firstString(
    record.parent_subagent_id,
    record.parent_sub_agent_id,
    record.parent_agent_id,
    record.parent_task_id,
    record.parent_id,
  );
  return childId === undefined || parentId === undefined ? undefined : { childId, parentId };
}

function collectFileReferences(value: JsonValue): string[] {
  const files: string[] = [];
  walkJsonRecords(value, (record) => {
    for (const [key, member] of Object.entries(record)) {
      if (!FILE_FIELD_KEYS.has(key.toLowerCase())) continue;
      if (typeof member === 'string' && member.trim().length > 0) files.push(member.trim());
      if (Array.isArray(member)) {
        for (const candidate of member) {
          if (typeof candidate === 'string' && candidate.trim().length > 0) {
            files.push(candidate.trim());
          }
        }
      }
    }
  });
  return uniqueSorted(files);
}

function detectUnavailableProviderFields(
  event: AgentRuntimeEventV1,
  values: readonly EvidenceValue[],
  addUnavailable: (
    kind: ContextUnavailableKind,
    reason: string,
    runtimeEventIds?: readonly string[],
    evidenceRefs?: readonly string[],
  ) => void,
): void {
  for (const evidence of values) {
    walkJsonRecords(evidence.value, (record) => {
      for (const key of Object.keys(record)) {
        const normalized = key.toLowerCase().replaceAll('-', '_');
        if (
          normalized === 'signature' ||
          normalized === 'signed_content' ||
          normalized === 'encrypted_content'
        ) {
          addUnavailable(
            'signed-payload-verification',
            'A signed or encrypted provider field is observable, but its hidden payload or cryptographic validity is not derived.',
            [event.runtimeEventId],
            [evidence.evidenceRef],
          );
        }
      }
    });
  }
}

function walkJsonRecords(
  value: JsonValue,
  visitor: (record: Readonly<Record<string, JsonValue>>, path: string) => void,
  path = '$',
  depth = 0,
): void {
  if (depth > 30) return;
  if (Array.isArray(value)) {
    for (const [index, member] of value.entries()) {
      walkJsonRecords(member, visitor, `${path}[${String(index)}]`, depth + 1);
    }
    return;
  }
  if (!isJsonRecord(value)) return;
  visitor(value, path);
  for (const [key, member] of Object.entries(value)) {
    walkJsonRecords(member, visitor, `${path}.${key}`, depth + 1);
  }
}

function contextDescriptor(category: string, value: JsonValue): string {
  if (!isJsonRecord(value)) return category;
  const role = firstString(value.role);
  const name = firstString(value.name, value.tool_name, value.id);
  if (role !== undefined) return `${category}:${role}`;
  if (name !== undefined) return `${category}:${name}`;
  return category;
}

function recordMarker(record: Readonly<Record<string, JsonValue>>): string {
  return [record.type, record.event, record.kind, record.subtype, record.nativeEventType]
    .filter((member): member is string => typeof member === 'string')
    .join(' ')
    .toLowerCase();
}

function runtimeEventNodeId(runtimeEventId: string): string {
  return `runtime-event:${runtimeEventId}`;
}

function entityNodeId(
  kind: Exclude<ContextGraphNodeKind, 'runtime-event'>,
  identity: string,
): string {
  return `${kind}:${shortHash(identity)}`;
}

function shortHash(value: string): string {
  return sha256(value).slice(0, 32);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((member) => stableStringify(member)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, member]) => `${JSON.stringify(key)}:${stableStringify(member)}`)
    .join(',')}}`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function compareRuntimeEvents(left: AgentRuntimeEventV1, right: AgentRuntimeEventV1): number {
  const source = left.sourceId.localeCompare(right.sourceId);
  if (source !== 0) return source;
  if (left.sourceSequence !== right.sourceSequence)
    return left.sourceSequence - right.sourceSequence;
  return left.runtimeEventId.localeCompare(right.runtimeEventId);
}

function firstString(
  ...values: readonly JsonValue[] | readonly (JsonValue | undefined)[]
): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function isJsonRecord(value: unknown): value is { [key: string]: JsonValue } {
  return (
    value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
  );
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 50) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((member) => isJsonValue(member, depth + 1));
  if (typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every((member) =>
    isJsonValue(member, depth + 1),
  );
}

function isAgentRuntimeEvent(value: unknown): value is AgentRuntimeEventV1 {
  if (!isJsonRecord(value)) return false;
  const artifact = value.nativeArtifact;
  return (
    typeof value.runtimeEventId === 'string' &&
    typeof value.missionId === 'string' &&
    typeof value.branchId === 'string' &&
    typeof value.attemptId === 'string' &&
    typeof value.bindingId === 'string' &&
    typeof value.planNodeId === 'string' &&
    typeof value.sourceHarness === 'string' &&
    typeof value.sourceProtocol === 'string' &&
    typeof value.sourceId === 'string' &&
    typeof value.sourceSequence === 'number' &&
    Number.isSafeInteger(value.sourceSequence) &&
    typeof value.nativeEventType === 'string' &&
    typeof value.semanticKind === 'string' &&
    SEMANTIC_KINDS.has(value.semanticKind as RuntimeSemanticKindV1) &&
    Array.isArray(value.causalParentIds) &&
    value.causalParentIds.every((member) => typeof member === 'string') &&
    Array.isArray(value.correlationIds) &&
    value.correlationIds.every((member) => typeof member === 'string') &&
    typeof value.observedAt === 'string' &&
    (value.nativeOccurredAt === undefined || typeof value.nativeOccurredAt === 'string') &&
    (value.fidelity === 'native' || value.fidelity === 'derived' || value.fidelity === 'opaque') &&
    value.normalized !== undefined &&
    isJsonRecord(artifact) &&
    typeof artifact.artifactId === 'string' &&
    typeof artifact.sha256 === 'string' &&
    typeof artifact.relativePath === 'string' &&
    (artifact.mediaType === 'application/json' || artifact.mediaType === 'text/plain') &&
    typeof artifact.byteLength === 'number' &&
    artifact.sanitized === true &&
    typeof artifact.redactionCount === 'number'
  );
}
