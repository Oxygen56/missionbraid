#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

const exec = promisify(execFile);
const [standardTarballArg, lockfileArg, outputArg] = process.argv.slice(2);
if (!standardTarballArg || !lockfileArg || !outputArg) {
  throw new Error(
    'Usage: build-source-candidate.mjs <standard-npm-tarball> <pnpm-lock.yaml> <output.tgz>',
  );
}

const standardTarball = resolve(standardTarballArg);
const lockfile = resolve(lockfileArg);
const output = resolve(outputArg);
const stage = await mkdtemp(join(tmpdir(), 'missionbraid-source-candidate-'));
try {
  await exec('tar', ['-xzf', standardTarball, '-C', stage]);
  await cp(lockfile, join(stage, 'package', 'pnpm-lock.yaml'));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, deterministicGzip(await deterministicTar(stage)));
  const [bundle, lock] = await Promise.all([readFile(output), readFile(lockfile)]);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 'missionbraid.dev/source-candidate-bundle/v1',
      filename: basename(output),
      constructionMethod:
        'Extract the untouched npm-pack tarball, inject the exact repository pnpm-lock.yaml at package root, sort paths, normalize tar metadata, and gzip with a zero timestamp and normalized OS byte.',
      standardTarball: basename(standardTarball),
      bundleSha256: createHash('sha256').update(bundle).digest('hex'),
      lockfileSha256: createHash('sha256').update(lock).digest('hex'),
    }),
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}

async function deterministicTar(root) {
  const entries = await collectEntries(root, join(root, 'package'));
  const chunks = [];
  for (const entry of entries) {
    const header = tarHeader(entry);
    chunks.push(header);
    if (entry.type === 'file') {
      const content = await readFile(entry.absolutePath);
      chunks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding > 0) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

async function collectEntries(root, absolutePath) {
  const info = await lstat(absolutePath);
  const relativePath = relative(root, absolutePath).split(sep).join('/');
  if (info.isSymbolicLink()) {
    return [
      {
        type: 'symlink',
        path: relativePath,
        absolutePath,
        linkname: await readlink(absolutePath),
        size: 0,
      },
    ];
  }
  if (info.isFile()) {
    return [{ type: 'file', path: relativePath, absolutePath, linkname: '', size: info.size }];
  }
  if (!info.isDirectory()) throw new Error(`Unsupported source bundle entry: ${relativePath}`);
  const entries = [
    { type: 'directory', path: `${relativePath}/`, absolutePath, linkname: '', size: 0 },
  ];
  const children = (await readdir(absolutePath)).sort((left, right) => left.localeCompare(right));
  for (const child of children) {
    entries.push(...(await collectEntries(root, join(absolutePath, child))));
  }
  return entries;
}

function tarHeader(entry) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(entry.path);
  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, normalizedMode(entry));
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.type === 'directory' ? 0x35 : entry.type === 'symlink' ? 0x32 : 0x30;
  writeText(header, 157, 100, entry.linkname);
  writeText(header, 257, 6, 'ustar');
  writeText(header, 263, 2, '00');
  writeText(header, 345, 155, prefix);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeOctal(header, 148, 8, checksum);
  return header;
}

function normalizedMode(entry) {
  if (entry.type === 'directory' || entry.type === 'symlink') return 0o755;
  return entry.path === 'package/dist/src/cli.js' || /^package\/scripts\/.*\.mjs$/u.test(entry.path)
    ? 0o755
    : 0o644;
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Source bundle path exceeds ustar limits: ${path}`);
}

function writeText(buffer, offset, length, value) {
  const encoded = Buffer.from(value);
  if (encoded.length > length)
    throw new Error(`Tar field exceeds ${String(length)} bytes: ${value}`);
  encoded.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0');
  writeText(buffer, offset, length, `${text}\0`);
}

function deterministicGzip(input) {
  const output = gzipSync(input, { level: 9, mtime: 0 });
  output[9] = 255;
  return output;
}
