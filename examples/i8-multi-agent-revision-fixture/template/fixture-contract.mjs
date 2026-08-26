import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CONTRACT_REVISION_SCHEMA_VERSION = 'missionbraid.dev/contract-revision/v1';

export async function readActiveContractRevision() {
  const workspace = process.env.MISSIONBRAID_TARGET_WORKSPACE;
  if (workspace === undefined || workspace.trim().length === 0) {
    throw new Error('MISSIONBRAID_TARGET_WORKSPACE is required');
  }
  const source = await readFile(
    resolve(workspace, '.missionbraid', 'contract-revision.json'),
    'utf8',
  );
  const revision = JSON.parse(source);
  if (
    revision?.schemaVersion !== undefined &&
    revision.schemaVersion !== CONTRACT_REVISION_SCHEMA_VERSION
  ) {
    throw new TypeError('Unsupported Contract revision record');
  }
  if (revision.revisionNumber !== 1 && revision.revisionNumber !== 2) {
    throw new TypeError('Fixture supports only Contract revisions 1 and 2');
  }
  if (!Array.isArray(revision.requirements)) {
    throw new TypeError('Contract revision requirements must be an array');
  }
  return revision;
}

export function requireContractRequirement(revision, requirementId) {
  const matches = revision.requirements.filter(
    (requirement) => requirement?.requirementId === requirementId,
  );
  if (matches.length !== 1 || typeof matches[0].statement !== 'string') {
    throw new TypeError(`Contract must contain exactly one ${requirementId} requirement`);
  }
  return matches[0];
}

export function expectedPromptOutputMap(revision) {
  const requirement = requireContractRequirement(revision, 'acceptance-prompt-schema');
  if (revision.revisionNumber === 1) {
    if (/evidenceSource|tool\.evidenceRefs/u.test(requirement.statement)) {
      throw new TypeError('Contract revision 1 must remain the two-field prompt requirement');
    }
    return {
      classification: 'tool.decision',
      rationale: 'tool.rationale',
    };
  }
  if (
    !/evidenceSource/u.test(requirement.statement) ||
    !/tool\.evidenceRefs/u.test(requirement.statement)
  ) {
    throw new TypeError('Contract revision 2 must bind evidenceSource to tool.evidenceRefs');
  }
  return {
    classification: 'tool.decision',
    rationale: 'tool.rationale',
    evidenceSource: 'tool.evidenceRefs',
  };
}
