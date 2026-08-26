import { existsSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import {
  MISSION_SPEC_VERSION,
  isSupportedHarnessV1,
  type AttemptProfileSpecV1,
  type HarnessIdV1,
  type AttemptStageSpecV1,
  type MissionContextSpecV1,
  type MissionPlanEdgeRelationSpecV1,
  type MissionPlanEdgeSpecV1,
  type MissionPlanGraphSpecV1,
  type MissionPlanNodeKindSpecV1,
  type MissionPlanNodeSpecV1,
} from './spec.js';

const ROOT_FIELDS = new Set([
  'title',
  'objective',
  'workspace',
  'constraints',
  'context',
  'verifier',
  'acceptanceCriteria',
  'stages',
  'plan',
]);
const VERIFIER_FIELDS = new Set(['executable', 'args', 'timeoutMs']);
const ACCEPTANCE_CRITERION_FIELDS = new Set(['id', 'description', 'verifier']);
const PLAN_FIELDS = new Set(['nodes', 'edges']);
const PLAN_NODE_FIELDS = new Set([
  'nodeId',
  'kind',
  'title',
  'requirementIds',
  'stageId',
  'acceptanceCriterionIds',
  'declaredOutputKeys',
  'requiredAuthorityScopes',
]);
const PLAN_EDGE_FIELDS = new Set(['fromNodeId', 'toNodeId', 'relation', 'evidenceRefs']);
const STAGE_FIELDS = new Set([
  'stageId',
  'harness',
  'adapterId',
  'providerWorkspaceRef',
  'model',
  'reasoningEffort',
  'permissionMode',
  'injectionBudgetTokens',
  'instruction',
  'breakpoint',
]);
const SHELL_EXECUTABLES = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'csh',
  'tcsh',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
]);
const CODEX_PERMISSION_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const QODER_PERMISSION_MODES = new Set([
  'default',
  'plan',
  'auto',
  'bypass_permissions',
  'accept_edits',
  'dont_ask',
]);
const CLAUDE_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
]);

export interface MissionDraftVerifierInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export interface MissionDraftAcceptanceCriterionInput {
  readonly id: string;
  readonly description: string;
  readonly verifier: MissionDraftVerifierInput;
}

export interface MissionDraftStageInput {
  readonly stageId: string;
  readonly harness: HarnessIdV1;
  readonly adapterId?: string;
  readonly providerWorkspaceRef?: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly permissionMode?: string;
  readonly injectionBudgetTokens: number;
  /**
   * When omitted, a bounded role description is derived from the ordered route.
   * It does not imply that MissionBraid selected or optimized that route.
   */
  readonly instruction?: string;
  readonly breakpoint?: 'mutable-tools';
}

export interface MissionDraftContextInput {
  readonly factId: string;
  /** Current Context source, relative to the Mission workspace or absolute. */
  readonly source: string;
  /** Cached Context document, relative to the Mission workspace or absolute. */
  readonly snapshot: string;
}

export interface MissionDraftInput {
  readonly title: string;
  readonly objective: string;
  readonly workspace: string;
  readonly constraints?: readonly string[];
  readonly context?: MissionDraftContextInput;
  /** Legacy shorthand for one `mission-outcome` acceptance criterion. */
  readonly verifier?: MissionDraftVerifierInput;
  /** Explicit criteria are required by independently verified Plan nodes. */
  readonly acceptanceCriteria?: readonly MissionDraftAcceptanceCriterionInput[];
  readonly stages: readonly MissionDraftStageInput[];
  readonly plan?: MissionPlanGraphSpecV1;
}

export interface MissionDraftDocumentV1 {
  readonly schemaVersion: typeof MISSION_SPEC_VERSION;
  readonly title: string;
  readonly objective: string;
  readonly workspace: string;
  readonly constraints: readonly string[];
  readonly context?: MissionContextSpecV1;
  readonly acceptanceCriteria: readonly {
    readonly id: string;
    readonly description: string;
    readonly verifier: {
      readonly kind: 'command';
      readonly executable: string;
      readonly args: readonly string[];
      readonly cwd: string;
      readonly timeoutMs: number;
    };
  }[];
  readonly attemptPlan: readonly AttemptStageSpecV1[];
  readonly plan?: MissionPlanGraphSpecV1;
}

