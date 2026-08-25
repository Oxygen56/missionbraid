import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createClaudeToolGateBinding } from './claude-tool-gate.js';

const disposableDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    disposableDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Claude Tool Gateway settings', () => {
  it('creates deterministic private native Hook settings for mutable tools', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'missionbraid-claude-gate-'));
    disposableDirectories.push(stateDir);
    const gatewayRoot = join(stateDir, 'tool-gateway');
    const first = await createClaudeToolGateBinding({
      stateDir,
      gatewayRoot,
      missionId: 'mission-1',
      attemptId: 'attempt-1',
    });
    const second = await createClaudeToolGateBinding({
      stateDir,
      gatewayRoot,
      missionId: 'mission-1',
      attemptId: 'attempt-1',
    });
    const settings = JSON.parse(await readFile(first.settingsFile, 'utf8')) as {
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
    };

    expect(second).toEqual(first);
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toContain('Write');
    expect(settings.hooks.PostToolUse?.[0]?.hooks[0]?.command).toContain('MISSIONBRAID_ATTEMPT_ID');
    expect(first.tools).toContain('Bash');
    expect((await stat(first.settingsFile)).mode & 0o777).toBe(0o600);
  });
});
