import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';

import type {
  OutputLineObserver,
  OutputStream,
  ProcessInvocation,
  ProcessOutputLine,
  ProcessRunOptions,
  ProcessRunResult,
  RecordedProcessInvocation,
  SerializedProcessError,
} from './types.js';

const DEFAULT_ABORT_GRACE_MS = 1_000;

function serializeError(error: unknown): SerializedProcessError {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;

    return {
      name: error.name,
      message: error.message,
      ...(code === undefined ? {} : { code }),
    };
  }

  return {
    name: 'Error',
    message: String(error),
  };
}

function recordedInvocation(invocation: ProcessInvocation): RecordedProcessInvocation {
  return {
    command: invocation.command,
    args: [...invocation.args],
    cwd: invocation.cwd,
  };
}

function executableCandidates(command: string, cwd: string): string[] {
  if (isAbsolute(command)) {
    return [command];
  }

  if (command.includes(sep) || command.includes('/')) {
    return [resolve(cwd, command)];
  }

  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter((entry) => entry.length > 0);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter((extension) => extension.length > 0)
      : [''];

  return pathEntries.flatMap((entry) =>
    extensions.map((extension) => join(entry, `${command}${extension}`)),
  );
}

/** Resolve an executable without invoking it or inspecting its environment. */
export async function resolveExecutable(
  command: string,
  cwd = process.cwd(),
): Promise<string | null> {
  for (const candidate of executableCandidates(command, cwd)) {
    try {
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue searching PATH. Absence is returned as data, not an exception.
    }
  }

  return null;
}

function validateInvocation(invocation: ProcessInvocation): void {
  if (invocation.command.trim().length === 0) {
    throw new TypeError('Process command must not be empty.');
  }
  if (!isAbsolute(invocation.cwd)) {
    throw new TypeError('Process cwd must be an absolute path.');
  }
}

function validateAbortGraceMs(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError('abortGraceMs must be a non-negative finite number.');
  }
}

