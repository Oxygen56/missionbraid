import { createHash } from 'node:crypto';

import type { NativeArtifactContent } from './artifact-store.js';
import type { AgentRuntimeEventV1, NativeArtifactRefV1, RuntimeSemanticKindV1 } from './domain.js';

export const RUNTIME_SEMANTIC_FACT_SCHEMA_VERSION = 1 as const;

export type RuntimeSemanticEvidenceV1 = 'explicit' | 'derived' | 'unknown';

export type RuntimeSemanticFactKindV1 =
  | 'model_call'
  | 'context'
  | 'message'
  | 'tool_request'
  | 'tool_result'
  | 'workspace_change'
  | 'test_run'
  | 'subagent_started'
  | 'subagent_finished'
  | 'usage'
  | 'failure';

export type RuntimeSemanticPhaseV1 = 'started' | 'running' | 'completed' | 'failed' | 'unknown';

export interface RuntimeSemanticFactBaseV1 {
  readonly schemaVersion: typeof RUNTIME_SEMANTIC_FACT_SCHEMA_VERSION;
  readonly factId: string;
  readonly kind: RuntimeSemanticFactKindV1;
  readonly sourceRuntimeEventId: string;
  readonly sourceHarness: string;
  readonly sourceProtocol: string;
  readonly artifact: NativeArtifactRefV1;
  readonly fidelity: AgentRuntimeEventV1['fidelity'];
  readonly evidence: RuntimeSemanticEvidenceV1;
}

export type RuntimeSemanticFactV1 = RuntimeSemanticFactBaseV1 & RuntimeSemanticFactDetailsV1;

type RuntimeSemanticFactDetailsV1 =
  | {
      readonly kind: 'model_call';
      readonly phase: RuntimeSemanticPhaseV1;
      readonly nativeIdDigest?: string;
    }
  | {
      readonly kind: 'context';
      readonly contextKind: 'runtime_environment' | 'model_input' | 'compaction' | 'unknown';
      readonly itemCount?: number;
      readonly toolCount?: number;
      readonly skillCount?: number;
      readonly mcpServerCount?: number;
      readonly messageCount?: number;
    }
  | {
      readonly kind: 'message';
      readonly role: 'system' | 'user' | 'assistant' | 'tool' | 'unknown';
      readonly nativeIdDigest?: string;
      readonly partCount?: number;
      readonly hasText?: boolean;
      readonly hasToolRequest?: boolean;
      readonly hasToolResult?: boolean;
    }
  | {
      readonly kind: 'tool_request';
      readonly toolName?: string;
      readonly toolCallIdDigest?: string;
      readonly parentToolCallIdDigest?: string;
    }
  | {
      readonly kind: 'tool_result';
      readonly toolName?: string;
      readonly toolCallIdDigest?: string;
      readonly parentToolCallIdDigest?: string;
      readonly phase: RuntimeSemanticPhaseV1;
      readonly isError?: boolean;
      readonly exitCode?: number;
    }
  | {
      readonly kind: 'workspace_change';
      readonly changeCount: number;
      readonly pathDigests: readonly string[];
      readonly changeKinds: readonly ('added' | 'updated' | 'deleted' | 'unknown')[];
    }
  | {
      readonly kind: 'test_run';
      readonly phase: RuntimeSemanticPhaseV1;
      readonly status: 'passed' | 'failed' | 'unknown';
      readonly exitCode?: number;
      readonly toolCallIdDigest?: string;
    }
  | {
      readonly kind: 'subagent_started' | 'subagent_finished';
      readonly actorIdDigest?: string;
      readonly parentActorIdDigest?: string;
      readonly phase: RuntimeSemanticPhaseV1;
    }
  | {
      readonly kind: 'usage';
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly cachedInputTokens?: number;
      readonly totalTokens?: number;
      readonly costUsd?: number;
    }
  | {
      readonly kind: 'failure';
      readonly failureKind: 'model' | 'tool' | 'runtime' | 'unknown';
      readonly codeDigest?: string;
      readonly isError: true;
    };

interface Candidate {
  readonly identity: string;
  readonly evidence: RuntimeSemanticEvidenceV1;
  readonly details: RuntimeSemanticFactDetailsV1;
}

interface VisitContext {
  readonly path: string;
  readonly inheritedRole?: Extract<RuntimeSemanticFactDetailsV1, { kind: 'message' }>['role'];
  readonly inheritedPhase?: RuntimeSemanticPhaseV1;
  readonly parentKey?: string;
  readonly parentToolId?: string;
}

interface UsageNumbers {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
}

export class RuntimeSemanticInputError extends Error {}

