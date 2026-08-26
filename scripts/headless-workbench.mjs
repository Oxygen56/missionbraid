import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

export async function launchHeadlessWorkbench(url, userDataDir) {
  const port = await freePort();
  const executable = await browserExecutable();
  const platformArguments = process.platform === 'linux' ? ['--no-sandbox'] : [];
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      ...platformArguments,
      `--remote-debugging-port=${String(port)}`,
      `--user-data-dir=${userDataDir}`,
      url,
    ],
    { stdio: 'ignore' },
  );
  const deadline = Date.now() + 20_000;
  let target;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json();
      target = targets.find((candidate) => candidate.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch {}
    await wait(100);
  }
  if (!target?.webSocketDebuggerUrl) {
    child.kill('SIGTERM');
    throw new Error('Chrome DevTools endpoint did not become ready.');
  }
  const client = await cdp(target.webSocketDebuggerUrl);
  return {
    evaluate: async (expression) => {
      const result = await client.call('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) throw new Error('Browser evaluation failed.');
      return result.result.value;
    },
    close: async () => {
      client.close();
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        wait(2_000),
      ]);
    },
  };
}

async function browserExecutable() {
  const configured = process.env.MISSIONBRAID_BROWSER_EXECUTABLE ?? process.env.CHROME_PATH;
  const candidates = [
    configured,
    process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined,
    process.platform === 'linux' ? '/usr/bin/google-chrome' : undefined,
    process.platform === 'linux' ? '/usr/bin/google-chrome-stable' : undefined,
    process.platform === 'linux' ? '/usr/bin/chromium' : undefined,
    process.platform === 'linux' ? '/usr/bin/chromium-browser' : undefined,
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : undefined,
    process.platform === 'win32' && process.env.PROGRAMFILES
      ? join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : undefined,
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }

  throw new Error(
    'No supported Chrome or Chromium executable was found. Set MISSIONBRAID_BROWSER_EXECUTABLE.',
  );
}

export function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function cdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  return {
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolveCall, reject) => {
        pending.set(id, { resolve: resolveCall, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  await new Promise((resolveClose) => server.close(resolveClose));
  if (port === undefined) throw new Error('Could not allocate a browser debugging port.');
  return port;
}
