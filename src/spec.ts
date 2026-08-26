import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { ContextBindingSpecV1 } from './context-binding.js';

export const MISSION_SPEC_VERSION = 'missionbraid.dev/mission/v1' as const;
export const MISSION_SPEC_SNAPSHOT_VERSION =
  'missionbraid.dev/resolved-mission-snapshot/v1' as const;

export type SupportedHarnessV1 = 'codex' | 'qoder' | 'claude';
/** Open Harness identity. Non-native values require an explicit Adapter binding. */
export type HarnessIdV1 = string;

export function isSupportedHarnessV1(value: string): value is SupportedHarnessV1 {
  return value === 'codex' || value === 'qoder' || value === 'claude';
}

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
  readonly harness: HarnessIdV1;
  /** Optional public Adapter SDK implementation used instead of the built-in direct Adapter. */
  readonly adapterId?: string;
  /** Opaque workspace identity required by provider-backed Adapters. */
  readonly providerWorkspaceRef?: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly permissionMode?: string;
  readonly injectionBudgetTokens: number;
}

export interface AttemptStageSpecV1 {
  readonly stageId: string;
  readonly profile: AttemptProfileSpecV1;
  readonly instruction: string;
  /** Pause mutable Claude tools at the native PreToolUse boundary. */
  readonly breakpoint?: 'mutable-tools';
  readonly onFailure: 'stop' | 'handoff';
}

export type MissionPlanNodeKindSpecV1 = 'task' | 'review' | 'diagnostic' | 'branch' | 'join';

export type MissionPlanEdgeRelationSpecV1 =
  | 'depends-on'
  | 'review-input'
  | 'diagnostic-input'
  | 'branch-input'
  | 'join-input';

export interface MissionPlanNodeSpecV1 {
  readonly nodeId: string;
  readonly kind: MissionPlanNodeKindSpecV1;
  readonly title: string;
  /** Stable Contract requirement identities, not free-form prose. */
  readonly requirementIds: readonly string[];
  /** Attempt stage that supplies the real Agent Runtime Profile and instruction. */
  readonly stageId: string;
  readonly acceptanceCriterionIds: readonly string[];
  readonly declaredOutputKeys: readonly string[];
  readonly requiredAuthorityScopes: readonly string[];
}

export interface MissionPlanEdgeSpecV1 {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly relation: MissionPlanEdgeRelationSpecV1;
  readonly evidenceRefs: readonly string[];
}

export interface MissionPlanGraphSpecV1 {
  readonly nodes: readonly MissionPlanNodeSpecV1[];
  readonly edges: readonly MissionPlanEdgeSpecV1[];
}

export type MissionContextSpecV1 = ContextBindingSpecV1;

export interface ResolvedMissionSpecV1 {
  readonly schemaVersion: typeof MISSION_SPEC_VERSION;
  readonly title: string;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly workspace: string;
  readonly missionSourceDir: string;
  /** Optional declarative Context source and controller cache binding. */
  readonly context?: MissionContextSpecV1;
  readonly acceptanceCriteria: readonly MissionAcceptanceSpecV1[];
  readonly attemptPlan: readonly AttemptStageSpecV1[];
  /** Optional explicit Mission DAG. Omission retains the legacy linear stage plan. */
  readonly plan?: MissionPlanGraphSpecV1;
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