export interface MissionDraftOutput {
  /** Pure data suitable for writing as a Mission YAML document. */
  readonly document: MissionDraftDocumentV1;
  /** UTF-8 text suitable for a `.yaml` file. No file is written here. */
  readonly yaml: string;
}

export class MissionDraftError extends Error {}

/**
 * Convert an untrusted local-console payload into the existing Mission v1
 * document. This function performs no file-system or process operations.
 */
export function createMissionDraft(input: unknown): MissionDraftOutput {
  assertNoCredentialMaterial(input, 'input');
  const root = requireStrictRecord(input, 'input', ROOT_FIELDS);
  const title = requireNonEmptyString(root.title, 'input.title');
  const objective = requireNonEmptyString(root.objective, 'input.objective');
  const workspace = requireAbsoluteWorkspace(root.workspace);
  const constraints =
    root.constraints === undefined
      ? []
      : requireArray(root.constraints, 'input.constraints').map((constraint, index) =>
          requireNonEmptyString(constraint, `input.constraints[${String(index)}]`),
        );
  const context = root.context === undefined ? undefined : parseContext(root.context, workspace);
  const acceptanceCriteria = parseAcceptanceCriteria(root, workspace);
  const stageRecords = requireArray(root.stages, 'input.stages');
  if (stageRecords.length < 1 || stageRecords.length > 3) {
    throw new MissionDraftError(
      'input.stages must contain between one and three ordered Runtime Profiles',
    );
  }
  const parsedStages = stageRecords.map((stage, index) => parseStage(stage, index));
  assertUniqueStageIds(parsedStages);
  const plan =
    root.plan === undefined
      ? undefined
      : parsePlan(root.plan, constraints, acceptanceCriteria, parsedStages);
  const attemptPlan = parsedStages.map((stage, index): AttemptStageSpecV1 => {
    const instruction = stage.instruction ?? defaultStageInstruction(parsedStages, index);
    return {
      stageId: stage.stageId,
      profile: stage.profile,
      instruction,
      ...(stage.breakpoint === undefined ? {} : { breakpoint: stage.breakpoint }),
      // `attemptPlan` remains the ordered fallback route when an explicit DAG
      // is also present. Plan-node execution has its own failure semantics and
      // does not consume this field, while `/resume` must still be able to move
      // from a failed non-terminal Runtime to the next declared candidate.
      onFailure: index !== parsedStages.length - 1 ? 'handoff' : 'stop',
    };
  });

  const document: MissionDraftDocumentV1 = {
    schemaVersion: MISSION_SPEC_VERSION,
    title,
    objective,
    workspace,
    constraints,
    ...(context === undefined ? {} : { context }),
    acceptanceCriteria,
    attemptPlan,
    ...(plan === undefined ? {} : { plan }),
  };
  assertNoCredentialMaterial(document, 'mission');
  return {
    document,
    yaml: stringifyYaml(document, { lineWidth: 0 }),
  };
}

interface ParsedStage {
  readonly stageId: string;
  readonly profile: AttemptProfileSpecV1;
  readonly instruction?: string;
  readonly breakpoint?: 'mutable-tools';
}

function parseVerifier(
  value: unknown,
  workspace: string,
  path = 'input.verifier',
): MissionDraftDocumentV1['acceptanceCriteria'][number]['verifier'] {
  const verifier = requireStrictRecord(value, path, VERIFIER_FIELDS);
  const executable = requireNonEmptyString(verifier.executable, `${path}.executable`);
  if (SHELL_EXECUTABLES.has(basename(executable).toLowerCase())) {
    throw new MissionDraftError(
      `${path}.executable must invoke the verifier directly, not through a shell`,
    );
  }
  const args = requireArray(verifier.args, `${path}.args`).map((argument, index) =>
    requireNonEmptyString(argument, `${path}.args[${String(index)}]`),
  );
  return {
    kind: 'command',
    executable,
    args,
    cwd: workspace,
    timeoutMs: requirePositiveInteger(verifier.timeoutMs, `${path}.timeoutMs`),
  };
}

