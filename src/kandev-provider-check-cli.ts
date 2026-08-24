import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  parseKandevProviderCheckConfig,
  runKandevProviderCheck,
  type KandevProviderCheckClient,
  type KandevProviderCheckConfigV1,
} from './kandev-provider-check.js';
import { KandevClient } from './providers/kandev.js';

const MAX_CONFIG_BYTES = 64 * 1024;

export interface ParsedKandevProviderCheckArguments {
  readonly configFile: string;
  readonly outputFile?: string;
}

export interface KandevProviderCheckCommandDependencies {
  readonly createClient?: (config: KandevProviderCheckConfigV1) => KandevProviderCheckClient;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly bearerToken?: string;
}

export async function runKandevProviderCheckCommand(
  argv: readonly string[],
  dependencies: KandevProviderCheckCommandDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text: string) => process.stderr.write(text));
  let parsed: ParsedKandevProviderCheckArguments;
  try {
    parsed = parseKandevProviderCheckArguments(argv);
  } catch (error) {
    stderr(`${errorMessage(error)}\n\n${kandevProviderCheckUsage()}\n`);
    return 64;
  }

  try {
    const config = await readKandevProviderCheckConfig(parsed.configFile);
    const client =
      dependencies.createClient?.(config) ??
      new KandevClient({
        baseUrl: config.baseUrl,
        ...(dependencies.bearerToken === undefined
          ? {}
          : { bearerToken: dependencies.bearerToken }),
      });
    const result = await runKandevProviderCheck(config, client, {
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    const rendered = `${JSON.stringify(result, null, 2)}\n`;
    if (parsed.outputFile !== undefined) {
      await writePrivateAtomic(parsed.outputFile, rendered);
    }
    stdout(rendered);
    return 0;
  } catch (error) {
    stderr(
      `${JSON.stringify(
        {
          error: error instanceof Error ? error.name : 'Error',
          message: errorMessage(error),
        },
        null,
        2,
      )}\n`,
    );
    return 1;
  }
}

export function parseKandevProviderCheckArguments(
  argv: readonly string[],
): ParsedKandevProviderCheckArguments {
  const [provider, rawConfigFile, ...rest] = argv;
  if (provider !== 'kandev') {
    throw new Error('provider-check currently requires the kandev provider.');
  }
  if (rawConfigFile === undefined || rawConfigFile.startsWith('--')) {
    throw new Error('provider-check kandev requires a config JSON file.');
  }
  let outputFile: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag !== '--output') throw new Error(`Unknown option ${String(flag)}.`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('--output requires a file path.');
    }
    if (outputFile !== undefined) throw new Error('--output may only be specified once.');
    outputFile = resolve(value);
    index += 1;
  }
  return {
    configFile: resolve(rawConfigFile),
    ...(outputFile === undefined ? {} : { outputFile }),
  };
}

export async function readKandevProviderCheckConfig(
  file: string,
): Promise<KandevProviderCheckConfigV1> {
  const metadata = await stat(file);
  if (!metadata.isFile()) throw new Error('Kandev provider-check config path must be a file.');
  if (metadata.size > MAX_CONFIG_BYTES) {
    throw new Error(`Kandev provider-check config exceeds ${MAX_CONFIG_BYTES} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Kandev provider-check config is not valid JSON.');
    }
    throw error;
  }
  return parseKandevProviderCheckConfig(parsed);
}

export function kandevProviderCheckUsage(): string {
  return 'missionbraid provider-check kandev <config.json> [--output <result.json>]';
}

async function writePrivateAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
