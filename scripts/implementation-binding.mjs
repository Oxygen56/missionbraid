import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function captureImplementationSource(root, excludedOutputFiles = []) {
  const sourceTreeDigestExclusions = normalizeExclusions(root, excludedOutputFiles);
  const status = commandOutput('git', ['status', '--porcelain=v1', '--untracked-files=all'], root);
  const sourceFingerprint = fingerprintGitVisibleFiles(root, sourceTreeDigestExclusions);
  return {
    gitRevision: commandOutput('git', ['rev-parse', 'HEAD'], root),
    committedTree: commandOutput('git', ['rev-parse', 'HEAD^{tree}'], root),
    worktreeState: status.length === 0 ? 'clean' : 'dirty',
    sourceTreeDigest: sourceFingerprint.digest,
    sourceFileCount: sourceFingerprint.fileCount,
    sourceTreeDigestScope: 'git-visible-tracked-and-untracked-nonignored',
    sourceTreeDigestExclusions,
  };
}

export function completeFreshBuildImplementation(root, captured, excludedOutputFiles = []) {
  const afterBuild = captureImplementationSource(root, excludedOutputFiles);
  const stableFields = ['gitRevision', 'committedTree', 'sourceTreeDigest', 'sourceFileCount'];
  if (stableFields.some((field) => afterBuild[field] !== captured[field])) {
    throw new Error('Git-visible source inputs changed during the fresh proof build.');
  }
  if (
    JSON.stringify(afterBuild.sourceTreeDigestExclusions) !==
    JSON.stringify(captured.sourceTreeDigestExclusions)
  ) {
    throw new Error('Source digest exclusions changed during the fresh proof build.');
  }
  return {
    ...captured,
    freshBuildUsed: true,
    sourceInputsStableAfterBuild: true,
    distributionDigest: fingerprintDirectory(join(root, 'dist')),
  };
}

export function fingerprintGitVisibleFiles(root, excludedPaths = []) {
  const listed = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'buffer',
    shell: false,
  });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed: ${String(listed.stderr)}`);
  }
  const excluded = new Set(excludedPaths);
  const files = listed.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((path) => !excluded.has(path))
    .sort(comparePaths);
  const hash = createHash('sha256');
  for (const path of files) appendPathFingerprint(hash, path, resolve(root, path));
  return { digest: `sha256:${hash.digest('hex')}`, fileCount: files.length };
}

export function fingerprintDirectory(root) {
  const files = collectFiles(root).sort(comparePaths);
  const hash = createHash('sha256');
  for (const absolute of files) {
    appendPathFingerprint(hash, relative(root, absolute), absolute);
  }
  return `sha256:${hash.digest('hex')}`;
}

function normalizeExclusions(root, excludedOutputFiles) {
  const normalized = excludedOutputFiles
    .filter((path) => typeof path === 'string')
    .map((path) => relative(root, resolve(path)))
    .filter(
      (path) =>
        path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path),
    )
    .map((path) => path.split(sep).join('/'));
  return [...new Set(normalized)].sort(comparePaths);
}

function collectFiles(root) {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = join(root, entry.name);
    return entry.isDirectory() ? collectFiles(absolute) : [absolute];
  });
}

function appendPathFingerprint(hash, path, absolute) {
  const stat = lstatSync(absolute);
  hash.update(path, 'utf8');
  hash.update('\0');
  hash.update(stat.isSymbolicLink() ? 'symlink' : 'file', 'utf8');
  hash.update('\0');
  if (stat.isSymbolicLink()) hash.update(readlinkSync(absolute), 'utf8');
  else hash.update(readFileSync(absolute));
  hash.update('\0');
}

function commandOutput(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
