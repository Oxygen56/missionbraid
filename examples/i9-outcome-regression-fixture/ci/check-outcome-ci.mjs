#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const selfTest = process.argv[2] === '--self-test';
const file = selfTest ? process.argv[3] : process.argv[2];
const requestedResultId = selfTest ? undefined : process.argv[3];
if (!file) {
  process.stderr.write(
    'Usage: node check-outcome-ci.mjs [--self-test] <result-or-collection.json> [result-id]\n',
  );
  process.exit(2);
}

try {
  const document = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const result = selectResult(document, requestedResultId);
  verifyIdentity(result);
  if (selfTest) {
    const controls = runFailClosedControls(result);
    process.stdout.write(`${JSON.stringify(controls, null, 2)}\n`);
    process.exit(0);
  }
  const reasons = enforce(result);
  const report = {
    schemaVersion: 'missionbraid.dev/outcome-ci-enforcement/v1',
    resultId: result.resultId,
    scenarioId: result.scenarioId,
    status: reasons.length === 0 ? 'passed' : 'failed',
    exitCode: reasons.length === 0 ? 0 : 1,
    reasons,
    authority: 'ci-evidence-check-only',
    deploymentAuthorized: false,
    organizationalApprovalGranted: false,
    publicationAuthorized: false,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.exitCode);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

function runFailClosedControls(result) {
  const tampered = structuredClone(result);
  tampered.branchId = `${String(tampered.branchId)}-tampered`;
  let tamperRejected = false;
  try {
    verifyIdentity(tampered);
  } catch {
    tamperRejected = true;
  }

  const profileTampered = structuredClone(result);
  profileTampered.runtimeProfileBinding.targetProfileId = `${String(
    profileTampered.runtimeProfileBinding.targetProfileId,
  )}-tampered`;
  let profileTamperRejected = false;
  try {
    verifyIdentity(profileTampered);
  } catch {
    profileTamperRejected = true;
  }

  const unknownCore = structuredClone(result);
  delete unknownCore.resultId;
  delete unknownCore.resultHash;
  unknownCore.expectationResults[0].actualStatus = 'unknown';
  unknownCore.expectationResults[0].matched = false;
  unknownCore.regression = 'inconclusive';
  unknownCore.status = 'failed';
  const unknownHash = sha256(canonical(unknownCore));
  const unknown = {
    ...unknownCore,
    resultId: `ci-result-${unknownHash}`,
    resultHash: unknownHash,
  };
  verifyIdentity(unknown);
  const unknownRejected = enforce(unknown).length > 0;
  if (!tamperRejected || !profileTamperRejected || !unknownRejected) {
    throw new Error('Outcome CI checker did not fail closed for its controls.');
  }
  return {
    schemaVersion: 'missionbraid.dev/outcome-ci-checker-self-test/v1',
    sourceResultId: result.resultId,
    tamperRejected,
    profileTamperRejected,
    unknownRejected,
    status: 'passed',
  };
}

function selectResult(document, requestedResultId) {
  const candidates = Array.isArray(document?.ciResults)
    ? document.ciResults
    : document?.schemaVersion === 'missionbraid.dev/outcome-ci-result/v1'
      ? [document]
      : [];
  if (candidates.length === 0) throw new Error('No Outcome CI result was found.');
  if (requestedResultId) {
    const selected = candidates.find((candidate) => candidate?.resultId === requestedResultId);
    if (!selected) throw new Error(`Outcome CI result ${requestedResultId} was not found.`);
    return selected;
  }
  if (candidates.length !== 1) {
    throw new Error('Multiple Outcome CI results require an explicit result id.');
  }
  return candidates[0];
}

function verifyIdentity(result) {
  if (result?.schemaVersion !== 'missionbraid.dev/outcome-ci-result/v1') {
    throw new Error('Unsupported Outcome CI result schema.');
  }
  if (!Array.isArray(result.expectationResults) || result.expectationResults.length === 0) {
    throw new Error('Outcome CI result has no criterion expectations.');
  }
  verifyRuntimeProfileBinding(result.runtimeProfileBinding);
  const { resultId, resultHash, ...core } = result;
  const actualHash = sha256(canonical(core));
  if (resultHash !== actualHash || resultId !== `ci-result-${actualHash}`) {
    throw new Error('Outcome CI result identity does not match its content.');
  }
  if (
    result.authority !== 'evidence-export-only' ||
    result.deploymentAuthorized !== false ||
    result.organizationalApprovalGranted !== false ||
    result.publicationAuthorized !== false
  ) {
    throw new Error('Outcome CI result attempts to grant authority it does not own.');
  }
}

function verifyRuntimeProfileBinding(binding) {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new Error('Outcome CI result lacks a Runtime Profile binding.');
  }
  for (const field of [
    'sourceProfileId',
    'targetProfileId',
    'targetStageId',
    'targetProfileDefinitionId',
    'profileSelectionId',
  ]) {
    if (typeof binding[field] !== 'string' || binding[field].trim().length === 0) {
      throw new Error(`Outcome CI Runtime Profile binding has invalid ${field}.`);
    }
  }
  if (binding.sourceProfileId === binding.targetProfileId) {
    throw new Error('Outcome CI Runtime Profile target is not distinct from its source.');
  }
  if (!/^[a-f0-9]{64}$/.test(binding.plannerDecisionHash)) {
    throw new Error('Outcome CI Runtime Profile binding lacks a complete Planner decision hash.');
  }
  if (binding.authorityChange !== 'unchanged' && binding.authorityChange !== 'narrowed') {
    throw new Error('Outcome CI Runtime Profile binding expands authority.');
  }
  if (
    !Array.isArray(binding.evidenceRefs) ||
    binding.evidenceRefs.length === 0 ||
    binding.evidenceRefs.some(
      (reference) => typeof reference !== 'string' || reference.trim().length === 0,
    ) ||
    new Set(binding.evidenceRefs).size !== binding.evidenceRefs.length
  ) {
    throw new Error('Outcome CI Runtime Profile binding lacks canonical Planner evidence.');
  }
}