/**
 * Extracts bounded semantic facts from one already-sanitized native artifact.
 *
 * The parser is deliberately stateless. It never uses event arrival order as a
 * causal signal, never returns message text, tool arguments, shell commands, or
 * raw paths, and hashes native identifiers before exposing them.
 */
export function extractRuntimeSemanticFacts(
  event: AgentRuntimeEventV1,
  artifact: NativeArtifactContent,
): RuntimeSemanticFactV1[] {
  assertArtifactBinding(event, artifact);
  const parsed = parseArtifact(artifact);
  const candidates: Candidate[] = [];

  if (parsed !== undefined) {
    visit(parsed, { path: '$' }, candidates);
  }

  if (candidates.length === 0) {
    const fallback = fallbackCandidate(event.semanticKind, event.nativeEventType);
    if (fallback !== undefined) candidates.push(fallback);
  }

  return deduplicateCandidates(candidates).map((candidate) => ({
    schemaVersion: RUNTIME_SEMANTIC_FACT_SCHEMA_VERSION,
    factId: `semantic-fact-${sha256(
      `${event.runtimeEventId}\0${candidate.details.kind}\0${candidate.identity}`,
    ).slice(0, 32)}`,
    sourceRuntimeEventId: event.runtimeEventId,
    sourceHarness: event.sourceHarness,
    sourceProtocol: event.sourceProtocol,
    artifact: { ...event.nativeArtifact },
    fidelity: event.fidelity,
    evidence: candidate.evidence,
    ...candidate.details,
  }));
}

function visit(value: unknown, context: VisitContext, candidates: Candidate[]): void {
  if (Array.isArray(value)) {
    value.forEach((member, index) => {
      visit(member, { ...context, path: `${context.path}[${String(index)}]` }, candidates);
    });
    return;
  }
  if (!isRecord(value)) return;

  const record = value;
  const tags = recordTags(record);
  const phase = phaseFromRecord(tags, record, context.inheritedPhase);
  const explicitRole = messageRole(record.role);
  const wrapperRole = roleFromTags(tags);
  const role = explicitRole ?? wrapperRole ?? context.inheritedRole;
  const nativeId = nativeIdentifier(record);
  const parentToolId = explicitParentIdentifier(record) ?? context.parentToolId;
  const identity = nativeId ?? context.path;
  const handledToolResult = structuredToolResultEnvelope(record)?.result;

  extractContext(record, tags, identity, candidates);
  extractMessage(record, tags, role, identity, candidates);
  extractModelCall(record, tags, role, phase, identity, candidates);
  const tool = extractTool(record, tags, phase, nativeId, parentToolId, identity, candidates);
  extractWorkspaceChange(record, tags, identity, candidates);
  extractSubagent(record, tags, phase, nativeId, parentToolId, tool, identity, candidates);
  extractUsage(record, tags, identity, candidates);
  extractFailure(record, tags, phase, tool, identity, candidates);

  const childPhase = wrapperPhase(tags, phase);
  const childRole = wrapperRole ?? explicitRole ?? context.inheritedRole;
  const childParentToolId = nativeId ?? parentToolId;
  for (const [key, member] of Object.entries(record)) {
    if (member === handledToolResult) continue;
    visit(
      member,
      {
        path: `${context.path}.${key}`,
        ...(childRole === undefined ? {} : { inheritedRole: childRole }),
        ...(childPhase === undefined ? {} : { inheritedPhase: childPhase }),
        parentKey: key,
        ...(childParentToolId === undefined ? {} : { parentToolId: childParentToolId }),
      },
      candidates,
    );
  }
}

function extractContext(
  record: Record<string, unknown>,
  tags: readonly string[],
  identity: string,
  candidates: Candidate[],
): void {
  const init = tags.includes('init') && tags.includes('system');
  const contextEvent = tags.some((tag) =>
    ['context', 'context_snapshot', 'model_input', 'prompt_snapshot'].includes(tag),
  );
  const compaction = tags.some((tag) => tag.includes('compact'));
  if (!init && !contextEvent && !compaction) return;

  const tools = arrayLength(record.tools);
  const skills = arrayLength(record.skills);
  const mcpServers = arrayLength(record.mcp_servers ?? record.mcpServers);
  const messages = arrayLength(record.messages);
  const itemCount =
    arrayLength(record.items) ?? arrayLength(record.content) ?? arrayLength(record.context);
  candidates.push({
    identity: `context:${identity}`,
    evidence: 'explicit',
    details: {
      kind: 'context',
      contextKind: compaction ? 'compaction' : init ? 'runtime_environment' : 'model_input',
      ...(itemCount === undefined ? {} : { itemCount }),
      ...(tools === undefined ? {} : { toolCount: tools }),
      ...(skills === undefined ? {} : { skillCount: skills }),
      ...(mcpServers === undefined ? {} : { mcpServerCount: mcpServers }),
      ...(messages === undefined ? {} : { messageCount: messages }),
    },
  });
}