export async function runProcess(
  invocation: ProcessInvocation,
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  validateInvocation(invocation);
  const abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
  validateAbortGraceMs(abortGraceMs);

  const record = recordedInvocation(invocation);
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const startedMonotonic = performance.now();

  if (options.signal?.aborted === true) {
    return {
      invocation: record,
      pid: null,
      exitCode: null,
      signal: null,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: performance.now() - startedMonotonic,
      aborted: true,
      stdoutLineCount: 0,
      stderrLineCount: 0,
    };
  }

  return await new Promise<ProcessRunResult>((resolveResult) => {
    let child;
    try {
      child = spawn(invocation.command, [...invocation.args], {
        cwd: invocation.cwd,
        env: process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolveResult({
        invocation: record,
        pid: null,
        exitCode: null,
        signal: null,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: performance.now() - startedMonotonic,
        aborted: false,
        stdoutLineCount: 0,
        stderrLineCount: 0,
        spawnError: serializeError(error),
      });
      return;
    }

    const pid = child.pid ?? null;
    const decoders: Record<OutputStream, StringDecoder> = {
      stdout: new StringDecoder('utf8'),
      stderr: new StringDecoder('utf8'),
    };
    const pending: Record<OutputStream, string> = {
      stdout: '',
      stderr: '',
    };
    const streamFinished: Record<OutputStream, boolean> = {
      stdout: false,
      stderr: false,
    };

    let sequence = 0;
    const streamSequence: Record<OutputStream, number> = {
      stdout: 0,
      stderr: 0,
    };
    let stdoutLineCount = 0;
    let stderrLineCount = 0;
    let aborted = false;
    let spawnError: SerializedProcessError | undefined;
    let startError: SerializedProcessError | undefined;
    let observerError: SerializedProcessError | undefined;
    let observerChain = Promise.resolve();
    let startSettled = Promise.resolve();
    let killTimer: NodeJS.Timeout | undefined;
    let closed = false;
    let terminationRequested = false;
    let finalizationStarted = false;
    let closeResult:
      | {
          readonly exitCode: number | null;
          readonly signal: NodeJS.Signals | null;
        }
      | undefined;
    let resolveStreamsFinished: (() => void) | undefined;
    const streamsFinished = new Promise<void>((resolveStreams) => {
      resolveStreamsFinished = resolveStreams;
    });

    child.stdout.pause();
    child.stderr.pause();

    const terminate = (): void => {
      if (terminationRequested || closed || child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      terminationRequested = true;
      child.kill('SIGTERM');
      if (abortGraceMs > 0) {
        killTimer = setTimeout(() => {
          if (!closed && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }, abortGraceMs);
        killTimer.unref();
      }
    };

    const observe = (event: ProcessOutputLine): void => {
      if (options.onOutput === undefined || observerError !== undefined) {
        return;
      }

      observerChain = observerChain
        .then(async () => {
          await options.onOutput?.(event);
        })
        .catch((error: unknown) => {
          observerError = serializeError(error);
          terminate();
        });
    };

    const emitLine = (stream: OutputStream, rawLine: string): void => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      sequence += 1;
      streamSequence[stream] += 1;
      if (stream === 'stdout') {
        stdoutLineCount += 1;
      } else {
        stderrLineCount += 1;
      }
      observe({
        sequence,
        streamSequence: streamSequence[stream],
        stream,
        line,
        receivedAt: new Date().toISOString(),
      });
    };

    const acceptText = (stream: OutputStream, text: string): void => {
      pending[stream] += text;
      let newlineIndex = pending[stream].indexOf('\n');
      while (newlineIndex >= 0) {
        emitLine(stream, pending[stream].slice(0, newlineIndex));
        pending[stream] = pending[stream].slice(newlineIndex + 1);
        newlineIndex = pending[stream].indexOf('\n');
      }
    };

    const finishStream = (stream: OutputStream): void => {
      if (streamFinished[stream]) {
        return;
      }
      streamFinished[stream] = true;
      acceptText(stream, decoders[stream].end());
      if (pending[stream].length > 0) {
        emitLine(stream, pending[stream]);
        pending[stream] = '';
      }
      if (streamFinished.stdout && streamFinished.stderr) {
        resolveStreamsFinished?.();
      }
    };

    const finalize = (): void => {
      if (closeResult === undefined || finalizationStarted) {
        return;
      }
      finalizationStarted = true;

      void Promise.all([startSettled, streamsFinished])
        .then(() => observerChain)
        .then(() => {
          resolveResult({
            invocation: record,
            pid,
            exitCode: closeResult?.exitCode ?? null,
            signal: closeResult?.signal ?? null,
            startedAt,
            endedAt: new Date().toISOString(),
            durationMs: performance.now() - startedMonotonic,
            aborted,
            stdoutLineCount,
            stderrLineCount,
            ...(spawnError === undefined ? {} : { spawnError }),
            ...(startError === undefined ? {} : { startError }),
            ...(observerError === undefined ? {} : { observerError }),
          });
        });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      acceptText('stdout', decoders.stdout.write(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      acceptText('stderr', decoders.stderr.write(chunk));
    });
    child.stdout.once('end', () => {
      finishStream('stdout');
    });
    child.stderr.once('end', () => {
      finishStream('stderr');
    });
    child.stdout.once('close', () => {
      finishStream('stdout');
    });
    child.stderr.once('close', () => {
      finishStream('stderr');
    });

    child.once('error', (error) => {
      spawnError = serializeError(error);
    });

    const abortListener = (): void => {
      if (aborted) {
        return;
      }
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener('abort', abortListener, { once: true });
    if (options.signal?.aborted === true) {
      abortListener();
    }

    child.stdin.on('error', () => {
      // A runtime may close stdin as it exits. Its process result remains
      // authoritative; the prompt is deliberately never copied into a log.
    });

    child.once('close', (exitCode, signal) => {
      closed = true;
      closeResult = { exitCode, signal };
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      options.signal?.removeEventListener('abort', abortListener);
      finalize();
    });

    startSettled = Promise.resolve()
      .then(async () => {
        if (pid !== null) {
          await options.onStart?.(pid);
        }
      })
      .catch((error: unknown) => {
        startError = serializeError(error);
        terminate();
      })
      .then(() => {
        if (
          startError === undefined &&
          !terminationRequested &&
          !closed &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          child.stdin.end(invocation.stdin);
        } else {
          child.stdin.end();
        }
        child.stdout.resume();
        child.stderr.resume();
        finalize();
      });
  });
}
