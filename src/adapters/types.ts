export type RuntimeId = 'codex' | 'qoder' | 'claude';

export type RuntimeCapabilityName =
  | 'observe'
  | 'context_capture'
  | 'steer'
  | 'interrupt'
  | 'pre_tool_gate'
  | 'resume'
  | 'native_fork'
  | 'workspace_restore'
  | 'external_effect_control';

export type RuntimeCapabilityStatus = 'supported' | 'unsupported' | 'unknown';

export type RuntimeCapabilityControl =
  | 'native'
  | 'controller'
  | 'cooperative'
  | 'observe-only'
  | 'none'
  | 'unknown';

export interface RuntimeCapabilityDeclaration {
  readonly status: RuntimeCapabilityStatus;
  readonly control: RuntimeCapabilityControl;
  /** A bounded claim about this adapter implementation, not the Harness in general. */
  readonly detail: string;
}

export type RuntimeAdapterCapabilities = Readonly<
  Record<RuntimeCapabilityName, RuntimeCapabilityDeclaration>
>;

export type OutputStream = 'stdout' | 'stderr';

export interface ProcessOutputLine {
  /** Controller-observed order across both process streams. */
  readonly sequence: number;
  /** Order within the named stream; unlike `sequence`, this is not a merged-stream order. */
  readonly streamSequence: number;
  readonly stream: OutputStream;
  readonly line: string;
  readonly receivedAt: string;
}

export interface RuntimeOutputLine extends ProcessOutputLine {
  readonly runtime: RuntimeId;
  readonly value?: unknown;
}

export type OutputLineObserver = (event: ProcessOutputLine) => void | Promise<void>;

export type ProcessStartObserver = (pid: number) => void | Promise<void>;

export type RuntimeOutputObserver = (event: RuntimeOutputLine) => void | Promise<void>;

export interface ProcessInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Written to stdin but intentionally omitted from the execution record. */
  readonly stdin?: string;
}

export interface RecordedProcessInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface SerializedProcessError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

export interface ProcessRunOptions {
  readonly signal?: AbortSignal;
  readonly onStart?: ProcessStartObserver;
  readonly onOutput?: OutputLineObserver;
  readonly abortGraceMs?: number;
}

export interface ProcessRunResult {
  readonly invocation: RecordedProcessInvocation;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly aborted: boolean;
  readonly stdoutLineCount: number;
  readonly stderrLineCount: number;
  readonly spawnError?: SerializedProcessError;
  readonly startError?: SerializedProcessError;
  readonly observerError?: SerializedProcessError;
}

export type RuntimeDetectionStatus = 'ready' | 'present-unresponsive' | 'present-error' | 'missing';

export interface RuntimeDetection {
  readonly runtime: RuntimeId;
  readonly command: string;
  readonly executablePath: string | null;
  readonly available: boolean;
  readonly responsive: boolean;
  readonly status: RuntimeDetectionStatus;
  readonly version: string | null;
  readonly versionSource: 'output' | 'path' | null;
  readonly checkedAt: string;
  readonly durationMs: number;
  readonly probeExitCode: number | null;
  readonly probeSignal: NodeJS.Signals | null;
}

export interface AdapterRunRequest {
  readonly workspace: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
  readonly onStart?: ProcessStartObserver;
  readonly onOutput?: RuntimeOutputObserver;
}

export interface RuntimeInvocation extends ProcessInvocation {
  readonly runtime: RuntimeId;
  readonly outputProtocol: 'codex-jsonl' | 'qoder-stream-json' | 'claude-stream-json';
}

export interface RuntimeRunResult {
  readonly runtime: RuntimeId;
  readonly outputProtocol: RuntimeInvocation['outputProtocol'];
  readonly process: ProcessRunResult;
}

export interface RuntimeAdapter<Request extends AdapterRunRequest = AdapterRunRequest> {
  readonly runtime: RuntimeId;
  /** Optional for legacy adapters; new adapters should declare every capability boundary. */
  readonly capabilities?: RuntimeAdapterCapabilities;
  detect(): Promise<RuntimeDetection>;
  buildInvocation(request: Request): RuntimeInvocation;
  run(request: Request): Promise<RuntimeRunResult>;
}
