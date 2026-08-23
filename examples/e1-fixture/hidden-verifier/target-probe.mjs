import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function serializeError(error, module) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    code: error !== null && typeof error === 'object' && 'code' in error ? error.code : null,
    key: error !== null && typeof error === 'object' && 'key' in error ? error.key : null,
    isEffectConflict:
      typeof module?.EffectConflictError === 'function' &&
      error instanceof module.EffectConflictError,
    isLedgerCorruption:
      typeof module?.LedgerCorruptionError === 'function' &&
      error instanceof module.LedgerCorruptionError,
  };
}

async function loadRequest() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return JSON.parse(chunks.join(''));
}

async function execute(request, targetWorkspace) {
  const ledgerModule = await import(pathToFileURL(join(targetWorkspace, 'src', 'ledger.mjs')).href);

  if (request.action === 'exports') {
    return {
      EffectLedger: typeof ledgerModule.EffectLedger,
      EffectConflictError: typeof ledgerModule.EffectConflictError,
      LedgerCorruptionError: typeof ledgerModule.LedgerCorruptionError,
    };
  }

  if (request.action === 'core') {
    const core = await import(pathToFileURL(join(targetWorkspace, 'src', 'effect-core.mjs')).href);
    return {
      canonical: core.canonicalJson(request.value),
      effect: core.createEffect(request.input),
      equivalent: core.payloadsEqual(request.left, request.right),
      serialized: core.serializeEffect(core.createEffect(request.input)),
      exports: {
        canonicalJson: typeof core.canonicalJson,
        createEffect: typeof core.createEffect,
        payloadsEqual: typeof core.payloadsEqual,
        serializeEffect: typeof core.serializeEffect,
      },
    };
  }

  if (request.action === 'invalid-payloads') {
    const core = await import(pathToFileURL(join(targetWorkspace, 'src', 'effect-core.mjs')).href);
    const cyclic = {};
    cyclic.self = cyclic;
    const sparse = [];
    sparse[1] = 'present';
    const invalid = [
      undefined,
      null,
      [],
      { bad: undefined },
      { bad: Number.NaN },
      { bad: Number.POSITIVE_INFINITY },
      { bad: 1n },
      { bad: new Date(0) },
      { bad: new Map([['key', 'value']]) },
      { bad: sparse },
      cyclic,
    ];
    return invalid.map((payload) => {
      try {
        core.createEffect({ key: 'invalid', payload });
        return false;
      } catch {
        return true;
      }
    });
  }

  const ledger = new ledgerModule.EffectLedger(request.filePath);
  if (request.action === 'record') {
    return await ledger.record(request.input);
  }
  if (request.action === 'replay') {
    return await ledger.replay();
  }
  throw new Error(`Unknown probe action: ${String(request.action)}`);
}

let ledgerModule;
try {
  const targetValue = process.env.MISSIONBRAID_TARGET_WORKSPACE;
  if (targetValue === undefined || !isAbsolute(targetValue)) {
    throw new Error('MISSIONBRAID_TARGET_WORKSPACE must be an absolute path');
  }
  const targetWorkspace = resolve(targetValue);
  ledgerModule = await import(pathToFileURL(join(targetWorkspace, 'src', 'ledger.mjs')).href);
  const value = await execute(await loadRequest(), targetWorkspace);
  process.stdout.write(`${JSON.stringify({ ok: true, value })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: serializeError(error, ledgerModule) })}\n`,
  );
}