function enforce(result) {
  const reasons = [];
  const seen = new Set();
  for (const expectation of result.expectationResults) {
    if (seen.has(expectation.criterionId)) {
      throw new Error(`Duplicate criterion ${String(expectation.criterionId)}.`);
    }
    seen.add(expectation.criterionId);
    if (
      expectation.actualStatus === 'unknown' ||
      expectation.actualStatus === 'missing' ||
      expectation.matched !== true ||
      expectation.actualStatus !== expectation.expectedStatus
    ) {
      reasons.push(
        `criterion:${String(expectation.criterionId)}:${String(expectation.actualStatus)}`,
      );
    }
  }
  const anyUnknown = result.expectationResults.some(
    (expectation) =>
      expectation.actualStatus === 'unknown' || expectation.actualStatus === 'missing',
  );
  const allMatched = result.expectationResults.every(
    (expectation) =>
      expectation.matched === true && expectation.actualStatus === expectation.expectedStatus,
  );
  const expectedRegression = anyUnknown ? 'inconclusive' : allMatched ? 'retained' : 'returned';
  if (result.regression !== expectedRegression) {
    throw new Error('Outcome CI regression conclusion is inconsistent.');
  }
  if (result.status !== 'passed') reasons.push(`status:${String(result.status)}`);
  if (result.regression !== 'retained') {
    reasons.push(`regression:${String(result.regression)}`);
  }
  return [...new Set(reasons)].sort();
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON forbids non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        if (value[key] === undefined)
          throw new Error(`Canonical JSON forbids undefined at ${key}.`);
        return `${JSON.stringify(key)}:${canonical(value[key])}`;
      })
      .join(',')}}`;
  }
  throw new Error(`Canonical JSON forbids ${typeof value}.`);
}
