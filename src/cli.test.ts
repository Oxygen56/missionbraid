import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { main, parseArguments } from './cli.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MissionBraid CLI', () => {
  it('defaults controller state outside a target-local Mission file', () => {
    const parsed = parseArguments([
      'run',
      '/tmp/missionbraid-target/mission.yaml',
      '--workspace',
      '/tmp/missionbraid-target',
    ]);

    expect(parsed.stateDir).toBe(resolve(homedir(), '.missionbraid'));
  });

  it.each(['--help', '-h'])('prints help to stdout and succeeds for %s', async (flag) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(main([flag])).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('missionbraid run'));
    expect(stderr).not.toHaveBeenCalled();
  });

  it('prints provider-check help before opening Mission state', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(main(['provider-check', 'kandev', '--help'])).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining('missionbraid provider-check kandev'),
    );
    expect(stderr).not.toHaveBeenCalled();
  });
});
