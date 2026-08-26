import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadAdapterRegistryV1, main, parseAppArguments, parseArguments } from './cli.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
      adapterModules: [],
    });
  });

  it('loads an external Adapter module from the consumer filesystem', async () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-cli-adapter-'));
    roots.push(root);
    const adapterPath = join(root, 'adapter.mjs');
    writeFileSync(
      adapterPath,
      `const unsupported = { status: 'unsupported', fidelity: 'unsupported', detail: 'Not exposed.' };\n` +
        `export default {\n` +
        `  manifest: {\n` +
        `    schemaVersion: 'missionbraid.dev/adapter-manifest/v1', apiVersion: '1.0.0',\n` +
        `    adapterId: 'consumer.fixture', harnessId: 'consumer-fixture', displayName: 'Consumer Fixture', adapterVersion: '1.0.0',\n` +
        `    transport: 'direct', nativeProtocol: 'consumer-fixture/v1',\n` +
        `    capabilities: Object.fromEntries(['discover','observe','context-capture','steer','interrupt','pre-tool-gate','resume','native-fork','workspace-bind','workspace-restore','external-effect-control'].map((name) => [name, unsupported])),\n` +
        `  },\n` +
        `  async discover() { throw new Error('not called'); },\n` +
        `  async run() { throw new Error('not called'); },\n` +
        `};\n`,
    );

    const parsed = parseArguments([
      'run',
      '/tmp/mission.yaml',
      '--adapter',
      adapterPath,
      '--adapter',
      adapterPath,
    ]);
    expect(parsed.adapterModules).toEqual([adapterPath, adapterPath]);

    const registry = await loadAdapterRegistryV1([adapterPath]);
    expect(registry.list().map((manifest) => manifest.adapterId)).toEqual(['consumer.fixture']);
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
    ).toEqual({ stateDir: '/tmp/missionbraid-app-state', port: 4318, adapterModules: [] });
    expect(parseAppArguments(['--adapter', '/tmp/consumer-adapter.mjs']).adapterModules).toEqual([
      '/tmp/consumer-adapter.mjs',
    ]);
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