function extractMessage(
  record: Record<string, unknown>,
  tags: readonly string[],
  inheritedRole: VisitContext['inheritedRole'],
  identity: string,
  candidates: Candidate[],
): void {
  const hasNestedMessage = isRecord(record.message);
  const explicitMessage =
    tags.includes('message') ||
    tags.includes('agent_message') ||
    tags.includes('assistant_message') ||
    tags.includes('user_message') ||
    record.role !== undefined;
  const wrapperOnly = hasNestedMessage && tags.some((tag) => ['assistant', 'user'].includes(tag));
  if (!explicitMessage || wrapperOnly) return;

  const role = messageRole(record.role) ?? roleFromTags(tags) ?? inheritedRole ?? 'unknown';
  const content = record.content;
  const parts = Array.isArray(content) ? content : content === undefined ? undefined : [content];
  const partRecords = (parts ?? []).filter(isRecord);
  candidates.push({
    identity: `message:${identity}`,
    evidence: 'explicit',
    details: {
      kind: 'message',
      role,
      ...(nativeIdentifier(record) === undefined
        ? {}
        : { nativeIdDigest: digestIdentifier(nativeIdentifier(record)!) }),
      ...(parts === undefined ? {} : { partCount: parts.length }),
      ...(parts === undefined
        ? {}
        : {
            hasText:
              parts.some((part) => typeof part === 'string') ||
              partRecords.some((part) => recordTags(part).includes('text')),
            hasToolRequest: partRecords.some((part) => isToolRequest(recordTags(part), part)),
            hasToolResult: partRecords.some((part) => isToolResult(recordTags(part), part)),
          }),
    },
  });
}

function extractModelCall(
  record: Record<string, unknown>,
  tags: readonly string[],
  role: VisitContext['inheritedRole'],
  phase: RuntimeSemanticPhaseV1,
  identity: string,
  candidates: Candidate[],
): void {
  const explicit = tags.some((tag) =>
    [
      'model_call',
      'model_request',
      'model_response',
      'response_created',
      'response_completed',
    ].includes(tag),
  );
  const derived =
    role === 'assistant' ||
    tags.some((tag) =>
      [
        'assistant',
        'agent_message',
        'turn_started',
        'turn_completed',
        'turn_failed',
        'result',
      ].includes(tag),
    );
  if (!explicit && !derived) return;

  const nativeId = nativeIdentifier(record) ?? nestedString(record.message, 'id');
  candidates.push({
    identity: `model:${nativeId ?? identity}`,
    evidence: explicit ? 'explicit' : 'derived',
    details: {
      kind: 'model_call',
      phase:
        phase !== 'unknown'
          ? phase
          : role === 'assistant' || tags.includes('result')
            ? 'completed'
            : 'unknown',
      ...(nativeId === undefined ? {} : { nativeIdDigest: digestIdentifier(nativeId) }),
    },
  });
}