  const context =
    root.context === undefined
      ? undefined
      : parseContext(root.context, variables, workspace, 'context');

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
      const adapterId =
        profile.adapterId === undefined
          ? undefined
          : requireIdentifier(profile.adapterId, `attemptPlan[${index}].profile.adapterId`);
      const harness = requireHarness(
        profile.harness,
        `attemptPlan[${index}].profile.harness`,
        adapterId,
      );
      if (profile.providerWorkspaceRef !== undefined && profile.adapterId === undefined) {
        throw new MissionSpecError(
          `attemptPlan[${index}].profile.providerWorkspaceRef requires profile.adapterId`,
        );
      }
      if (profile.adapterId !== undefined && stage.breakpoint !== undefined) {
        throw new MissionSpecError(
          `attemptPlan[${index}].breakpoint is not available through the generic Adapter v1 host`,
        );
      }
      return {
        stageId: requireIdentifier(stage.stageId, `attemptPlan[${index}].stageId`),
        profile: {
          harness,
          ...(adapterId === undefined ? {} : { adapterId }),
          ...(profile.providerWorkspaceRef === undefined
            ? {}
            : {
                providerWorkspaceRef: requireString(
                  profile.providerWorkspaceRef,
                  `attemptPlan[${index}].profile.providerWorkspaceRef`,
                ),
              }),
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
        ...(stage.breakpoint === undefined
          ? {}
          : {
              breakpoint: requireBreakpoint(
                stage.breakpoint,
                harness,
                `attemptPlan[${index}].breakpoint`,
              ),
            }),
        onFailure:
          stage.onFailure === undefined
            ? 'stop'
            : requireFailureDisposition(stage.onFailure, `attemptPlan[${index}].onFailure`),
      };
    },
  );

  const constraints =
    root.constraints === undefined
      ? []
      : requireArray(root.constraints, 'constraints').map((value, index) =>
          requireString(value, `constraints[${index}]`),
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
  const plan =
    root.plan === undefined
      ? undefined
      : parsePlan(root.plan, constraints, acceptanceCriteria, attemptPlan, 'plan');

  return {
    schemaVersion: MISSION_SPEC_VERSION,
    title: requireString(root.title, 'title'),
    objective: requireString(root.objective, 'objective'),
    constraints,
    workspace,
    missionSourceDir: missionFileDir,
    ...(context === undefined ? {} : { context }),
    acceptanceCriteria,
    attemptPlan,
    ...(plan === undefined ? {} : { plan }),
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
      const adapterId =
        profile.adapterId === undefined
          ? undefined
          : requireIdentifier(
              profile.adapterId,
              `snapshot.spec.attemptPlan[${index}].profile.adapterId`,
            );
      const harness = requireHarness(
        profile.harness,
        `snapshot.spec.attemptPlan[${index}].profile.harness`,
        adapterId,
      );
      if (profile.providerWorkspaceRef !== undefined && profile.adapterId === undefined) {
        throw new MissionSpecError(
          `snapshot.spec.attemptPlan[${index}].profile.providerWorkspaceRef requires profile.adapterId`,
        );
      }
      if (profile.adapterId !== undefined && stage.breakpoint !== undefined) {
        throw new MissionSpecError(
          `snapshot.spec.attemptPlan[${index}].breakpoint is not available through the generic Adapter v1 host`,
        );
      }
      return {
        stageId: requireIdentifier(stage.stageId, `snapshot.spec.attemptPlan[${index}].stageId`),
        profile: {
          harness,
          ...(adapterId === undefined ? {} : { adapterId }),
          ...(profile.providerWorkspaceRef === undefined
            ? {}
            : {
                providerWorkspaceRef: requireString(
                  profile.providerWorkspaceRef,
                  `snapshot.spec.attemptPlan[${index}].profile.providerWorkspaceRef`,
                ),
              }),
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
        ...(stage.breakpoint === undefined
          ? {}
          : {
              breakpoint: requireBreakpoint(
                stage.breakpoint,
                harness,
                `snapshot.spec.attemptPlan[${index}].breakpoint`,
              ),
            }),
        onFailure: requireFailureDisposition(
          stage.onFailure,
          `snapshot.spec.attemptPlan[${index}].onFailure`,
        ),
      };
    },
  );

  const context =
    spec.context === undefined
      ? undefined
      : parseContextSnapshot(spec.context, workspace, 'snapshot.spec.context');

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
  const plan =
    spec.plan === undefined
      ? undefined
      : parsePlan(spec.plan, constraints, acceptanceCriteria, attemptPlan, 'snapshot.spec.plan');

  const resolved: ResolvedMissionSpecV1 = {
    schemaVersion: MISSION_SPEC_VERSION,
    title: requireString(spec.title, 'snapshot.spec.title'),
    objective: requireString(spec.objective, 'snapshot.spec.objective'),
    constraints,
    workspace,
    missionSourceDir,
    ...(context === undefined ? {} : { context }),
    acceptanceCriteria,
    attemptPlan,
    ...(plan === undefined ? {} : { plan }),
  };
  assertNoCredentialMaterial(resolved, 'snapshot.spec');
  return { ...resolved, sourceFile: resolve(sourceFileProvenance) };
}

