export const PACKAGE_CONTRACT_SCHEMA_VERSION = 'missionbraid.dev/package-contract/v1' as const;
export const PACKAGE_RELEASE_LINE = '1.x' as const;

export interface PackageExportTargetV1 {
  readonly types: string;
  readonly import: string;
}

export interface MissionBraidPackageContractV1 {
  readonly schemaVersion: typeof PACKAGE_CONTRACT_SCHEMA_VERSION;
  readonly packageName: 'missionbraid';
  readonly releaseLine: typeof PACKAGE_RELEASE_LINE;
  readonly moduleType: 'module';
  readonly nodeEngine: '>=24 <27';
  readonly cli: { readonly missionbraid: './dist/src/cli.js' };
  readonly types: './dist/src/public-api.d.ts';
  readonly files: readonly string[];
  readonly exports: Readonly<Record<string, PackageExportTargetV1>>;
  readonly publicationBoundary: {
    readonly packageManifestWired: true;
    readonly localTarballInstallable: true;
    readonly registryPublication: 'not-performed';
    readonly independentExternalReproduction: 'not-established';
  };
}

export const MISSIONBRAID_PACKAGE_CONTRACT_V1 = {
  schemaVersion: PACKAGE_CONTRACT_SCHEMA_VERSION,
  packageName: 'missionbraid',
  releaseLine: PACKAGE_RELEASE_LINE,
  moduleType: 'module',
  nodeEngine: '>=24 <27',
  cli: { missionbraid: './dist/src/cli.js' },
  types: './dist/src/public-api.d.ts',
  files: [
    'dist',
    'docs/adapter-sdk.md',
    'examples/third-party-adapter',
    'README.md',
    'README.zh-CN.md',
    'LICENSE',
    'NOTICE',
  ],
  exports: {
    '.': {
      types: './dist/src/public-api.d.ts',
      import: './dist/src/public-api.js',
    },
    './v1': {
      types: './dist/src/public-api.d.ts',
      import: './dist/src/public-api.js',
    },
    './adapter-sdk': {
      types: './dist/src/adapter-sdk.d.ts',
      import: './dist/src/adapter-sdk.js',
    },
    './adapter-sdk/v1': {
      types: './dist/src/adapter-sdk.d.ts',
      import: './dist/src/adapter-sdk.js',
    },
    './adapter-conformance': {
      types: './dist/src/adapter-conformance.d.ts',
      import: './dist/src/adapter-conformance.js',
    },
    './adapter-conformance/v1': {
      types: './dist/src/adapter-conformance.d.ts',
      import: './dist/src/adapter-conformance.js',
    },
    './package-contract': {
      types: './dist/src/package-contract.d.ts',
      import: './dist/src/package-contract.js',
    },
    './outcome-studio': {
      types: './dist/src/outcome-studio.d.ts',
      import: './dist/src/outcome-studio.js',
    },
    './outcome-studio/v1': {
      types: './dist/src/outcome-studio.d.ts',
      import: './dist/src/outcome-studio.js',
    },
    './mission-plan': {
      types: './dist/src/mission-plan.d.ts',
      import: './dist/src/mission-plan.js',
    },
    './mission-plan/v1': {
      types: './dist/src/mission-plan.d.ts',
      import: './dist/src/mission-plan.js',
    },
    './mission-plan-runtime': {
      types: './dist/src/mission-plan-runtime.d.ts',
      import: './dist/src/mission-plan-runtime.js',
    },
    './mission-plan-runtime/v1': {
      types: './dist/src/mission-plan-runtime.d.ts',
      import: './dist/src/mission-plan-runtime.js',
    },
    './examples/minimal-adapter': {
      types: './dist/examples/minimal-adapter.d.ts',
      import: './dist/examples/minimal-adapter.js',
    },
  },
  publicationBoundary: {
    packageManifestWired: true,
    localTarballInstallable: true,
    registryPublication: 'not-performed',
    independentExternalReproduction: 'not-established',
  },
} as const satisfies MissionBraidPackageContractV1;

export interface PackageContractIssueV1 {
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
}

export interface PackageContractReportV1 {
  readonly schemaVersion: typeof PACKAGE_CONTRACT_SCHEMA_VERSION;
  readonly conforms: boolean;
  readonly issues: readonly PackageContractIssueV1[];
  readonly independentExternalReproduction: 'not-established';
}

/**
 * Validate an installable 1.x package manifest without publishing it. A
 * conforming manifest can produce a local tarball; registry publication and
 * independent external reproduction remain separate evidence boundaries.
 */
export function validatePackageManifestV1(manifest: unknown): PackageContractReportV1 {
  const issues: PackageContractIssueV1[] = [];
  const root = record(manifest);
  expectEqual(issues, 'name', root.name, MISSIONBRAID_PACKAGE_CONTRACT_V1.packageName);
  expectEqual(issues, 'type', root.type, MISSIONBRAID_PACKAGE_CONTRACT_V1.moduleType);
  if (root.private !== false) {
    issues.push({ path: 'private', expected: 'false', actual: render(root.private) });
  }
  if (typeof root.version !== 'string' || !/^1\.\d+\.\d+(?:[-+].+)?$/.test(root.version)) {
    issues.push({
      path: 'version',
      expected: '1.x semantic version',
      actual: render(root.version),
    });
  }

  const engines = record(root.engines);
  expectEqual(issues, 'engines.node', engines.node, MISSIONBRAID_PACKAGE_CONTRACT_V1.nodeEngine);
  const bin = record(root.bin);
  expectEqual(
    issues,
    'bin.missionbraid',
    bin.missionbraid,
    MISSIONBRAID_PACKAGE_CONTRACT_V1.cli.missionbraid,
  );
  expectEqual(issues, 'types', root.types, MISSIONBRAID_PACKAGE_CONTRACT_V1.types);

  const files = Array.isArray(root.files) ? root.files : [];
  for (const required of MISSIONBRAID_PACKAGE_CONTRACT_V1.files) {
    if (!files.includes(required)) {
      issues.push({ path: 'files', expected: `contains ${required}`, actual: render(root.files) });
    }
  }

  const exports = record(root.exports);
  for (const [subpath, target] of Object.entries(MISSIONBRAID_PACKAGE_CONTRACT_V1.exports)) {
    const candidate = record(exports[subpath]);
    expectEqual(issues, `exports.${subpath}.types`, candidate.types, target.types);
    expectEqual(issues, `exports.${subpath}.import`, candidate.import, target.import);
  }

  return {
    schemaVersion: PACKAGE_CONTRACT_SCHEMA_VERSION,
    conforms: issues.length === 0,
    issues,
    independentExternalReproduction: 'not-established',
  };
}

function expectEqual(
  issues: PackageContractIssueV1[],
  path: string,
  actual: unknown,
  expected: string,
): void {
  if (actual !== expected) issues.push({ path, expected, actual: render(actual) });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function render(value: unknown): string {
  if (value === undefined) return 'missing';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
