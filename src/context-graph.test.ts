import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { NativeArtifactContent } from './artifact-store.js';
import { deriveContextGraph } from './context-graph.js';
import type { AgentRuntimeEventV1, JsonValue, NativeArtifactRefV1 } from './domain.js';
import type { MissionTimelineEntry } from './engine.js';

describe('derived Context Graph', () => {
  it('creates causal edges only from explicit parent ids and keeps correlation distinct', () => {
    const parent = runtimeFixture({
      runtimeEventId: 'event-parent',
      sourceSequence: 5,
      observedAt: '2026-08-25T00:00:05.000Z',
      correlationIds: ['session-1'],
    });
    const merelyEarlier = runtimeFixture({
      runtimeEventId: 'event-merely-earlier',
      sourceSequence: 1,
      observedAt: '2026-08-25T00:00:01.000Z',
      correlationIds: ['session-1'],
    });
    const child = runtimeFixture({
      runtimeEventId: 'event-child',
      sourceSequence: 2,
      observedAt: '2026-08-25T00:00:02.000Z',
      causalParentIds: ['event-parent'],
      correlationIds: ['session-1'],
    });

    const graph = deriveContextGraph({
      runtimeEvents: [parent.event, merelyEarlier.event, child.event],
      nativeArtifacts: [parent.artifact, merelyEarlier.artifact, child.artifact],
    });

    const causal = graph.edges.filter((edge) => edge.kind === 'causal');
    expect(causal).toHaveLength(1);
    expect(causal[0]).toMatchObject({
      fromNodeId: 'runtime-event:event-parent',
      toNodeId: 'runtime-event:event-child',
      basis: 'explicit-causal-parent-id',
    });
    expect(graph.edges.filter((edge) => edge.kind === 'correlation')).toHaveLength(3);
    expect(graph.edges.some((edge) => edge.basis.includes('sequence'))).toBe(false);
    expect(graph.authority).toBe('derived-evidence-only');
  });

  it('diffs observable context between adjacent native model calls without exposing content', () => {
    const first = runtimeFixture({
      runtimeEventId: 'model-1',
      sourceSequence: 10,
      semanticKind: 'model',
      nativeEventType: 'model.call',
      native: {
        type: 'model.call',
        context: {
          instructions: ['stay concise'],
          messages: [{ role: 'user', content: 'fix the widget' }],
          tools: [{ name: 'Read' }],
        },
      },
    });
    const second = runtimeFixture({
      runtimeEventId: 'model-2',
      sourceSequence: 11,
      semanticKind: 'model',
      nativeEventType: 'model.call',
      native: {
        type: 'model.call',
        signature: 'provider-opaque-signature',
        context: {
          instructions: ['stay concise'],
          messages: [
            { role: 'user', content: 'fix the widget' },
            { role: 'assistant', content: 'I inspected it' },
          ],
          tools: [{ name: 'Read' }, { name: 'Write' }],
        },
      },
    });

    const graph = deriveContextGraph({
      runtimeEvents: [second.event, first.event],
      nativeArtifacts: [first.artifact, second.artifact],
    });

    expect(graph.contextDiffs).toHaveLength(1);
    expect(graph.contextDiffs[0]).toMatchObject({
      fromRuntimeEventId: 'model-1',
      toRuntimeEventId: 'model-2',
      basis: 'adjacent-native-source-sequence',
    });
    expect(graph.contextDiffs[0]?.added.map((item) => item.descriptor).sort()).toEqual([
      'messages:assistant',
      'tools:Write',
    ]);
    expect(graph.contextDiffs[0]?.removed).toEqual([]);
    expect(graph.contextDiffs[0]?.retained).toHaveLength(3);
    expect(graph.edges.filter((edge) => edge.kind === 'causal')).toEqual([]);
    expect(
      graph.unavailable.some((boundary) => boundary.kind === 'signed-payload-verification'),
    ).toBe(true);
    expect(JSON.stringify(graph)).not.toContain('fix the widget');
    expect(JSON.stringify(graph)).not.toContain('provider-opaque-signature');
  });

  it('links an explicit tool to files and explicit test records to those files', () => {
    const tool = runtimeFixture({
      runtimeEventId: 'tool-1',
      sourceSequence: 20,
      semanticKind: 'tool',
      nativeEventType: 'tool_call',
      native: {
        type: 'tool_call',
        tool_call_id: 'call-write-1',
        name: 'Write',
        input: { file_path: 'src/widget.ts' },
        result: {
          tests: [
            {
              type: 'test_result',
              test_id: 'widget-test-1',
              name: 'widget unit',
              target_file: 'src/widget.ts',
              test_file: 'src/widget.test.ts',
              status: 'passed',
            },
          ],
        },
      },
    });

    const graph = deriveContextGraph({
      runtimeEvents: [tool.event],
      nativeArtifacts: [tool.artifact],
    });
    const toolNode = graph.nodes.find((node) => node.kind === 'tool' && node.label === 'Write');
    const sourceFile = graph.nodes.find(
      (node) => node.kind === 'file' && node.label === 'src/widget.ts',
    );
    const testNode = graph.nodes.find(
      (node) => node.kind === 'test' && node.label === 'widget unit',
    );
    expect(toolNode).toBeDefined();
    expect(sourceFile).toBeDefined();
    expect(testNode).toBeDefined();
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: 'tool-file',
        fromNodeId: toolNode?.nodeId,
        toNodeId: sourceFile?.nodeId,
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: 'file-test',
        fromNodeId: sourceFile?.nodeId,
        toNodeId: testNode?.nodeId,
      }),
    );
  });

  it('derives subagent lineage only from explicit child and parent fields', () => {
    const spawn = runtimeFixture({
      runtimeEventId: 'subagent-1',
      sourceSequence: 30,
      semanticKind: 'subagent',
      nativeEventType: 'subagent.spawn',
      native: {
        type: 'subagent_spawn',
        subagent_id: 'worker-7',
        parent_agent_id: 'root-agent',
      },
    });
    const unrelated = runtimeFixture({
      runtimeEventId: 'subagent-2',
      sourceSequence: 31,
      semanticKind: 'subagent',
      nativeEventType: 'subagent.output',
      native: { type: 'subagent_output', subagent_id: 'worker-8' },
    });

    const graph = deriveContextGraph({
      runtimeEvents: [spawn.event, unrelated.event],
      nativeArtifacts: [spawn.artifact, unrelated.artifact],
    });
    const lineage = graph.edges.filter((edge) => edge.kind === 'subagent-lineage');
    expect(lineage).toHaveLength(1);
    expect(graph.nodes.find((node) => node.nodeId === lineage[0]?.fromNodeId)?.label).toBe(
      'root-agent',
    );
    expect(graph.nodes.find((node) => node.nodeId === lineage[0]?.toNodeId)?.label).toBe(
      'worker-7',
    );
  });

  it('accepts timeline projection input and makes unobservable boundaries explicit', () => {
    const valid = runtimeFixture({
      runtimeEventId: 'timeline-event',
      sourceSequence: 1,
      causalParentIds: ['not-supplied'],
      fidelity: 'opaque',
      redactionCount: 1,
    });
    const missingArtifactEvent = runtimeFixture({
      runtimeEventId: 'missing-artifact-event',
      sourceSequence: 2,
    });
    const timeline: MissionTimelineEntry[] = [
      {
        seq: 1,
        occurredAt: valid.event.observedAt,
        recordedAt: valid.event.observedAt,
        category: 'runtime',
        kind: 'runtime.event',
        label: 'runtime event',
        data: valid.event as unknown as JsonValue,
      },
      {
        seq: 2,
        occurredAt: valid.event.observedAt,
        recordedAt: valid.event.observedAt,
        category: 'attempt',
        kind: 'attempt.started',
        label: 'not runtime evidence',
        data: missingArtifactEvent.event as unknown as JsonValue,
      },
    ];

    const graph = deriveContextGraph({ timeline, nativeArtifacts: [valid.artifact] });
    expect(graph.runtimeEventCount).toBe(1);
    expect(graph.nodes.some((node) => node.nodeId === 'runtime-event:timeline-event')).toBe(true);
    expect(graph.nodes.some((node) => node.nodeId === 'runtime-event:missing-artifact-event')).toBe(
      false,
    );
    expect(new Set(graph.unavailable.map((boundary) => boundary.kind))).toEqual(
      expect.objectContaining(
        new Set([
          'hidden-model-state',
          'provider-kv-cache',
          'redacted-native-content',
          'opaque-runtime-event',
          'causal-parent-unresolved',
        ]),
      ),
    );
  });

  it('refuses to interpret artifact content that fails the Event IR digest', () => {
    const fixture = runtimeFixture({
      runtimeEventId: 'integrity-event',
      sourceSequence: 1,
      semanticKind: 'tool',
      nativeEventType: 'tool_call',
      native: { type: 'tool_call', name: 'Write', file_path: 'src/real.ts' },
    });
    const tampered: NativeArtifactContent = {
      ...fixture.artifact,
      content: '{"type":"tool_call","name":"Delete","file_path":"src/wrong.ts"}\n',
    };

    const graph = deriveContextGraph({
      runtimeEvents: [fixture.event],
      nativeArtifacts: [tampered],
    });
    expect(
      graph.unavailable.some((boundary) => boundary.kind === 'native-artifact-integrity'),
    ).toBe(true);
    expect(graph.nodes.some((node) => node.label === 'src/wrong.ts')).toBe(false);
  });

  it('binds the exact controller prompt artifact to its Attempt without claiming hidden context', () => {
    const runtime = runtimeFixture({ runtimeEventId: 'runtime-after-prompt', sourceSequence: 1 });
    const content = 'Objective: repair the Agent behavior\n';
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
    const artifactId = `artifact-${sha256}`;
    const timeline: MissionTimelineEntry[] = [
      {
        seq: 1,
        occurredAt: runtime.event.observedAt,
        recordedAt: runtime.event.observedAt,
        attemptId: runtime.event.attemptId,
        category: 'runtime',
        kind: 'context.controller_prompt',
        label: 'Observable controller context recorded',
        data: {
          contextSnapshotId: 'context-snapshot-1',
          attemptId: runtime.event.attemptId,
          stageId: 'stage-1',
          nativeArtifact: {
            artifactId,
            sha256,
            relativePath: `sha256/${sha256.slice(0, 2)}/${sha256}.txt`,
            mediaType: 'text/plain',
            byteLength: Buffer.byteLength(content),
            sanitized: true,
            redactionCount: 0,
          },
          unavailable: ['complete_effective_context', 'hidden_chain_of_thought', 'kv_cache'],
        },
      },
      {
        seq: 2,
        occurredAt: runtime.event.observedAt,
        recordedAt: runtime.event.observedAt,
        attemptId: runtime.event.attemptId,
        category: 'runtime',
        kind: 'runtime.event',
        label: 'Runtime event',
        data: runtime.event as unknown as JsonValue,
      },
    ];
    const graph = deriveContextGraph({
      timeline,
      nativeArtifacts: [runtime.artifact, { artifactId, sha256, mediaType: 'text/plain', content }],
    });

    const prompt = graph.nodes.find((node) => node.label === 'controller prompt · stage-1');
    expect(prompt).toBeDefined();
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        fromNodeId: 'runtime-event:runtime-after-prompt',
        toNodeId: prompt?.nodeId,
        basis: 'controller-prompt-binding',
      }),
    );
    expect(graph.unavailable.some((boundary) => boundary.kind === 'hidden-model-state')).toBe(true);
    expect(graph.unavailable.some((boundary) => boundary.kind === 'provider-kv-cache')).toBe(true);
    expect(JSON.stringify(graph)).not.toContain('repair the Agent behavior');
  });
});