function parseAcceptanceCriteria(
  root: Record<string, unknown>,
  workspace: string,
): MissionDraftDocumentV1['acceptanceCriteria'] {
  if (root.acceptanceCriteria === undefined) {
    return [
      {
        id: 'mission-outcome',
        description: 'The declared verifier exits successfully for the original Mission objective.',
        verifier: parseVerifier(root.verifier, workspace),
      },
    ];
  }
  if (root.verifier !== undefined) {
    throw new MissionDraftError('input must use either verifier or acceptanceCriteria, not both');
  }
  const criteria = requireArray(root.acceptanceCriteria, 'input.acceptanceCriteria').map(
    (candidate, index) => {
      const path = `input.acceptanceCriteria[${String(index)}]`;
      const criterion = requireStrictRecord(candidate, path, ACCEPTANCE_CRITERION_FIELDS);
      return {
        id: requireIdentifier(criterion.id, `${path}.id`),
        description: requireNonEmptyString(criterion.description, `${path}.description`),
        verifier: parseVerifier(criterion.verifier, workspace, `${path}.verifier`),
      };
    },
  );
  if (criteria.length === 0) {
    throw new MissionDraftError('input.acceptanceCriteria must not be empty');
  }
  assertUniqueStrings(
    criteria.map((criterion) => criterion.id),
    'input.acceptanceCriteria contains duplicate id values',
  );
  return criteria;
}

function parsePlan(
  value: unknown,
  constraints: readonly string[],
  acceptanceCriteria: MissionDraftDocumentV1['acceptanceCriteria'],
  stages: readonly ParsedStage[],
): MissionPlanGraphSpecV1 {
  const plan = requireStrictRecord(value, 'input.plan', PLAN_FIELDS);
  const knownStageIds = new Set(stages.map((stage) => stage.stageId));
  const knownCriterionIds = new Set(acceptanceCriteria.map((criterion) => criterion.id));
  const knownRequirementIds = new Set([
    'objective',
    ...constraints.map((_constraint, index) => `constraint-${String(index + 1)}`),
    ...acceptanceCriteria.map((criterion) => `acceptance-${criterion.id}`),
  ]);
  const nodes = requireArray(plan.nodes, 'input.plan.nodes').map(
    (candidate, index): MissionPlanNodeSpecV1 => {
      const path = `input.plan.nodes[${String(index)}]`;
      const node = requireStrictRecord(candidate, path, PLAN_NODE_FIELDS);
      const nodeId = requireIdentifier(node.nodeId, `${path}.nodeId`);
      const stageId = requireIdentifier(node.stageId, `${path}.stageId`);
      if (!knownStageIds.has(stageId)) {
        throw new MissionDraftError(`${path}.stageId references unknown stage ${stageId}`);
      }
      const requirementIds = requireIdentifierArray(node.requirementIds, `${path}.requirementIds`);
      if (requirementIds.length === 0) {
        throw new MissionDraftError(`${path}.requirementIds must not be empty`);
      }
      for (const requirementId of requirementIds) {
        if (!knownRequirementIds.has(requirementId)) {
          throw new MissionDraftError(
            `${path}.requirementIds references unknown Contract requirement ${requirementId}`,
          );
        }
      }
      const acceptanceCriterionIds = requireIdentifierArray(
        node.acceptanceCriterionIds,
        `${path}.acceptanceCriterionIds`,
      );
      for (const criterionId of acceptanceCriterionIds) {
        if (!knownCriterionIds.has(criterionId)) {
          throw new MissionDraftError(
            `${path}.acceptanceCriterionIds references unknown criterion ${criterionId}`,
          );
        }
      }
      return {
        nodeId,
        kind: requirePlanNodeKind(node.kind, `${path}.kind`),
        title: requireNonEmptyString(node.title, `${path}.title`),
        requirementIds,
        stageId,
        acceptanceCriterionIds,
        declaredOutputKeys: requireStringArray(
          node.declaredOutputKeys,
          `${path}.declaredOutputKeys`,
        ),
        requiredAuthorityScopes: requireStringArray(
          node.requiredAuthorityScopes,
          `${path}.requiredAuthorityScopes`,
        ),
      };
    },
  );
  if (nodes.length === 0) throw new MissionDraftError('input.plan.nodes must not be empty');
  assertUniqueStrings(
    nodes.map((node) => node.nodeId),
    'input.plan.nodes contains duplicate nodeId values',
  );
  assertUniqueStrings(
    nodes.map((node) => node.stageId),
    'input.plan.nodes must bind each stageId to only one node',
  );

  const knownNodeIds = new Set(nodes.map((node) => node.nodeId));
  const edges = requireArray(plan.edges, 'input.plan.edges').map(
    (candidate, index): MissionPlanEdgeSpecV1 => {
      const path = `input.plan.edges[${String(index)}]`;
      const edge = requireStrictRecord(candidate, path, PLAN_EDGE_FIELDS);
      const fromNodeId = requireIdentifier(edge.fromNodeId, `${path}.fromNodeId`);
      const toNodeId = requireIdentifier(edge.toNodeId, `${path}.toNodeId`);
      if (!knownNodeIds.has(fromNodeId) || !knownNodeIds.has(toNodeId)) {
        throw new MissionDraftError(`${path} references an unknown plan node`);
      }
      if (fromNodeId === toNodeId) {
        throw new MissionDraftError(`${path} cannot point to the same node`);
      }
      return {
        fromNodeId,
        toNodeId,
        relation: requirePlanEdgeRelation(edge.relation, `${path}.relation`),
        evidenceRefs: requireStringArray(edge.evidenceRefs, `${path}.evidenceRefs`),
      };
    },
  );
  assertUniqueStrings(
    edges.map((edge) => `${edge.fromNodeId}\0${edge.toNodeId}\0${edge.relation}`),
    'input.plan.edges contains duplicate edges',
  );
  return { nodes, edges };
}