function extractTool(
  record: Record<string, unknown>,
  tags: readonly string[],
  phase: RuntimeSemanticPhaseV1,
  nativeId: string | undefined,
  parentToolId: string | undefined,
  identity: string,
  candidates: Candidate[],
): {
  readonly request: boolean;
  readonly result: boolean;
  readonly failed: boolean;
  readonly name?: string;
} {
  const wrappedResult = structuredToolResultEnvelope(record);
  const request = isToolRequest(tags, record);
  const result = isToolResult(tags, record) || wrappedResult !== undefined;
  const name = toolName(record, tags);
  const toolCallId = wrappedResult?.toolCallId ?? nativeId ?? toolResultIdentifier(record);
  const toolIdentity = toolCallId ?? identity;
  const resultRecord = wrappedResult?.result ?? record;
  const exitCode = result
    ? safeInteger(
        resultRecord.exit_code ?? resultRecord.exitCode ?? record.exit_code ?? record.exitCode,
      )
    : undefined;
  const explicitIsError = result
    ? boolean(resultRecord.is_error ?? resultRecord.isError ?? record.is_error ?? record.isError)
    : undefined;
  const isError =
    explicitIsError ?? (phase === 'failed' ? true : phase === 'completed' ? false : undefined);
  const resultFailed = result && (isError === true || (exitCode !== undefined && exitCode !== 0));

  if (request) {
    candidates.push({
      identity: `tool-request:${toolIdentity}`,
      evidence: 'explicit',
      details: {
        kind: 'tool_request',
        ...(name === undefined ? {} : { toolName: name }),
        ...(toolCallId === undefined ? {} : { toolCallIdDigest: digestIdentifier(toolCallId) }),
        ...(parentToolId === undefined
          ? {}
          : { parentToolCallIdDigest: digestIdentifier(parentToolId) }),
      },
    });
  }
  if (result) {
    const resultPhase = resultFailed
      ? 'failed'
      : phase !== 'unknown'
        ? phase
        : normalizedStatus(resultRecord.status ?? resultRecord.kind);
    candidates.push({
      identity: `tool-result:${toolIdentity}`,
      evidence: 'explicit',
      details: {
        kind: 'tool_result',
        ...(name === undefined ? {} : { toolName: name }),
        ...(toolCallId === undefined ? {} : { toolCallIdDigest: digestIdentifier(toolCallId) }),
        ...(parentToolId === undefined
          ? {}
          : { parentToolCallIdDigest: digestIdentifier(parentToolId) }),
        phase: resultPhase,
        ...(isError === undefined ? {} : { isError }),
        ...(exitCode === undefined ? {} : { exitCode }),
      },
    });
  }

  const command = commandText(record);
  const structuredTestOutput = testOutput(record);
  if (
    (command !== undefined && looksLikeTestCommand(command)) ||
    structuredTestOutput !== undefined
  ) {
    const exitCode =
      safeInteger(record.exit_code ?? record.exitCode) ?? structuredTestOutput?.exitCode;
    candidates.push({
      identity: `test:${toolIdentity}`,
      evidence: 'derived',
      details: {
        kind: 'test_run',
        phase: result ? phase : request ? 'started' : phase,
        status: exitCode === undefined ? 'unknown' : exitCode === 0 ? 'passed' : 'failed',
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(toolCallId === undefined ? {} : { toolCallIdDigest: digestIdentifier(toolCallId) }),
      },
    });
  } else if (tags.some((tag) => ['test_run', 'tests_started', 'tests_completed'].includes(tag))) {
    const exitCode = safeInteger(record.exit_code ?? record.exitCode);
    candidates.push({
      identity: `test:${identity}`,
      evidence: 'explicit',
      details: {
        kind: 'test_run',
        phase,
        status:
          exitCode === undefined ? statusFromRecord(record) : exitCode === 0 ? 'passed' : 'failed',
        ...(exitCode === undefined ? {} : { exitCode }),
      },
    });
  }

  return { request, result, failed: resultFailed, ...(name === undefined ? {} : { name }) };
}

function extractWorkspaceChange(
  record: Record<string, unknown>,
  tags: readonly string[],
  identity: string,
  candidates: Candidate[],
): void {
  if (
    !tags.some((tag) =>
      ['file_change', 'workspace_change', 'patch', 'patch_apply', 'apply_patch'].includes(tag),
    )
  ) {
    return;
  }

  const changes = Array.isArray(record.changes) ? record.changes : [record];
  const paths = uniqueStrings(changes.flatMap((change) => collectPaths(change)));
  const kinds = uniqueStrings(changes.map((change) => changeKind(change))) as (
    | 'added'
    | 'updated'
    | 'deleted'
    | 'unknown'
  )[];
  candidates.push({
    identity: `workspace:${identity}`,
    evidence: 'explicit',
    details: {
      kind: 'workspace_change',
      changeCount: Array.isArray(record.changes)
        ? record.changes.length
        : Math.max(paths.length, 1),
      pathDigests: paths.map(digestIdentifier),
      changeKinds: kinds.length === 0 ? ['unknown'] : kinds,
    },
  });
}

function extractSubagent(
  record: Record<string, unknown>,
  tags: readonly string[],
  phase: RuntimeSemanticPhaseV1,
  nativeId: string | undefined,
  parentId: string | undefined,
  tool: { readonly request: boolean; readonly result: boolean; readonly name?: string },
  identity: string,
  candidates: Candidate[],
): void {
  const explicitStart = tags.some((tag) =>
    ['subagent_started', 'agent_started', 'task_started'].includes(tag),
  );
  const explicitFinish = tags.some((tag) =>
    ['subagent_finished', 'agent_finished', 'task_finished', 'task_completed'].includes(tag),
  );
  const taskNotification = tags.includes('task_notification');
  const toolNamesSubagent =
    tool.name !== undefined && ['agent', 'task', 'subagent'].includes(tool.name.toLowerCase());
  const messageFromSubagent =
    parentId !== undefined &&
    tags.some((tag) => ['assistant', 'user', 'message', 'agent_message'].includes(tag));

  const started = explicitStart || (tool.request && toolNamesSubagent) || messageFromSubagent;
  const finished =
    explicitFinish ||
    (tool.result && toolNamesSubagent) ||
    (taskNotification && ['completed', 'failed'].includes(normalizedStatus(record.status)));
  const actorId = nativeId ?? (messageFromSubagent ? parentId : undefined);

  if (started) {
    candidates.push({
      identity: `subagent-start:${actorId ?? identity}`,
      evidence: explicitStart ? 'explicit' : 'derived',
      details: {
        kind: 'subagent_started',
        ...(actorId === undefined ? {} : { actorIdDigest: digestIdentifier(actorId) }),
        ...(parentId === undefined ? {} : { parentActorIdDigest: digestIdentifier(parentId) }),
        phase: phase === 'unknown' ? 'started' : phase,
      },
    });
  }
  if (finished) {
    candidates.push({
      identity: `subagent-finish:${actorId ?? identity}`,
      evidence: explicitFinish || taskNotification ? 'explicit' : 'derived',
      details: {
        kind: 'subagent_finished',
        ...(actorId === undefined ? {} : { actorIdDigest: digestIdentifier(actorId) }),
        ...(parentId === undefined ? {} : { parentActorIdDigest: digestIdentifier(parentId) }),
        phase: phase === 'unknown' ? 'completed' : phase,
      },
    });
  }
}

