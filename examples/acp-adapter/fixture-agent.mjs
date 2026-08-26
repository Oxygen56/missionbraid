import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

let workspace;
const sessions = new Map();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
      authMethods: [],
      agentInfo: { name: 'missionbraid-acp-fixture', version: '1.0.0' },
    });
    continue;
  }
  if (message.method === 'session/new') {
    workspace = message.params.cwd;
    const sessionId = 'acp-session-fixture';
    sessions.set(sessionId, true);
    respond(message.id, { sessionId });
    continue;
  }
  if (message.method === 'session/prompt') {
    const sessionId = message.params.sessionId;
    if (!sessions.has(sessionId) || typeof workspace !== 'string') {
      fail(message.id, -32602, 'Unknown ACP session.');
      continue;
    }
    await writeFile(join(workspace, 'acp-result.txt'), 'acp-completed\n');
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Fixture result written.' },
      },
    });
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'fixture-write',
        status: 'completed',
        rawOutput: { path: 'acp-result.txt' },
      },
    });
    respond(message.id, { stopReason: 'end_turn' });
    continue;
  }
  if (message.method === 'session/cancel') continue;
  fail(message.id, -32601, `Unknown method ${String(message.method)}`);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}
