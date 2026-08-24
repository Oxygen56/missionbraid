import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { main, parseAppArguments, parseArguments } from './cli.js';

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

  it('accepts create with the same workspace boundary as run', () => {
    const parsed = parseArguments([
      'create',
      '/tmp/missionbraid-source/mission.yaml',
      '--workspace',
      '/tmp/missionbraid-target',
      '--state-dir',
      '/tmp/missionbraid-control',
    ]);

    expect(parsed).toMatchObject({
      command: 'create',
      subject: '/tmp/missionbraid-source/mission.yaml',
      workspace: '/tmp/missionbraid-target',
      stateDir: '/tmp/missionbraid-control',
    });
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

  it('prints runtime catalog help before opening Mission state', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(main(['runtimes', '--help'])).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('missionbraid runtimes list'));
    expect(stderr).not.toHaveBeenCalled();
  });

  it('parses the local app port and state directory', () => {
    expect(
      parseAppArguments(['--state-dir', '/tmp/missionbraid-app-state', '--port', '4318']),
    ).toEqual({ stateDir: '/tmp/missionbraid-app-state', port: 4318 });
    expect(() => parseAppArguments(['--port', '70000'])).toThrow('0 to 65535');
  });

  it('prints app help without starting the server', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(main(['app', '--help'])).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('missionbraid app'));
    expect(stderr).not.toHaveBeenCalled();
  });
});