function extractUsage(
  record: Record<string, unknown>,
  tags: readonly string[],
  identity: string,
  candidates: Candidate[],
): void {
  const usage = usageNumbers(record);
  if (Object.keys(usage).length === 0) return;
  candidates.push({
    identity: `usage:${nativeIdentifier(record) ?? identity}:${tags.join(':')}`,
    evidence: 'explicit',
    details: { kind: 'usage', ...usage },
  });
}

function extractFailure(
  record: Record<string, unknown>,
  tags: readonly string[],
  phase: RuntimeSemanticPhaseV1,
  tool: { readonly request: boolean; readonly result: boolean; readonly failed: boolean },
  identity: string,
  candidates: Candidate[],
): void {
  const status = normalizedStatus(record.status ?? record.subtype);
  const explicit =
    phase === 'failed' ||
    status === 'failed' ||
    record.is_error === true ||
    record.isError === true ||
    tool.failed ||
    tags.some((tag) => tag === 'error' || tag.endsWith('_failed') || tag === 'failure');
  if (!explicit) return;

  const code = firstString(record, ['code', 'error_code', 'errorCode']);
  candidates.push({
    identity: `failure:${nativeIdentifier(record) ?? identity}`,
    evidence: 'explicit',
    details: {
      kind: 'failure',
      failureKind:
        tool.request || tool.result
          ? 'tool'
          : tags.some((tag) => tag.includes('model'))
            ? 'model'
            : 'runtime',
      ...(code === undefined ? {} : { codeDigest: digestIdentifier(code) }),
      isError: true,
    },
  });
}

function structuredToolResultEnvelope(
  record: Record<string, unknown>,
): { readonly result: Record<string, unknown>; readonly toolCallId?: string } | undefined {
  const result = isRecord(record.tool_use_result)
    ? record.tool_use_result
    : isRecord(record.toolUseResult)
      ? record.toolUseResult
      : undefined;
  if (result === undefined) return undefined;

  const message = isRecord(record.message) ? record.message : undefined;
  const content = message?.content;
  const toolResultPart = Array.isArray(content)
    ? content.find(
        (part): part is Record<string, unknown> =>
          isRecord(part) && isToolResult(recordTags(part), part),
      )
    : undefined;
  if (toolResultPart === undefined) return undefined;

  const toolCallId = toolResultIdentifier(toolResultPart);
  return { result, ...(toolCallId === undefined ? {} : { toolCallId }) };
}

function fallbackCandidate(
  semanticKind: RuntimeSemanticKindV1,
  nativeEventType: string,
): Candidate | undefined {
  const identity = `fallback:${nativeEventType}`;
  switch (semanticKind) {
    case 'model':
    case 'turn':
      return {
        identity,
        evidence: 'unknown',
        details: { kind: 'model_call', phase: 'unknown' },
      };
    case 'context':
      return {
        identity,
        evidence: 'unknown',
        details: { kind: 'context', contextKind: 'unknown' },
      };
    case 'message':
      return {
        identity,
        evidence: 'unknown',
        details: { kind: 'message', role: 'unknown' },
      };
    case 'workspace':
      return {
        identity,
        evidence: 'unknown',
        details: {
          kind: 'workspace_change',
          changeCount: 0,
          pathDigests: [],
          changeKinds: ['unknown'],
        },
      };
    case 'subagent':
      return {
        identity,
        evidence: 'unknown',
        details: { kind: 'subagent_started', phase: 'unknown' },
      };
    case 'usage':
      return { identity, evidence: 'unknown', details: { kind: 'usage' } };
    case 'failure':
      return {
        identity,
        evidence: 'unknown',
        details: { kind: 'failure', failureKind: 'unknown', isError: true },
      };
    case 'tool': {
      const normalized = normalizeTag(nativeEventType);
      if (normalized.includes('result') || normalized.includes('output')) {
        return {
          identity,
          evidence: 'unknown',
          details: { kind: 'tool_result', phase: 'unknown' },
        };
      }
      if (
        normalized.includes('request') ||
        normalized.includes('call') ||
        normalized.includes('use')
      ) {
        return { identity, evidence: 'unknown', details: { kind: 'tool_request' } };
      }
      return undefined;
    }
    case 'runtime':
    case 'session':
    case 'unknown':
      return undefined;
  }
}