function parseContext(value: unknown, workspace: string): MissionContextSpecV1 {
  const context = requireStrictRecord(
    value,
    'input.context',
    new Set(['factId', 'source', 'snapshot']),
  );
  const factId = requireIdentifier(context.factId, 'input.context.factId');
  return {
    factId,
    source: resolveContextPath(
      requireNonEmptyString(context.source, 'input.context.source'),
      workspace,
      'input.context.source',
    ),
    snapshot: resolveContextPath(
      requireNonEmptyString(context.snapshot, 'input.context.snapshot'),
      workspace,
      'input.context.snapshot',
    ),
  };
}

function resolveContextPath(value: string, workspace: string, path: string): string {
  const candidate = canonicalizePath(
    resolve(isAbsolute(value) ? value : resolve(workspace, value)),
  );
  const relativePath = relative(canonicalizePath(workspace), candidate);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new MissionDraftError(`${path} must remain inside input.workspace`);
  }
  return candidate;
}

function canonicalizePath(value: string): string {
  return existsSync(value) ? realpathSync(value) : value;
}

function parseStage(value: unknown, index: number): ParsedStage {
  const path = `input.stages[${String(index)}]`;
  const stage = requireStrictRecord(value, path, STAGE_FIELDS);
  const stageId = requireIdentifier(stage.stageId, `${path}.stageId`);
  const adapterId =
    stage.adapterId === undefined
      ? undefined
      : requireIdentifier(stage.adapterId, `${path}.adapterId`);
  const harness = requireHarness(stage.harness, `${path}.harness`, adapterId);
  const providerWorkspaceRef =
    stage.providerWorkspaceRef === undefined
      ? undefined
      : requireNonEmptyString(stage.providerWorkspaceRef, `${path}.providerWorkspaceRef`);
  if (providerWorkspaceRef !== undefined && adapterId === undefined) {
    throw new MissionDraftError(`${path}.providerWorkspaceRef requires ${path}.adapterId`);
  }
  const permissionMode =
    stage.permissionMode === undefined
      ? undefined
      : requirePermissionMode(stage.permissionMode, harness, adapterId, `${path}.permissionMode`);
  const instruction =
    stage.instruction === undefined
      ? undefined
      : requireNonEmptyString(stage.instruction, `${path}.instruction`);
  const breakpoint =
    stage.breakpoint === undefined
      ? undefined
      : requireBreakpoint(stage.breakpoint, harness, `${path}.breakpoint`);
  if (adapterId !== undefined && breakpoint !== undefined) {
    throw new MissionDraftError(
      `${path}.breakpoint is not available through the generic Adapter v1 host`,
    );
  }
  return {
    stageId,
    profile: {
      harness,
      ...(adapterId === undefined ? {} : { adapterId }),
      ...(providerWorkspaceRef === undefined ? {} : { providerWorkspaceRef }),
      model: requireNonEmptyString(stage.model, `${path}.model`),
      ...(stage.reasoningEffort === undefined
        ? {}
        : {
            reasoningEffort: requireNonEmptyString(
              stage.reasoningEffort,
              `${path}.reasoningEffort`,
            ),
          }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      injectionBudgetTokens: requirePositiveInteger(
        stage.injectionBudgetTokens,
        `${path}.injectionBudgetTokens`,
      ),
    },
    ...(instruction === undefined ? {} : { instruction }),
    ...(breakpoint === undefined ? {} : { breakpoint }),
  };
}

function requireBreakpoint(value: unknown, harness: HarnessIdV1, path: string): 'mutable-tools' {
  if (value !== 'mutable-tools') {
    throw new MissionDraftError(`${path} must be mutable-tools`);
  }
  if (harness !== 'claude') {
    throw new MissionDraftError(`${path} currently requires Claude Code`);
  }
  return value;
}

function defaultStageInstruction(stages: readonly ParsedStage[], index: number): string {
  const current = stages[index]!;
  if (
    stages.length === 2 &&
    stages[0]?.profile.harness === 'codex' &&
    stages[1]?.profile.harness === 'qoder'
  ) {
    return index === 0
      ? 'Make a coherent primary implementation for the Mission. Preserve the workspace state and identify remaining work for the planned Qoder continuation. Do not claim final verification; the Mission controller owns verification.'
      : 'Continue the same Mission from the existing workspace and controller-provided Handoff Capsule. Acknowledge the Capsule before changing files, preserve accepted Codex work, complete the remaining acceptance criteria, and leave the workspace ready for the declared verifier.';
  }
  if (stages.length === 1) {
    return `Complete the Mission objective with ${displayHarness(current.profile.harness)} in the provided workspace, then leave the workspace ready for the declared verifier. The Mission controller, not the runtime, decides the verified outcome.`;
  }
  return index === 0
    ? `Make a coherent first-stage contribution with ${displayHarness(current.profile.harness)} and preserve the workspace for the next planned Runtime Profile. Do not claim final verification.`
    : `Continue the same Mission with ${displayHarness(current.profile.harness)} from the existing workspace and controller-provided Handoff Capsule, preserve accepted prior work, and leave the workspace ready for the declared verifier.`;
}

function displayHarness(harness: HarnessIdV1): string {
  if (harness === 'codex') return 'Codex';
  if (harness === 'qoder') return 'Qoder';
  if (harness === 'claude') return 'Claude Code';
  return harness;
}

function requireStrictRecord(
  value: unknown,
  path: string,
  allowedFields: ReadonlySet<string>,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MissionDraftError(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedFields.has(key)) {
      throw new MissionDraftError(`${path} contains unsupported field ${key}`);
    }
  }
  return record;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new MissionDraftError(`${path} must be an array`);
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MissionDraftError(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function requireIdentifier(value: unknown, path: string): string {
  const identifier = requireNonEmptyString(value, path);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(identifier)) {
    throw new MissionDraftError(`${path} contains unsupported characters`);
  }
  return identifier;
}

function requireIdentifierArray(value: unknown, path: string): string[] {
  const identifiers = requireArray(value, path).map((candidate, index) =>
    requireIdentifier(candidate, `${path}[${String(index)}]`),
  );
  assertUniqueStrings(identifiers, `${path} contains duplicate values`);
  return identifiers;
}

function requireStringArray(value: unknown, path: string): string[] {
  const strings = requireArray(value, path).map((candidate, index) =>
    requireNonEmptyString(candidate, `${path}[${String(index)}]`),
  );
  assertUniqueStrings(strings, `${path} contains duplicate values`);
  return strings;
}

function requirePlanNodeKind(value: unknown, path: string): MissionPlanNodeKindSpecV1 {
  if (
    value !== 'task' &&
    value !== 'review' &&
    value !== 'diagnostic' &&
    value !== 'branch' &&
    value !== 'join'
  ) {
    throw new MissionDraftError(`${path} has an unsupported plan node kind`);
  }
  return value;
}

function requirePlanEdgeRelation(value: unknown, path: string): MissionPlanEdgeRelationSpecV1 {
  if (
    value !== 'depends-on' &&
    value !== 'review-input' &&
    value !== 'diagnostic-input' &&
    value !== 'branch-input' &&
    value !== 'join-input'
  ) {
    throw new MissionDraftError(`${path} has an unsupported plan edge relation`);
  }
  return value;
}

function requireAbsoluteWorkspace(value: unknown): string {
  const workspace = requireNonEmptyString(value, 'input.workspace');
  if (!isAbsolute(workspace)) {
    throw new MissionDraftError('input.workspace must be an absolute path');
  }
  return canonicalizePath(resolve(workspace));
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new MissionDraftError(`${path} must be a positive integer`);
  }
  return value;
}

