import { basename, isAbsolute, resolve } from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import {
  MISSION_SPEC_VERSION,
  type AttemptProfileSpecV1,
  type AttemptStageSpecV1,
  type SupportedHarnessV1,
} from './spec.js';

const ROOT_FIELDS = new Set([
  'title',
  'objective',
  'workspace',
  'constraints',
  'verifier',
  'stages',
]);
const VERIFIER_FIELDS = new Set(['executable', 'args', 'timeoutMs']);
const STAGE_FIELDS = new Set([
  'stageId',
  'harness',
  'model',
  'reasoningEffort',
  'permissionMode',
  'injectionBudgetTokens',
  'instruction',
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

export interface MissionDraftStageInput {
  readonly stageId: string;
  readonly harness: SupportedHarnessV1;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly permissionMode?: string;
  readonly injectionBudgetTokens: number;
  /**
   * When omitted, a bounded role description is derived from the ordered route.
   * It does not imply that MissionBraid selected or optimized that route.
   */
  readonly instruction?: string;
}

export interface MissionDraftInput {
  readonly title: string;
  readonly objective: string;
  readonly workspace: string;
  readonly constraints?: readonly string[];
  readonly verifier: MissionDraftVerifierInput;
  readonly stages: readonly MissionDraftStageInput[];
}

export interface MissionDraftDocumentV1 {
  readonly schemaVersion: typeof MISSION_SPEC_VERSION;
  readonly title: string;
  readonly objective: string;
  readonly workspace: string;
  readonly constraints: readonly string[];
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
  const verifier = parseVerifier(root.verifier, workspace);
  const stageRecords = requireArray(root.stages, 'input.stages');
  if (stageRecords.length < 1 || stageRecords.length > 3) {
    throw new MissionDraftError(
      'input.stages must contain between one and three ordered Runtime Profiles',
    );
  }
  const parsedStages = stageRecords.map((stage, index) => parseStage(stage, index));
  assertUniqueStageIds(parsedStages);
  const attemptPlan = parsedStages.map((stage, index): AttemptStageSpecV1 => {
    const instruction = stage.instruction ?? defaultStageInstruction(parsedStages, index);
    return {
      stageId: stage.stageId,
      profile: stage.profile,
      instruction,
      onFailure: index === parsedStages.length - 1 ? 'stop' : 'handoff',
    };
  });

  const document: MissionDraftDocumentV1 = {
    schemaVersion: MISSION_SPEC_VERSION,
    title,
    objective,
    workspace,
    constraints,
    acceptanceCriteria: [
      {
        id: 'mission-outcome',
        description: 'The declared verifier exits successfully for the original Mission objective.',
        verifier,
      },
    ],
    attemptPlan,
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
}

function parseVerifier(
  value: unknown,
  workspace: string,
): MissionDraftDocumentV1['acceptanceCriteria'][number]['verifier'] {
  const verifier = requireStrictRecord(value, 'input.verifier', VERIFIER_FIELDS);
  const executable = requireNonEmptyString(verifier.executable, 'input.verifier.executable');
  if (SHELL_EXECUTABLES.has(basename(executable).toLowerCase())) {
    throw new MissionDraftError(
      'input.verifier.executable must invoke the verifier directly, not through a shell',
    );
  }
  const args = requireArray(verifier.args, 'input.verifier.args').map((argument, index) =>
    requireNonEmptyString(argument, `input.verifier.args[${String(index)}]`),
  );
  return {
    kind: 'command',
    executable,
    args,
    cwd: workspace,
    timeoutMs: requirePositiveInteger(verifier.timeoutMs, 'input.verifier.timeoutMs'),
  };
}

function parseStage(value: unknown, index: number): ParsedStage {
  const path = `input.stages[${String(index)}]`;
  const stage = requireStrictRecord(value, path, STAGE_FIELDS);
  const stageId = requireIdentifier(stage.stageId, `${path}.stageId`);
  const harness = requireHarness(stage.harness, `${path}.harness`);
  const permissionMode =
    stage.permissionMode === undefined
      ? undefined
      : requirePermissionMode(stage.permissionMode, harness, `${path}.permissionMode`);
  const instruction =
    stage.instruction === undefined
      ? undefined
      : requireNonEmptyString(stage.instruction, `${path}.instruction`);
  return {
    stageId,
    profile: {
      harness,
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
  };
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

function displayHarness(harness: SupportedHarnessV1): string {
  if (harness === 'codex') return 'Codex';
  if (harness === 'qoder') return 'Qoder';
  return 'Claude Code';
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

function requireAbsoluteWorkspace(value: unknown): string {
  const workspace = requireNonEmptyString(value, 'input.workspace');
  if (!isAbsolute(workspace)) {
    throw new MissionDraftError('input.workspace must be an absolute path');
  }
  return resolve(workspace);
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new MissionDraftError(`${path} must be a positive integer`);
  }
  return value;
}

function requireHarness(value: unknown, path: string): SupportedHarnessV1 {
  if (value !== 'codex' && value !== 'qoder' && value !== 'claude') {
    throw new MissionDraftError(`${path} must be codex, qoder, or claude`);
  }
  return value;
}

function requirePermissionMode(value: unknown, harness: SupportedHarnessV1, path: string): string {
  const permissionMode = requireNonEmptyString(value, path);
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