function isToolRequest(tags: readonly string[], record: Record<string, unknown>): boolean {
  if (
    tags.some((tag) => ['tool_use', 'tool_call', 'tool_request', 'function_call'].includes(tag))
  ) {
    return true;
  }
  if (!tags.some((tag) => ['command_execution', 'mcp_tool_call'].includes(tag))) return false;
  const status = normalizedStatus(record.status);
  return status === 'started' || status === 'running' || status === 'unknown';
}

function isToolResult(tags: readonly string[], record: Record<string, unknown>): boolean {
  if (
    tags.some((tag) =>
      ['tool_result', 'tool_output', 'function_call_output', 'mcp_tool_result'].includes(tag),
    )
  ) {
    return true;
  }
  if (!tags.some((tag) => ['command_execution', 'mcp_tool_call'].includes(tag))) return false;
  const status = normalizedStatus(record.status);
  return status === 'completed' || status === 'failed';
}

function toolName(record: Record<string, unknown>, tags: readonly string[]): string | undefined {
  if (tags.includes('command_execution')) return 'shell';
  const functionRecord = isRecord(record.function) ? record.function : undefined;
  const candidate =
    firstString(record, ['name', 'tool_name', 'toolName']) ??
    (functionRecord === undefined ? undefined : firstString(functionRecord, ['name']));
  if (candidate === undefined) return tags.includes('mcp_tool_call') ? 'mcp' : undefined;
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return undefined;
  if (!/^[A-Za-z][A-Za-z0-9_.:/-]*$/.test(trimmed)) return undefined;
  return trimmed;
}

function commandText(record: Record<string, unknown>): string | undefined {
  const command = record.command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.every((member) => typeof member === 'string')) {
    return command.join(' ');
  }
  return undefined;
}

function testOutput(record: Record<string, unknown>): { readonly exitCode?: number } | undefined {
  const candidates = [record.content, record.stdout, record.stderr].filter(
    (value): value is string => typeof value === 'string',
  );
  for (const candidate of candidates) {
    const nodeTestSummary =
      /(?:^|\n)[\s\S]*?(?:ℹ\s+tests\s+\d+|\b(?:pass|fail|tests)\s+\d+\b)/i.test(candidate) &&
      /(?:^|\n)(?:✔|✖|ℹ|TAP version\s+\d+)/m.test(candidate);
    const genericTestSummary =
      /(?:^|\n)(?:FAILED|PASSED|FAIL|PASS)\b/m.test(candidate) &&
      /(?:test|spec|suite)/i.test(candidate);
    if (!nodeTestSummary && !genericTestSummary) continue;
    const exitMatch = /(?:^|\n)(?:Error:\s*)?(?:EXIT:|Exit code)\s*(-?\d+)\s*(?:\n|$)/im.exec(
      candidate,
    );
    const exitCode = exitMatch?.[1] === undefined ? undefined : Number(exitMatch[1]);
    return Number.isSafeInteger(exitCode) ? { exitCode: exitCode as number } : {};
  }
  return undefined;
}

function looksLikeTestCommand(command: string): boolean {
  const candidates = unwrapShellCommand(command.trim().toLowerCase());
  const boundary = '(?:^|[;&|]\\s*)';
  const executable = '(?:[a-z0-9_./-]*/)?';
  const patterns = [
    new RegExp(`${boundary}${executable}(?:pytest|vitest|jest|mocha|rspec|ctest)(?:\\s|$)`),
    new RegExp(`${boundary}${executable}(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test(?:[:\\s]|$)`),
    new RegExp(`${boundary}${executable}(?:node|deno)\\s+--test(?:\\s|$)`),
    new RegExp(`${boundary}${executable}(?:go|cargo|dotnet|mvn|gradle|gradlew)\\s+test(?:\\s|$)`),
  ];
  return candidates.some((candidate) => patterns.some((pattern) => pattern.test(candidate)));
}

