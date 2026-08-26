import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { NativeArtifactContent } from './artifact-store.js';
import type { AgentRuntimeEventV1, NativeArtifactRefV1, RuntimeSemanticKindV1 } from './domain.js';
import {
  extractRuntimeSemanticFacts,
  RuntimeSemanticInputError,
  type RuntimeSemanticFactV1,
} from './runtime-semantics.js';

describe('runtime semantic extraction', () => {
  it('extracts Codex command, test, usage, and workspace facts without copying commands or paths', () => {
    const started = fixture('codex-jsonl', 'item.started', 'tool', {
      type: 'item.started',
      item: {
        id: 'command-item-1',
        type: 'command_execution',
        command: 'pnpm test --filter private-package-name',
        status: 'in_progress',
      },
    });
    const startedFacts = extractRuntimeSemanticFacts(started.event, started.artifact);
    expect(startedFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool_request',
          toolName: 'shell',
          evidence: 'explicit',
          fidelity: 'native',
        }),
        expect.objectContaining({
          kind: 'test_run',
          phase: 'started',
          status: 'unknown',
          evidence: 'derived',
        }),
      ]),
    );
    expect(JSON.stringify(startedFacts)).not.toContain('pnpm test');
    expect(JSON.stringify(startedFacts)).not.toContain('private-package-name');

    const completed = fixture('codex-jsonl', 'item.completed', 'tool', {
      type: 'item.completed',
      item: {
        id: 'command-item-1',
        type: 'command_execution',
        command: 'pnpm test --filter private-package-name',
        status: 'completed',
        exit_code: 0,
        aggregated_output: 'private test output',
      },
    });
    expect(extractRuntimeSemanticFacts(completed.event, completed.artifact)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool_result',
          phase: 'completed',
          exitCode: 0,
        }),
        expect.objectContaining({ kind: 'test_run', status: 'passed', exitCode: 0 }),
      ]),
    );

    const shellWrapped = fixture('codex-jsonl', 'item.completed', 'tool', {
      type: 'item.completed',
      item: {
        id: 'command-item-shell-wrapper',
        type: 'command_execution',
        command: "/bin/zsh -lc 'node --test'",
        status: 'failed',
        exit_code: 1,
      },
    });
    expect(extractRuntimeSemanticFacts(shellWrapped.event, shellWrapped.artifact)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'test_run', status: 'failed', exitCode: 1 }),
      ]),
    );

    const changed = fixture('codex-jsonl', 'item.completed', 'workspace', {
      type: 'item.completed',
      item: {
        id: 'file-item-1',
        type: 'file_change',
        status: 'completed',
        changes: [
          { path: 'src/private-customer-name.ts', kind: 'update' },
          { path: 'test/new-file.test.ts', kind: 'add' },
        ],
      },
    });
    const workspaceFact = fact(
      extractRuntimeSemanticFacts(changed.event, changed.artifact),
      'workspace_change',
    );
    expect(workspaceFact).toMatchObject({
      evidence: 'explicit',
      changeCount: 2,
      changeKinds: expect.arrayContaining(['updated', 'added']),
    });
    if (workspaceFact.kind !== 'workspace_change') {
      throw new Error('Expected a workspace_change fact');
    }
    expect(workspaceFact.pathDigests).toHaveLength(2);
    expect(JSON.stringify(workspaceFact)).not.toContain('private-customer-name');

    const turn = fixture('codex-jsonl', 'turn.completed', 'turn', {
      type: 'turn.completed',
      usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 },
    });
    expect(extractRuntimeSemanticFacts(turn.event, turn.artifact)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'model_call', phase: 'completed', evidence: 'derived' }),
        expect.objectContaining({
          kind: 'usage',
          inputTokens: 120,
          cachedInputTokens: 20,
          outputTokens: 30,
          totalTokens: 150,
        }),
      ]),
    );
  });

  it('extracts Claude messages, tool requests, results, and explicit parent lineage without content', () => {
    const assistant = fixture('claude-stream-json', 'assistant', 'message', {
      type: 'assistant',
      session_id: 'session-claude-1',
      parent_tool_use_id: 'task-parent-1',
      message: {
        id: 'message-claude-1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet',
        content: [
          { type: 'text', text: 'private assistant content' },
          {
            type: 'tool_use',
            id: 'tool-read-1',
            name: 'Read',
            input: { file_path: '/private/customer/repository.ts' },
          },
        ],
      },
    });
    const assistantFacts = extractRuntimeSemanticFacts(assistant.event, assistant.artifact);
    expect(assistantFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'model_call', phase: 'completed', evidence: 'derived' }),
        expect.objectContaining({
          kind: 'message',
          role: 'assistant',
          hasText: true,
          hasToolRequest: true,
        }),
        expect.objectContaining({ kind: 'tool_request', toolName: 'Read', evidence: 'explicit' }),
        expect.objectContaining({ kind: 'subagent_started', evidence: 'derived' }),
      ]),
    );
    const serialized = JSON.stringify(assistantFacts);
    expect(serialized).not.toContain('private assistant content');
    expect(serialized).not.toContain('/private/customer');
    expect(serialized).not.toContain('task-parent-1');
    expect(serialized).toContain('sha256:');

    const user = fixture('claude-stream-json', 'user', 'message', {
      type: 'user',
      session_id: 'session-claude-1',
      message: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-read-1',
            content: 'private tool result',
            is_error: false,
          },
        ],
      },
    });
    const userFacts = extractRuntimeSemanticFacts(user.event, user.artifact);
    expect(userFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'message', role: 'user', hasToolResult: true }),
        expect.objectContaining({ kind: 'tool_result', isError: false }),
      ]),
    );
    expect(JSON.stringify(userFacts)).not.toContain('private tool result');

    const failedNodeTest = fixture('claude-stream-json', 'user', 'message', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-test-1',
            content: '✖ behavior contract\nℹ tests 1\nℹ pass 0\nℹ fail 1\nEXIT: 1',
            is_error: false,
          },
        ],
      },
    });
    expect(extractRuntimeSemanticFacts(failedNodeTest.event, failedNodeTest.artifact)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'test_run',
          status: 'failed',
          exitCode: 1,
          evidence: 'derived',
        }),
      ]),
    );
    expect(
      JSON.stringify(extractRuntimeSemanticFacts(failedNodeTest.event, failedNodeTest.artifact)),
    ).not.toContain('behavior contract');

    const failedNodeTestWithNativeExit = fixture('claude-stream-json', 'user', 'message', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-test-2',
            content: 'Exit code 1\n✖ behavior contract\nℹ tests 1\nℹ pass 0\nℹ fail 1',
            is_error: true,
          },
        ],
      },
    });
    expect(
      extractRuntimeSemanticFacts(
        failedNodeTestWithNativeExit.event,
        failedNodeTestWithNativeExit.artifact,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'test_run',
          status: 'failed',
          exitCode: 1,
          evidence: 'derived',
        }),
      ]),
    );
  });

  it('extracts Qoder initialization, usage, and explicit subagent lifecycle shapes', () => {
    const init = fixture('qoder-stream-json', 'system', 'session', {
      type: 'system',
      subtype: 'init',
      session_id: 'qoder-session-1',
      model: 'Qwen3.8-Max',
      tools: ['Read', 'Write'],
      skills: ['project-skill'],
      mcp_servers: [{ name: 'filesystem', status: 'connected' }],
    });
    expect(extractRuntimeSemanticFacts(init.event, init.artifact)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'context',
          contextKind: 'runtime_environment',
          toolCount: 2,
          skillCount: 1,
          mcpServerCount: 1,
          evidence: 'explicit',
        }),
      ]),
    );

    const result = fixture('qoder-stream-json', 'result', 'turn', {
      type: 'result',
      subtype: 'success',
      session_id: 'qoder-session-1',
      total_cost_usd: 0.015,
      usage: { input_tokens: 400, output_tokens: 60 },
      result: 'private final response',
    });
    const resultFacts = extractRuntimeSemanticFacts(result.event, result.artifact);
    expect(resultFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'model_call', phase: 'completed', evidence: 'derived' }),
        expect.objectContaining({
          kind: 'usage',
          inputTokens: 400,
          outputTokens: 60,
          totalTokens: 460,
          costUsd: 0.015,
        }),
      ]),
    );
    expect(JSON.stringify(resultFacts)).not.toContain('private final response');

    const started = fixture('qoder-stream-json', 'task_started', 'subagent', {
      type: 'system',
      subtype: 'task_started',
      task_id: 'subagent-task-1',
      parent_tool_use_id: 'parent-tool-1',
    });
    expect(extractRuntimeSemanticFacts(started.event, started.artifact)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'subagent_started',
          phase: 'started',
          evidence: 'explicit',
        }),
      ]),
    );

    const finished = fixture('qoder-stream-json', 'task_notification', 'subagent', {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'subagent-task-1',
      parent_tool_use_id: 'parent-tool-1',
      status: 'failed',
      error: { message: 'private subagent failure detail' },
    });
    const finishedFacts = extractRuntimeSemanticFacts(finished.event, finished.artifact);
    expect(finishedFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'subagent_finished',
          phase: 'failed',
          evidence: 'explicit',
        }),
        expect.objectContaining({ kind: 'failure', isError: true, evidence: 'explicit' }),
      ]),
    );
    expect(JSON.stringify(finishedFacts)).not.toContain('private subagent failure detail');
  });

  it('joins Qoder tool-result envelopes to their structured exit status', () => {
    const failedTool = fixture('qoder-stream-json', 'user', 'tool', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'qoder-shell-call-1',
            content: 'private command output',
          },
        ],
      },
      tool_use_result: {
        kind: 'completed',
        stdout: 'private command output',
        stderr: '',
        exitCode: 17,
        isError: true,
      },
    });

    const facts = extractRuntimeSemanticFacts(failedTool.event, failedTool.artifact);
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool_result',
          phase: 'failed',
          exitCode: 17,
          isError: true,
          evidence: 'explicit',
        }),
        expect.objectContaining({
          kind: 'failure',
          failureKind: 'tool',
          isError: true,
          evidence: 'explicit',
        }),
      ]),
    );
    expect(facts.filter((candidate) => candidate.kind === 'tool_result')).toHaveLength(1);
    expect(
      facts.some(
        (candidate) => candidate.kind === 'failure' && candidate.failureKind === 'runtime',
      ),
    ).toBe(false);
    expect(JSON.stringify(facts)).not.toContain('private command output');
  });

  it('uses unknown evidence for bounded fallbacks and never invents adjacency causality', () => {
    const unknown = fixture(
      'codex-jsonl',
      'provider-specific-context-record',
      'context',
      { type: 'provider_specific_record', opaque: true },
      {
        causalParentIds: ['runtime-event-explicit-parent'],
      },
    );
    const facts = extractRuntimeSemanticFacts(unknown.event, unknown.artifact);
    expect(facts).toEqual([
      expect.objectContaining({
        kind: 'context',
        contextKind: 'unknown',
        evidence: 'unknown',
      }),
    ]);
    expect(facts[0]).not.toHaveProperty('causalParentIds');
    expect(facts[0]).not.toHaveProperty('previousEventId');
  });

  it('rejects artifact content that is not hash-bound to the Runtime event', () => {
    const bound = fixture('claude-stream-json', 'assistant', 'message', {
      type: 'assistant',
      message: { type: 'message', role: 'assistant', content: [] },
    });
    expect(() =>
      extractRuntimeSemanticFacts(bound.event, {
        ...bound.artifact,
        content: '{"type":"assistant","message":{"role":"user"}}\n',
      }),
    ).toThrow(RuntimeSemanticInputError);
  });
});

