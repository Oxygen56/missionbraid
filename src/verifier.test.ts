import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CommandVerifierSpecV1 } from './spec.js';
import { cleanVerifierEnvironment, runCommandVerifier, VerifierBoundaryError } from './verifier.js';

const disposableRoots: string[] = [];

afterEach(() => {
  delete process.env.MISSIONBRAID_TEST_INHERITED_SECRET;
  for (const root of disposableRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runCommandVerifier', () => {
  it('runs without a shell using a cleaned environment and records bounded evidence', async () => {
    const fixture = verifierFixture();
    process.env.MISSIONBRAID_TEST_INHERITED_SECRET = 'do-not-inherit';
    const script = [
      "const keys=['EXPLICIT','MISSIONBRAID_TEST_INHERITED_SECRET','MISSIONBRAID_TARGET_WORKSPACE','PROVENANCE_FILE'];",
      'process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key)=>[key,process.env[key]??null]))));',
      "process.stderr.write('api_key=fixture-secret\\n');",
    ].join('');
    const spec = commandSpec(fixture.workspace, ['-e', script], 10_000, {
      EXPLICIT: 'allowed',
    });

    const result = await runCommandVerifier(spec, fixture);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stdout.sha256).toBe(sha256(result.stdout.summary));
    expect(JSON.parse(result.stdout.summary)).toEqual({
      EXPLICIT: 'allowed',
      MISSIONBRAID_TEST_INHERITED_SECRET: null,
      MISSIONBRAID_TARGET_WORKSPACE: realpathSync(fixture.workspace),
      PROVENANCE_FILE: join(realpathSync(fixture.missionSourceDir), 'provenance.json'),
    });
    expect(result.stderr).toMatchObject({
      sha256: sha256('api_key=fixture-secret\n'),
      summary: 'api_key [REDACTED]\n',
      summaryTruncated: false,
      summaryRedacted: true,
    });
  });

  it('rejects cwd and provenance paths outside both explicit roots', async () => {
    const fixture = verifierFixture();
    const outside = mkdtempSync(join(tmpdir(), 'missionbraid-verifier-outside-'));
    disposableRoots.push(outside);

    await expect(
      runCommandVerifier(commandSpec(outside, ['-e', ''], 1_000), fixture),
    ).rejects.toThrow(VerifierBoundaryError);
    await expect(
      runCommandVerifier(commandSpec(fixture.workspace, ['-e', ''], 1_000), {
        ...fixture,
        provenanceFile: join(outside, 'provenance.json'),
      }),
    ).rejects.toThrow(VerifierBoundaryError);
  });

  it('allows authoritative provenance in an independent controller state directory', async () => {
    const fixture = verifierFixture();
    const controllerStateDir = mkdtempSync(join(tmpdir(), 'missionbraid-controller-state-'));
    disposableRoots.push(controllerStateDir);

    const result = await runCommandVerifier(commandSpec(fixture.workspace, ['-e', ''], 10_000), {
      ...fixture,
      controllerStateDir,
      provenanceFile: join(controllerStateDir, 'provenance.json'),
    });

    expect(result.passed).toBe(true);
  });

  it('terminates a verifier at its deadline and bounds captured output', async () => {
    const fixture = verifierFixture();
    const script = "process.stdout.write('x'.repeat(10000)); setInterval(()=>{},1000);";
    const result = await runCommandVerifier(
      commandSpec(fixture.missionSourceDir, ['-e', script], 8_000),
      { ...fixture, maxSummaryBytes: 128 },
    );

    expect(result.passed).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.stdout.byteCount).toBe(10_000);
    expect(Buffer.byteLength(result.stdout.summary)).toBeLessThanOrEqual(128);
    expect(result.stdout.summaryTruncated).toBe(true);
    expect(result.stdout.sha256).toBe(sha256('x'.repeat(10_000)));
  });

  it('exports an environment builder that keeps only the documented ambient keys', () => {
    const fixture = verifierFixture();
    process.env.MISSIONBRAID_TEST_INHERITED_SECRET = 'do-not-inherit';
    const environment = cleanVerifierEnvironment(
      { EXPLICIT: 'yes' },
      fixture.workspace,
      fixture.provenanceFile,
    );

    expect(environment.EXPLICIT).toBe('yes');
    expect(environment.MISSIONBRAID_TEST_INHERITED_SECRET).toBeUndefined();
    expect(environment.MISSIONBRAID_TARGET_WORKSPACE).toBe(fixture.workspace);
    expect(environment.MISSIONBRAID_PROVENANCE_FILE).toBe(fixture.provenanceFile);
    expect(environment.PROVENANCE_FILE).toBe(fixture.provenanceFile);
    expect(
      Object.keys(environment).every(
        (key) =>
          ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LANGUAGE', 'EXPLICIT'].includes(key) ||
          key.startsWith('LC_') ||
          key === 'MISSIONBRAID_TARGET_WORKSPACE' ||
          key === 'MISSIONBRAID_PROVENANCE_FILE' ||
          key === 'PROVENANCE_FILE',
      ),
    ).toBe(true);
  });
});

function verifierFixture(): {
  workspace: string;
  missionSourceDir: string;
  controllerStateDir: string;
  provenanceFile: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'missionbraid-verifier-'));
  disposableRoots.push(root);
  const workspace = join(root, 'workspace');
  const missionSourceDir = join(root, 'mission-source');
  mkdirSync(workspace);
  mkdirSync(missionSourceDir);
  return {
    workspace,
    missionSourceDir,
    controllerStateDir: missionSourceDir,
    provenanceFile: join(missionSourceDir, 'provenance.json'),
  };
}

function commandSpec(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
  env: Readonly<Record<string, string>> = {},
): CommandVerifierSpecV1 {
  return {
    kind: 'command',
    executable: process.execPath,
    args,
    cwd,
    env,
    timeoutMs,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