function unwrapShellCommand(command: string): readonly string[] {
  const candidates = [command];
  let current = command;
  for (let depth = 0; depth < 2; depth += 1) {
    const match = /^(?:[a-z0-9_./-]*\/)?(?:sh|bash|zsh)\s+-[a-z]*c\s+([\s\S]+)$/.exec(current);
    if (match?.[1] === undefined) break;
    current = stripMatchingQuotes(match[1].trim());
    candidates.push(current);
  }
  return candidates;
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === "'" && last === "'") || (first === '"' && last === '"')
    ? value.slice(1, -1)
    : value;
}

function usageNumbers(record: Record<string, unknown>): UsageNumbers {
  const sources = [record];
  if (isRecord(record.usage)) sources.push(record.usage);
  if (isRecord(record.token_usage)) sources.push(record.token_usage);
  if (isRecord(record.modelUsage))
    sources.push(...Object.values(record.modelUsage).filter(isRecord));

  const firstNumber = (keys: readonly string[]): number | undefined => {
    for (const source of sources) {
      for (const key of keys) {
        const value = safeNumber(source[key]);
        if (value !== undefined) return value;
      }
    }
    return undefined;
  };
  const inputTokens = firstNumber(['input_tokens', 'inputTokens', 'prompt_tokens']);
  const outputTokens = firstNumber(['output_tokens', 'outputTokens', 'completion_tokens']);
  const cachedInputTokens = firstNumber([
    'cached_input_tokens',
    'cache_read_input_tokens',
    'cachedInputTokens',
  ]);
  const explicitTotal = firstNumber(['total_tokens', 'totalTokens']);
  const totalTokens =
    explicitTotal ??
    (inputTokens === undefined && outputTokens === undefined
      ? undefined
      : (inputTokens ?? 0) + (outputTokens ?? 0));
  const costUsd = firstNumber(['total_cost_usd', 'cost_usd', 'costUsd']);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function recordTags(record: Record<string, unknown>): string[] {
  return uniqueStrings(
    ['type', 'event', 'kind', 'subtype'].flatMap((key) => {
      const value = record[key];
      return typeof value === 'string' ? [normalizeTag(value)] : [];
    }),
  );
}

function phaseFromRecord(
  tags: readonly string[],
  record: Record<string, unknown>,
  inherited: RuntimeSemanticPhaseV1 | undefined,
): RuntimeSemanticPhaseV1 {
  const status = normalizedStatus(record.status ?? record.subtype);
  if (status !== 'unknown') return status;
  if (tags.some((tag) => tag.endsWith('_started') || tag.endsWith('_created'))) return 'started';
  if (tags.some((tag) => tag.endsWith('_completed') || tag.endsWith('_finished'))) {
    return 'completed';
  }
  if (tags.some((tag) => tag.endsWith('_failed') || tag === 'error')) return 'failed';
  return inherited ?? 'unknown';
}

function wrapperPhase(
  tags: readonly string[],
  phase: RuntimeSemanticPhaseV1,
): RuntimeSemanticPhaseV1 | undefined {
  return tags.some((tag) =>
    [
      'item_started',
      'item_completed',
      'item_failed',
      'turn_started',
      'turn_completed',
      'turn_failed',
    ].includes(tag),
  )
    ? phase
    : undefined;
}

function normalizedStatus(value: unknown): RuntimeSemanticPhaseV1 {
  if (typeof value !== 'string') return 'unknown';
  const normalized = normalizeTag(value);
  if (['started', 'created', 'pending'].includes(normalized)) return 'started';
  if (['running', 'in_progress'].includes(normalized)) return 'running';
  if (['completed', 'complete', 'finished', 'success', 'succeeded'].includes(normalized)) {
    return 'completed';
  }
  if (['failed', 'failure', 'error'].includes(normalized)) return 'failed';
  return 'unknown';
}

function statusFromRecord(record: Record<string, unknown>): 'passed' | 'failed' | 'unknown' {
  const status = normalizedStatus(record.status ?? record.subtype);
  if (status === 'completed') return 'passed';
  if (status === 'failed') return 'failed';
  return 'unknown';
}

function roleFromTags(
  tags: readonly string[],
): Extract<RuntimeSemanticFactDetailsV1, { kind: 'message' }>['role'] | undefined {
  if (tags.some((tag) => ['assistant', 'assistant_message', 'agent_message'].includes(tag))) {
    return 'assistant';
  }
  if (tags.some((tag) => ['user', 'user_message'].includes(tag))) return 'user';
  if (tags.some((tag) => ['system', 'system_message'].includes(tag))) return 'system';
  if (tags.some((tag) => ['tool', 'tool_message'].includes(tag))) return 'tool';
  return undefined;
}

function messageRole(
  value: unknown,
): Extract<RuntimeSemanticFactDetailsV1, { kind: 'message' }>['role'] | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = normalizeTag(value);
  if (['system', 'user', 'assistant', 'tool'].includes(normalized)) {
    return normalized as 'system' | 'user' | 'assistant' | 'tool';
  }
  return undefined;
}

