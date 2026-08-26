import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (typeof request.workspace !== 'string' || !request.workspace.startsWith('/')) process.exit(2);
if (typeof request.instruction !== 'string' || request.instruction.trim() === '') process.exit(3);
await writeFile(join(request.workspace, 'provider-result.txt'), 'provider-completed\n');
process.stdout.write(
  `${JSON.stringify({ type: 'workspace.result-written', path: 'provider-result.txt' })}\n`,
);