interface RuntimeFixtureOptions {
  readonly runtimeEventId: string;
  readonly sourceSequence: number;
  readonly observedAt?: string;
  readonly semanticKind?: AgentRuntimeEventV1['semanticKind'];
  readonly nativeEventType?: string;
  readonly causalParentIds?: readonly string[];
  readonly correlationIds?: readonly string[];
  readonly fidelity?: AgentRuntimeEventV1['fidelity'];
  readonly redactionCount?: number;
  readonly native?: JsonValue;
}

function runtimeFixture(options: RuntimeFixtureOptions): {
  readonly event: AgentRuntimeEventV1;
  readonly artifact: NativeArtifactContent;
} {
  const native = options.native ?? { type: options.nativeEventType ?? 'runtime.event' };
  const content = `${JSON.stringify(native)}\n`;
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const artifactId = `artifact-${sha256}`;
  const artifactRef: NativeArtifactRefV1 = {
    artifactId,
    sha256,
    relativePath: `sha256/${sha256.slice(0, 2)}/${sha256}.json`,
    mediaType: 'application/json',
    byteLength: Buffer.byteLength(content, 'utf8'),
    sanitized: true,
    redactionCount: options.redactionCount ?? 0,
  };
  return {
    event: {
      runtimeEventId: options.runtimeEventId,
      missionId: 'mission-1',
      branchId: 'branch-1',
      attemptId: 'attempt-1',
      bindingId: 'binding-1',
      planNodeId: 'stage-1',
      sourceHarness: 'codex',
      sourceProtocol: 'codex-jsonl',
      sourceId: 'attempt-1:codex:codex-jsonl:stdout',
      sourceSequence: options.sourceSequence,
      nativeEventType: options.nativeEventType ?? 'runtime.event',
      semanticKind: options.semanticKind ?? 'runtime',
      causalParentIds: options.causalParentIds ?? [],
      correlationIds: options.correlationIds ?? [],
      observedAt: options.observedAt ?? '2026-08-25T00:00:00.000Z',
      fidelity: options.fidelity ?? 'native',
      normalized: {
        nativeEventType: options.nativeEventType ?? 'runtime.event',
        sourceSequence: options.sourceSequence,
      },
      nativeArtifact: artifactRef,
    },
    artifact: {
      artifactId,
      sha256,
      mediaType: 'application/json',
      content,
    },
  };
}