function nativeIdentifier(record: Record<string, unknown>): string | undefined {
  return (
    firstString(record, [
      'id',
      'uuid',
      'event_id',
      'eventId',
      'tool_use_id',
      'toolCallId',
      'task_id',
      'taskId',
      'agent_id',
      'agentId',
    ]) ?? nestedString(record.message, 'id')
  );
}

function explicitParentIdentifier(record: Record<string, unknown>): string | undefined {
  return firstString(record, [
    'parent_tool_use_id',
    'parentToolUseId',
    'parent_id',
    'parentId',
    'parent_uuid',
    'parentUuid',
  ]);
}

function toolResultIdentifier(record: Record<string, unknown>): string | undefined {
  return firstString(record, ['tool_use_id', 'toolCallId', 'call_id', 'callId']);
}

function collectPaths(value: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (Array.isArray(value)) return value.flatMap((member) => collectPaths(member, depth + 1));
  if (!isRecord(value)) return [];
  const direct = ['path', 'file_path', 'filePath'].flatMap((key) => {
    const candidate = value[key];
    return typeof candidate === 'string' && candidate.length > 0 ? [candidate] : [];
  });
  const nested = ['changes', 'files'].flatMap((key) => collectPaths(value[key], depth + 1));
  return [...direct, ...nested];
}

function changeKind(value: unknown): 'added' | 'updated' | 'deleted' | 'unknown' {
  if (!isRecord(value)) return 'unknown';
  const candidate = normalizeTag(
    firstString(value, ['kind', 'change_kind', 'changeKind', 'status']) ?? '',
  );
  if (['add', 'added', 'create', 'created'].includes(candidate)) return 'added';
  if (['delete', 'deleted', 'remove', 'removed'].includes(candidate)) return 'deleted';
  if (['update', 'updated', 'modify', 'modified'].includes(candidate)) return 'updated';
  return 'unknown';
}

function fallbackEvidenceRank(value: RuntimeSemanticEvidenceV1): number {
  return value === 'explicit' ? 3 : value === 'derived' ? 2 : 1;
}

function deduplicateCandidates(candidates: readonly Candidate[]): Candidate[] {
  const selected = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = `${candidate.details.kind}:${candidate.identity}`;
    const current = selected.get(key);
    if (
      current === undefined ||
      fallbackEvidenceRank(candidate.evidence) > fallbackEvidenceRank(current.evidence) ||
      (candidate.evidence === current.evidence &&
        candidateDetailRank(candidate.details) > candidateDetailRank(current.details))
    ) {
      selected.set(key, candidate);
    }
  }
  return [...selected.values()];
}

function candidateDetailRank(details: RuntimeSemanticFactDetailsV1): number {
  if (details.kind !== 'tool_result') return JSON.stringify(details).length;
  return (
    (details.exitCode === undefined ? 0 : 1_000) +
    (details.isError === undefined ? 0 : 500) +
    (details.phase === 'unknown' ? 0 : 250) +
    (details.toolName === undefined ? 0 : 20) +
    (details.toolCallIdDigest === undefined ? 0 : 10) +
    (details.parentToolCallIdDigest === undefined ? 0 : 5)
  );
}

function assertArtifactBinding(event: AgentRuntimeEventV1, artifact: NativeArtifactContent): void {
  if (
    artifact.artifactId !== event.nativeArtifact.artifactId ||
    artifact.sha256 !== event.nativeArtifact.sha256 ||
    artifact.mediaType !== event.nativeArtifact.mediaType
  ) {
    throw new RuntimeSemanticInputError(
      `Native artifact ${artifact.artifactId} does not match Runtime event ${event.runtimeEventId}`,
    );
  }
  const actualHash = sha256(artifact.content);
  if (actualHash !== artifact.sha256) {
    throw new RuntimeSemanticInputError(
      `Native artifact ${artifact.artifactId} failed semantic-input hash verification`,
    );
  }
}

function parseArtifact(artifact: NativeArtifactContent): unknown | undefined {
  if (artifact.mediaType === 'text/plain') return undefined;
  try {
    return JSON.parse(artifact.content) as unknown;
  } catch {
    throw new RuntimeSemanticInputError(
      `Native artifact ${artifact.artifactId} is labeled JSON but cannot be parsed`,
    );
  }
}

function normalizeTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
}

function digestIdentifier(value: string): string {
  return `sha256:${sha256(value)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function nestedString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