function fact(
  facts: readonly RuntimeSemanticFactV1[],
  kind: RuntimeSemanticFactV1['kind'],
): RuntimeSemanticFactV1 {
  const value = facts.find((candidate) => candidate.kind === kind);
  if (value === undefined) throw new Error(`Missing ${kind} fact`);
  return value;
}

function fixture(
  sourceProtocol: AgentRuntimeEventV1['sourceProtocol'],
  nativeEventType: string,
  semanticKind: RuntimeSemanticKindV1,
  value: unknown,
  overrides: Partial<AgentRuntimeEventV1> = {},
): { readonly event: AgentRuntimeEventV1; readonly artifact: NativeArtifactContent } {
  const content = `${JSON.stringify(value)}\n`;
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const artifactRef: NativeArtifactRefV1 = {
    artifactId: `artifact-${sha256}`,
    sha256,
    relativePath: `sha256/${sha256.slice(0, 2)}/${sha256}.json`,
    mediaType: 'application/json',
    byteLength: Buffer.byteLength(content, 'utf8'),
    sanitized: true,
    redactionCount: 0,
  };
  const runtime = sourceProtocol.startsWith('codex')
    ? 'codex'
    : sourceProtocol.startsWith('qoder')
      ? 'qoder'
      : 'claude';
  const event: AgentRuntimeEventV1 = {
    runtimeEventId: `runtime-event-${sha256.slice(0, 24)}`,
    missionId: 'mission-semantic-fixture',
    branchId: 'branch-root-semantic-fixture',
    attemptId: 'attempt-semantic-fixture',
    bindingId: 'binding-semantic-fixture',
    planNodeId: 'stage-semantic-fixture',
    sourceHarness: runtime,
    sourceProtocol,
    sourceId: `attempt-semantic-fixture:${runtime}:${sourceProtocol}:stdout`,
    sourceSequence: 1,
    nativeEventType,
    semanticKind,
    causalParentIds: [],
    correlationIds: [],
    observedAt: '2026-08-26T00:00:00.000Z',
    fidelity: 'native',
    normalized: {},
    nativeArtifact: artifactRef,
    ...overrides,
  };
  return {
    event,
    artifact: {
      artifactId: artifactRef.artifactId,
      sha256,
      mediaType: 'application/json',
      content,
    },
  };
}
