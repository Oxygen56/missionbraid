import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

export const MISSION_SPEC_VERSION = 'missionbraid.dev/mission/v1' as const;
export const MISSION_SPEC_SNAPSHOT_VERSION =
  'missionbraid.dev/resolved-mission-snapshot/v1' as const;

export type SupportedHarnessV1 = 'codex' | 'qoder' | 'claude';

export interface CommandVerifierSpecV1 {
  readonly kind: 'command';
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface MissionAcceptanceSpecV1 {
  readonly id: string;
  readonly description: string;
  readonly verifier: CommandVerifierSpecV1;
}

export interface AttemptProfileSpecV1 {
  readonly harness: SupportedHarnessV1;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly permissionMode?: string;
  readonly injectionBudgetTokens: number;
}

export interface AttemptStageSpecV1 {
  readonly stageId: string;
  readonly profile: AttemptProfileSpecV1;
  readonly instruction: string;
  readonly onFailure: 'stop' | 'handoff';
}

export interface ResolvedMissionSpecV1 {
  readonly schemaVersion: typeof MISSION_SPEC_VERSION;
  readonly title: string;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly workspace: string;
  readonly missionSourceDir: string;
  readonly acceptanceCriteria: readonly MissionAcceptanceSpecV1[];
  readonly attemptPlan: readonly AttemptStageSpecV1[];
}

export interface MissionSpecV1 extends ResolvedMissionSpecV1 {
  /** Original YAML location retained for provenance only. */
  readonly sourceFile: string;
}

export interface MissionSpecSnapshotV1 {
  readonly schemaVersion: typeof MISSION_SPEC_SNAPSHOT_VERSION;
  readonly spec: ResolvedMissionSpecV1;
}

export interface LoadMissionSpecOptions {
  readonly workspace?: string;
}

export class MissionSpecError extends Error {}

export function loadMissionSpec(
  sourceFile: string,
  options: LoadMissionSpecOptions = {},
): MissionSpecV1 {
  const absoluteSourceFile = realpathSync(resolve(sourceFile));
  const missionFileDir = dirname(absoluteSourceFile);
  const raw = parseYaml(readFileSync(absoluteSourceFile, 'utf8')) as unknown;
  const root = requireRecord(raw, 'mission');

  const schemaVersion = requireString(root.schemaVersion, 'schemaVersion');
  if (schemaVersion !== MISSION_SPEC_VERSION) {
    throw new MissionSpecError(`Unsupported schemaVersion: ${schemaVersion}`);
  }

  const rawWorkspace = options.workspace ?? requireString(root.workspace, 'workspace');
  const workspaceVariables = {
    WORKSPACE: options.workspace ?? rawWorkspace,
    MISSION_FILE_DIR: missionFileDir,
  };
  const expandedWorkspace = expandKnownVariables(rawWorkspace, workspaceVariables, 'workspace');
  const workspace = realpathSync(
    isAbsolute(expandedWorkspace) ? expandedWorkspace : resolve(missionFileDir, expandedWorkspace),
  );
  const variables = { ...workspaceVariables, WORKSPACE: workspace };

  const acceptanceCriteria = requireArray(root.acceptanceCriteria, 'acceptanceCriteria').map(
    (candidate, index): MissionAcceptanceSpecV1 => {
      const criterion = requireRecord(candidate, `acceptanceCriteria[${index}]`);
      const verifier = requireRecord(criterion.verifier, `acceptanceCriteria[${index}].verifier`);
      if (
        requireString(verifier.kind, `acceptanceCriteria[${index}].verifier.kind`) !== 'command'
      ) {
        throw new MissionSpecError(`Only command verifiers are supported in E0/E1`);
      }
      const cwdValue = expandKnownVariables(
        requireString(verifier.cwd, `acceptanceCriteria[${index}].verifier.cwd`),
        variables,
        `acceptanceCriteria[${index}].verifier.cwd`,
      );
      const envRecord =
        verifier.env === undefined ? {} : requireRecord(verifier.env, 'verifier.env');
      if (Object.keys(envRecord).length > 0) {
        throw new MissionSpecError(
          'Verifier env values cannot enter the Mission Kernel; use controller-provided verifier variables',
        );
      }
      const env: Readonly<Record<string, string>> = {};

      return {
        id: requireIdentifier(criterion.id, `acceptanceCriteria[${index}].id`),
        description: requireString(
          criterion.description,
          `acceptanceCriteria[${index}].description`,
        ),
        verifier: {
          kind: 'command',
          executable: requireString(
            verifier.executable,
            `acceptanceCriteria[${index}].verifier.executable`,
          ),
          args: requireArray(verifier.args, 'verifier.args').map((argument, argumentIndex) =>
            expandKnownVariables(
              requireString(argument, `verifier.args[${argumentIndex}]`),
              variables,
              `verifier.args[${argumentIndex}]`,
            ),
          ),
          cwd: isAbsolute(cwdValue) ? cwdValue : resolve(missionFileDir, cwdValue),
          env,
          timeoutMs: requirePositiveInteger(verifier.timeoutMs, 'verifier.timeoutMs'),
        },
      };
    },
  );

  const attemptPlan = requireArray(root.attemptPlan, 'attemptPlan').map(
    (candidate, index): AttemptStageSpecV1 => {
      const stage = requireRecord(candidate, `attemptPlan[${index}]`);
      const profile = requireRecord(stage.profile, `attemptPlan[${index}].profile`);
      const harness = requireHarness(profile.harness, `attemptPlan[${index}].profile.harness`);
      return {
        stageId: requireIdentifier(stage.stageId, `attemptPlan[${index}].stageId`),
        profile: {
          harness,
          model: requireString(profile.model, `attemptPlan[${index}].profile.model`),
          ...(profile.reasoningEffort === undefined
            ? {}
            : {
                reasoningEffort: requireString(
                  profile.reasoningEffort,
                  `attemptPlan[${index}].profile.reasoningEffort`,
                ),
              }),
          ...(profile.permissionMode === undefined
            ? {}
            : {
                permissionMode: requireString(
                  profile.permissionMode,
                  `attemptPlan[${index}].profile.permissionMode`,
                ),
              }),
          injectionBudgetTokens: requirePositiveInteger(
            profile.injectionBudgetTokens,
            `attemptPlan[${index}].profile.injectionBudgetTokens`,
          ),
        },
        instruction: requireString(stage.instruction, `attemptPlan[${index}].instruction`),
        onFailure:
          stage.onFailure === undefined
            ? 'stop'
            : requireFailureDisposition(stage.onFailure, `attemptPlan[${index}].onFailure`),
      };
    },
  );

  requireNonEmpty(acceptanceCriteria, 'acceptanceCriteria');
  requireNonEmpty(attemptPlan, 'attemptPlan');
  assertUnique(
    acceptanceCriteria.map((criterion) => criterion.id),
    'acceptance criterion id',
  );
  assertUnique(
    attemptPlan.map((stage) => stage.stageId),
    'stage id',
  );
  if (attemptPlan.at(-1)?.onFailure === 'handoff') {
    throw new MissionSpecError('The final stage cannot hand off on failure');
  }

  return {
    schemaVersion: MISSION_SPEC_VERSION,
    title: requireString(root.title, 'title'),
    objective: requireString(root.objective, 'objective'),
    constraints:
      root.constraints === undefined
        ? []
        : requireArray(root.constraints, 'constraints').map((value, index) =>
            requireString(value, `constraints[${index}]`),
          ),
    workspace,
    missionSourceDir: missionFileDir,
    acceptanceCriteria,
    attemptPlan,
    sourceFile: absoluteSourceFile,
  };
}

/**
 * Capture the fully resolved, non-secret Mission input that execution needs.
 * The source YAML path is deliberately excluded: it is provenance, not state.
 */
export function createMissionSpecSnapshot(spec: MissionSpecV1): MissionSpecSnapshotV1 {
  const { sourceFile: _sourceFile, ...resolved } = spec;
  assertNoCredentialMaterial(resolved);
  return {
    schemaVersion: MISSION_SPEC_SNAPSHOT_VERSION,
    spec: resolved,
  };
}

/** Restore a Mission spec without reading or statting the original YAML. */
export function restoreMissionSpecSnapshot(
  value: unknown,
  sourceFileProvenance: string,
): MissionSpecV1 {
  const snapshot = requireRecord(value, 'snapshot');
  const snapshotVersion = requireString(snapshot.schemaVersion, 'snapshot.schemaVersion');
  if (snapshotVersion !== MISSION_SPEC_SNAPSHOT_VERSION) {
    throw new MissionSpecError(`Unsupported Mission spec snapshot: ${snapshotVersion}`);
  }
  if (!isAbsolute(sourceFileProvenance)) {
    throw new MissionSpecError('Mission source provenance must be an absolute path');
  }

  const spec = requireRecord(snapshot.spec, 'snapshot.spec');
  const schemaVersion = requireString(spec.schemaVersion, 'snapshot.spec.schemaVersion');
  if (schemaVersion !== MISSION_SPEC_VERSION) {
    throw new MissionSpecError(`Unsupported schemaVersion: ${schemaVersion}`);
  }
  const workspace = requireAbsolutePath(spec.workspace, 'snapshot.spec.workspace');
  const missionSourceDir = requireAbsolutePath(
    spec.missionSourceDir,
    'snapshot.spec.missionSourceDir',
  );
  const constraints = requireArray(spec.constraints, 'snapshot.spec.constraints').map(
    (constraint, index) => requireString(constraint, `snapshot.spec.constraints[${index}]`),
  );
  const acceptanceCriteria = requireArray(
    spec.acceptanceCriteria,
    'snapshot.spec.acceptanceCriteria',
  ).map((candidate, index): MissionAcceptanceSpecV1 => {
    const criterion = requireRecord(candidate, `snapshot.spec.acceptanceCriteria[${index}]`);
    const verifier = requireRecord(
      criterion.verifier,
      `snapshot.spec.acceptanceCriteria[${index}].verifier`,
    );
    if (
      requireString(verifier.kind, `snapshot.spec.acceptanceCriteria[${index}].verifier.kind`) !==
      'command'
    ) {
      throw new MissionSpecError('Only command verifiers are supported in E0/E1');
    }
    const envRecord = requireRecord(
      verifier.env,
      `snapshot.spec.acceptanceCriteria[${index}].verifier.env`,
    );
    if (Object.keys(envRecord).length > 0) {
      throw new MissionSpecError('Persisted verifier env must be empty');
    }
    return {
      id: requireIdentifier(criterion.id, `snapshot.spec.acceptanceCriteria[${index}].id`),
      description: requireString(
        criterion.description,
        `snapshot.spec.acceptanceCriteria[${index}].description`,
      ),
      verifier: {
        kind: 'command',
        executable: requireString(
          verifier.executable,
          `snapshot.spec.acceptanceCriteria[${index}].verifier.executable`,
        ),
        args: requireArray(
          verifier.args,
          `snapshot.spec.acceptanceCriteria[${index}].verifier.args`,
        ).map((argument, argumentIndex) =>
          requireString(
            argument,
            `snapshot.spec.acceptanceCriteria[${index}].verifier.args[${argumentIndex}]`,
          ),
        ),
        cwd: requireAbsolutePath(
          verifier.cwd,
          `snapshot.spec.acceptanceCriteria[${index}].verifier.cwd`,
        ),
        env: {},
        timeoutMs: requirePositiveInteger(
          verifier.timeoutMs,
          `snapshot.spec.acceptanceCriteria[${index}].verifier.timeoutMs`,
        ),
      },
    };
  });
  const attemptPlan = requireArray(spec.attemptPlan, 'snapshot.spec.attemptPlan').map(
    (candidate, index): AttemptStageSpecV1 => {
      const stage = requireRecord(candidate, `snapshot.spec.attemptPlan[${index}]`);
      const profile = requireRecord(stage.profile, `snapshot.spec.attemptPlan[${index}].profile`);
      const harness = requireHarness(
        profile.harness,
        `snapshot.spec.attemptPlan[${index}].profile.harness`,
      );
      return {
        stageId: requireIdentifier(stage.stageId, `snapshot.spec.attemptPlan[${index}].stageId`),
        profile: {
          harness,
          model: requireString(profile.model, `snapshot.spec.attemptPlan[${index}].profile.model`),
          ...(profile.reasoningEffort === undefined
            ? {}
            : {
                reasoningEffort: requireString(
                  profile.reasoningEffort,
                  `snapshot.spec.attemptPlan[${index}].profile.reasoningEffort`,
                ),
              }),
          ...(profile.permissionMode === undefined
            ? {}
            : {
                permissionMode: requireString(
                  profile.permissionMode,
                  `snapshot.spec.attemptPlan[${index}].profile.permissionMode`,
                ),
              }),
          injectionBudgetTokens: requirePositiveInteger(
            profile.injectionBudgetTokens,
            `snapshot.spec.attemptPlan[${index}].profile.injectionBudgetTokens`,
          ),
        },
        instruction: requireString(
          stage.instruction,
          `snapshot.spec.attemptPlan[${index}].instruction`,
        ),
        onFailure: requireFailureDisposition(
          stage.onFailure,
          `snapshot.spec.attemptPlan[${index}].onFailure`,
        ),
      };
    },
  );

  requireNonEmpty(acceptanceCriteria, 'snapshot.spec.acceptanceCriteria');
  requireNonEmpty(attemptPlan, 'snapshot.spec.attemptPlan');
  assertUnique(
    acceptanceCriteria.map((criterion) => criterion.id),
    'acceptance criterion id',
  );
  assertUnique(
    attemptPlan.map((stage) => stage.stageId),
    'stage id',
  );
  if (attemptPlan.at(-1)?.onFailure === 'handoff') {
    throw new MissionSpecError('The final stage cannot hand off on failure');
  }

  const resolved: ResolvedMissionSpecV1 = {
    schemaVersion: MISSION_SPEC_VERSION,
    title: requireString(spec.title, 'snapshot.spec.title'),
    objective: requireString(spec.objective, 'snapshot.spec.objective'),
    constraints,
    workspace,
    missionSourceDir,
    acceptanceCriteria,
    attemptPlan,
  };
  assertNoCredentialMaterial(resolved, 'snapshot.spec');
  return { ...resolved, sourceFile: resolve(sourceFileProvenance) };
}

function expandKnownVariables(
  value: string,
  variables: Readonly<Record<string, string>>,
  path: string,
): string {
  const expanded = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    const replacement = variables[name];
    if (replacement === undefined) {
      throw new MissionSpecError(`Unknown variable \${${name}} at ${path}`);
    }
    return replacement;
  });
  if (expanded.includes('${')) {
    throw new MissionSpecError(`Unresolved variable at ${path}`);
  }
  return expanded;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MissionSpecError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new MissionSpecError(`${path} must be an array`);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MissionSpecError(`${path} must be a non-empty string`);
  }
  return value;
}