function requireHarness(value: unknown, path: string, adapterId?: string): HarnessIdV1 {
  const harness = requireIdentifier(value, path);
  if (adapterId === undefined && !isSupportedHarnessV1(harness)) {
    throw new MissionDraftError(`${path} must be codex, qoder, or claude`);
  }
  return harness;
}

function requirePermissionMode(
  value: unknown,
  harness: HarnessIdV1,
  adapterId: string | undefined,
  path: string,
): string {
  const permissionMode = requireNonEmptyString(value, path);
  if (adapterId !== undefined) return permissionMode;
  const supported =
    harness === 'codex'
      ? CODEX_PERMISSION_MODES
      : harness === 'qoder'
        ? QODER_PERMISSION_MODES
        : CLAUDE_PERMISSION_MODES;
  if (!supported.has(permissionMode)) {
    throw new MissionDraftError(`${path} is not supported by ${displayHarness(harness)}`);
  }
  return permissionMode;
}

function assertUniqueStageIds(stages: readonly ParsedStage[]): void {
  const ids = stages.map((stage) => stage.stageId);
  if (new Set(ids).size !== ids.length) {
    throw new MissionDraftError('input.stages contains duplicate stageId values');
  }
}

function assertUniqueStrings(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) throw new MissionDraftError(message);
}