function parsePlan(
  value: unknown,
  constraints: readonly string[],
  acceptanceCriteria: readonly MissionAcceptanceSpecV1[],
  attemptPlan: readonly AttemptStageSpecV1[],
  path: string,
): MissionPlanGraphSpecV1 {
  const record = requireRecord(value, path);
  const knownStageIds = new Set(attemptPlan.map((stage) => stage.stageId));
  const knownCriterionIds = new Set(acceptanceCriteria.map((criterion) => criterion.id));
  const knownRequirementIds = new Set([
    'objective',
    ...constraints.map((_constraint, index) => `constraint-${index + 1}`),
    ...acceptanceCriteria.map((criterion) => `acceptance-${criterion.id}`),
  ]);

  const nodes = requireArray(record.nodes, `${path}.nodes`).map(
    (candidate, index): MissionPlanNodeSpecV1 => {
      const nodePath = `${path}.nodes[${index}]`;
      const node = requireRecord(candidate, nodePath);
      const nodeId = requireIdentifier(node.nodeId, `${nodePath}.nodeId`);
      const stageId = requireIdentifier(node.stageId, `${nodePath}.stageId`);
      if (!knownStageIds.has(stageId)) {
        throw new MissionSpecError(`${nodePath}.stageId references unknown stage ${stageId}`);
      }
      const requirementIds = requireArray(node.requirementIds, `${nodePath}.requirementIds`).map(
        (requirementId, requirementIndex) =>
          requireIdentifier(requirementId, `${nodePath}.requirementIds[${requirementIndex}]`),
      );
      requireNonEmpty(requirementIds, `${nodePath}.requirementIds`);
      assertUnique(requirementIds, `${nodeId} requirement id`);
      for (const requirementId of requirementIds) {
        if (!knownRequirementIds.has(requirementId)) {
          throw new MissionSpecError(
            `${nodePath}.requirementIds references unknown Contract requirement ${requirementId}`,
          );
        }
      }
      const acceptanceCriterionIds = requireArray(
        node.acceptanceCriterionIds,
        `${nodePath}.acceptanceCriterionIds`,
      ).map((criterionId, criterionIndex) =>
        requireIdentifier(criterionId, `${nodePath}.acceptanceCriterionIds[${criterionIndex}]`),
      );
      assertUnique(acceptanceCriterionIds, `${nodeId} acceptance criterion id`);
      for (const criterionId of acceptanceCriterionIds) {
        if (!knownCriterionIds.has(criterionId)) {
          throw new MissionSpecError(
            `${nodePath}.acceptanceCriterionIds references unknown criterion ${criterionId}`,
          );
        }
      }
      const declaredOutputKeys = requireArray(
        node.declaredOutputKeys,
        `${nodePath}.declaredOutputKeys`,
      ).map((outputKey, outputIndex) =>
        requireString(outputKey, `${nodePath}.declaredOutputKeys[${outputIndex}]`),
      );
      assertUnique(declaredOutputKeys, `${nodeId} declared output key`);
      const requiredAuthorityScopes = requireArray(
        node.requiredAuthorityScopes,
        `${nodePath}.requiredAuthorityScopes`,
      ).map((scope, scopeIndex) =>
        requireString(scope, `${nodePath}.requiredAuthorityScopes[${scopeIndex}]`),
      );
      assertUnique(requiredAuthorityScopes, `${nodeId} required authority scope`);
      return {
        nodeId,
        kind: requirePlanNodeKind(node.kind, `${nodePath}.kind`),
        title: requireString(node.title, `${nodePath}.title`),
        requirementIds,
        stageId,
        acceptanceCriterionIds,
        declaredOutputKeys,
        requiredAuthorityScopes,
      };
    },
  );
  requireNonEmpty(nodes, `${path}.nodes`);
  assertUnique(
    nodes.map((node) => node.nodeId),
    'plan node id',
  );
  assertUnique(
    nodes.map((node) => node.stageId),
    'plan node stage binding',
  );

  const knownNodeIds = new Set(nodes.map((node) => node.nodeId));
  const edges = requireArray(record.edges, `${path}.edges`).map(
    (candidate, index): MissionPlanEdgeSpecV1 => {
      const edgePath = `${path}.edges[${index}]`;
      const edge = requireRecord(candidate, edgePath);
      const fromNodeId = requireIdentifier(edge.fromNodeId, `${edgePath}.fromNodeId`);
      const toNodeId = requireIdentifier(edge.toNodeId, `${edgePath}.toNodeId`);
      if (!knownNodeIds.has(fromNodeId) || !knownNodeIds.has(toNodeId)) {
        throw new MissionSpecError(`${edgePath} references an unknown plan node`);
      }
      if (fromNodeId === toNodeId) {
        throw new MissionSpecError(`${edgePath} cannot point to the same node`);
      }
      return {
        fromNodeId,
        toNodeId,
        relation: requirePlanEdgeRelation(edge.relation, `${edgePath}.relation`),
        evidenceRefs: requireArray(edge.evidenceRefs, `${edgePath}.evidenceRefs`).map(
          (evidenceRef, evidenceIndex) =>
            requireString(evidenceRef, `${edgePath}.evidenceRefs[${evidenceIndex}]`),
        ),
      };
    },
  );
  assertUnique(
    edges.map((edge) => `${edge.fromNodeId}\0${edge.toNodeId}\0${edge.relation}`),
    'plan edge',
  );
  return { nodes, edges };
}