function requireHarness(value: unknown, path: string): SupportedHarnessV1 {
  const harness = requireString(value, path);
  if (harness !== 'codex' && harness !== 'qoder' && harness !== 'claude') {
    throw new MissionSpecError(`Unsupported harness ${harness}`);
  }
  return harness;
}

function requireIdentifier(value: unknown, path: string): string {
  const identifier = requireString(value, path);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(identifier)) {
    throw new MissionSpecError(`${path} contains unsupported characters`);
  }
  return identifier;
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new MissionSpecError(`${path} must be a positive integer`);
  }
  return value;
}

function requireAbsolutePath(value: unknown, path: string): string {
  const candidate = requireString(value, path);
  if (!isAbsolute(candidate)) throw new MissionSpecError(`${path} must be an absolute path`);
  return resolve(candidate);
}

function requireFailureDisposition(value: unknown, path: string): 'stop' | 'handoff' {
  if (value !== 'stop' && value !== 'handoff') {
    throw new MissionSpecError(`${path} must be stop or handoff`);
  }
  return value;
}

function requireNonEmpty(values: readonly unknown[], path: string): void {
  if (values.length === 0) throw new MissionSpecError(`${path} must not be empty`);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new MissionSpecError(`Duplicate ${label}`);
  }
}

function assertNoCredentialMaterial(value: unknown, path = 'snapshot.spec'): void {
  if (Array.isArray(value)) {
    value.forEach((member, index) => assertNoCredentialMaterial(member, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && looksLikeCredentialValue(value)) {
      throw new MissionSpecError(
        `Credential-like value at ${path} cannot enter a Mission snapshot`,
      );
    }
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
      throw new MissionSpecError(
        `Credential-like field ${path}.${key} cannot enter a Mission snapshot`,
      );
    }
    assertNoCredentialMaterial(member, `${path}.${key}`);
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