function assertNoCredentialMaterial(
  value: unknown,
  path: string,
  seen = new WeakSet<object>(),
): void {
  if (typeof value === 'string') {
    if (looksLikeCredentialValue(value)) {
      throw new MissionDraftError(`Credential-like value at ${path} is not accepted`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new MissionDraftError(`${path} must not contain cyclic values`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((member, index) =>
      assertNoCredentialMaterial(member, `${path}[${String(index)}]`, seen),
    );
    return;
  }
  const blockedSuffixes = [
    'apikey',
    'authorization',
    'credential',
    'credentials',
    'password',
    'passwd',
    'privatekey',
    'refreshtoken',
    'secret',
    'token',
    'accesstoken',
  ];
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
    if (blockedSuffixes.some((suffix) => normalizedKey.endsWith(suffix))) {
      throw new MissionDraftError(`Credential-like field ${path}.${key} is not accepted`);
    }
    assertNoCredentialMaterial(member, `${path}.${key}`, seen);
  }
}

function looksLikeCredentialValue(value: string): boolean {
  return [
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*[:=]\s*[^\s,;]+/i,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/i,
    /\b(?:ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/i,
    /\bAKIA[A-Z0-9]{12,}\b/,
    /^--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|authorization)(?:=|$)/i,
  ].some((pattern) => pattern.test(value));
}