function parseContext(
  value: unknown,
  variables: Readonly<Record<string, string>>,
  workspace: string,
  path: string,
): MissionContextSpecV1 {
  const record = requireRecord(value, path);
  const factId = requireIdentifier(record.factId, `${path}.factId`);
  const source = expandKnownVariables(
    requireString(record.source, `${path}.source`),
    variables,
    `${path}.source`,
  );
  const snapshot = expandKnownVariables(
    requireString(record.snapshot, `${path}.snapshot`),
    variables,
    `${path}.snapshot`,
  );
  return {
    factId,
    source: resolveWorkspacePath(workspace, source, `${path}.source`),
    snapshot: resolveWorkspacePath(workspace, snapshot, `${path}.snapshot`),
  };
}

function parseContextSnapshot(
  value: unknown,
  workspace: string,
  path: string,
): MissionContextSpecV1 {
  const record = requireRecord(value, path);
  const factId = requireIdentifier(record.factId, `${path}.factId`);
  return {
    factId,
    source: resolveWorkspacePath(
      workspace,
      requireString(record.source, `${path}.source`),
      `${path}.source`,
    ),
    snapshot: resolveWorkspacePath(
      workspace,
      requireString(record.snapshot, `${path}.snapshot`),
      `${path}.snapshot`,
    ),
  };
}

function resolveWorkspacePath(workspace: string, value: string, path: string): string {
  const candidate = canonicalizePath(
    isAbsolute(value) ? resolve(value) : resolve(workspace, value),
  );
  const relativePath = relative(realpathSync(workspace), candidate);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new MissionSpecError(`${path} must remain inside the Mission workspace`);
  }
  return candidate;
}

function canonicalizePath(value: string): string {
  return existsSync(value) ? realpathSync(value) : value;
}

function requireBreakpoint(value: unknown, harness: HarnessIdV1, path: string): 'mutable-tools' {
  if (value !== 'mutable-tools') {
    throw new MissionSpecError(`${path} must be mutable-tools`);
  }
  if (harness !== 'claude') {
    throw new MissionSpecError(`${path} currently requires the Claude native Hook adapter`);
  }
  return value;
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

function requireHarness(value: unknown, path: string, adapterId?: string): HarnessIdV1 {
  const harness = requireIdentifier(value, path);
  if (adapterId === undefined && !isSupportedHarnessV1(harness)) {
    throw new MissionSpecError(`Unsupported harness ${harness}`);
  }
  return harness;
}

function requirePlanNodeKind(value: unknown, path: string): MissionPlanNodeKindSpecV1 {
  const kind = requireString(value, path);
  if (
    kind !== 'task' &&
    kind !== 'review' &&
    kind !== 'diagnostic' &&
    kind !== 'branch' &&
    kind !== 'join'
  ) {
    throw new MissionSpecError(`${path} has unsupported plan node kind ${kind}`);
  }
  return kind;
}

function requirePlanEdgeRelation(value: unknown, path: string): MissionPlanEdgeRelationSpecV1 {
  const relation = requireString(value, path);
  if (
    relation !== 'depends-on' &&
    relation !== 'review-input' &&
    relation !== 'diagnostic-input' &&
    relation !== 'branch-input' &&
    relation !== 'join-input'
  ) {
    throw new MissionSpecError(`${path} has unsupported plan edge relation ${relation}`);
  }
  return relation;
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
