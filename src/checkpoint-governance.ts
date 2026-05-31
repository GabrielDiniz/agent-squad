export interface CheckpointCoreStateLike {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  softBudgetMode: boolean;
  maxTokenRecoveries: number;
  promptMode: "compact" | "balanced" | "deep";
}

export interface CheckpointContextStateLike {
  summary: string;
  snapshotText?: string;
  lastCriticalEvent?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckpointToolProgressLike {
  toolName: string;
  status: "completed" | "skipped" | "failed";
  cacheKey?: string;
  resultHash?: string;
  cachedResult?: string;
  validUntil?: string;
  skipReason?: string;
  replaySource?: "live" | "checkpoint_cache";
}

export interface ExecutionCheckpointStateLike {
  core: CheckpointCoreStateLike;
  context: CheckpointContextStateLike;
  toolProgress?: CheckpointToolProgressLike[];
}

interface GovernanceOptions {
  maxStateChars: number;
  maxStringChars: number;
  maxToolProgressEntries: number;
  redactionEnabled: boolean;
}

export interface GovernedCheckpointResult {
  state: ExecutionCheckpointStateLike;
  json: string;
  redactedFields: number;
  truncated: boolean;
  droppedToolCachedResults: number;
}

const SENSITIVE_KEY_PATTERN = /(token|secret|password|passwd|credential|authorization|auth|private[_-]?key|api[_-]?key|pat)/i;
const SENSITIVE_VALUE_PATTERN = /(ghp_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|glpat-[a-z0-9\-]{20,}|xox[baprs]-[a-z0-9\-]{10,}|-----begin [a-z ]*private key-----)/i;

function parsePositiveInt(value: string | undefined, fallback: number, min = 1): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function parseFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function getOptionsFromEnv(): GovernanceOptions {
  return {
    maxStateChars: parsePositiveInt(process.env.RESUME_CHECKPOINT_MAX_STATE_CHARS, 120000),
    maxStringChars: parsePositiveInt(process.env.RESUME_CHECKPOINT_MAX_STRING_CHARS, 4000),
    maxToolProgressEntries: parsePositiveInt(process.env.RESUME_CHECKPOINT_MAX_TOOL_PROGRESS, 70),
    redactionEnabled: parseFlag(process.env.RESUME_CHECKPOINT_REDACT_SENSITIVE, true),
  };
}

function sanitizeString(value: string, options: GovernanceOptions): { value: string; truncated: boolean; redacted: boolean } {
  let next = value;
  let truncated = false;
  let redacted = false;

  if (options.redactionEnabled && SENSITIVE_VALUE_PATTERN.test(next)) {
    next = "[REDACTED]";
    redacted = true;
  }

  if (next.length > options.maxStringChars) {
    next = `${next.slice(0, options.maxStringChars)}...[TRUNCATED]`;
    truncated = true;
  }

  return { value: next, truncated, redacted };
}

function sanitizeUnknown(
  value: unknown,
  options: GovernanceOptions,
  path: string[] = []
): { value: unknown; truncated: boolean; redactedFields: number } {
  if (value == null) return { value, truncated: false, redactedFields: 0 };

  if (typeof value === "string") {
    const result = sanitizeString(value, options);
    return {
      value: result.value,
      truncated: result.truncated,
      redactedFields: result.redacted ? 1 : 0,
    };
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return { value, truncated: false, redactedFields: 0 };
  }

  if (Array.isArray(value)) {
    let truncated = false;
    let redactedFields = 0;
    const nextArray = value.map((entry, index) => {
      const sanitized = sanitizeUnknown(entry, options, [...path, String(index)]);
      truncated = truncated || sanitized.truncated;
      redactedFields += sanitized.redactedFields;
      return sanitized.value;
    });
    return { value: nextArray, truncated, redactedFields };
  }

  if (typeof value === "object") {
    let truncated = false;
    let redactedFields = 0;
    const nextObject: Record<string, unknown> = {};
    for (const [key, innerValue] of Object.entries(value as Record<string, unknown>)) {
      if (options.redactionEnabled && SENSITIVE_KEY_PATTERN.test(key)) {
        nextObject[key] = "[REDACTED]";
        redactedFields += 1;
        continue;
      }
      const sanitized = sanitizeUnknown(innerValue, options, [...path, key]);
      truncated = truncated || sanitized.truncated;
      redactedFields += sanitized.redactedFields;
      nextObject[key] = sanitized.value;
    }
    return { value: nextObject, truncated, redactedFields };
  }

  return { value: String(value), truncated: false, redactedFields: 0 };
}

function withCompaction(state: ExecutionCheckpointStateLike, options: GovernanceOptions): ExecutionCheckpointStateLike {
  const toolProgress = state.toolProgress ? [...state.toolProgress] : undefined;
  if (toolProgress && toolProgress.length > options.maxToolProgressEntries) {
    state = {
      ...state,
      toolProgress: toolProgress.slice(-options.maxToolProgressEntries),
    };
  }
  return state;
}

export function governCheckpointState(state: ExecutionCheckpointStateLike): GovernedCheckpointResult {
  const options = getOptionsFromEnv();

  const sanitized = sanitizeUnknown(state, options);
  let governed = withCompaction(sanitized.value as ExecutionCheckpointStateLike, options);
  let json = JSON.stringify(governed);
  let truncated = sanitized.truncated;
  let droppedToolCachedResults = 0;

  if (json.length > options.maxStateChars && governed.toolProgress?.length) {
    governed = {
      ...governed,
      toolProgress: governed.toolProgress.map((entry) => {
        if (entry.cachedResult != null) droppedToolCachedResults += 1;
        return { ...entry, cachedResult: undefined };
      }),
    };
    json = JSON.stringify(governed);
    truncated = true;
  }

  if (json.length > options.maxStateChars) {
    governed = {
      ...governed,
      context: {
        summary: governed.context.summary.slice(0, Math.min(options.maxStringChars, 1200)),
        lastCriticalEvent: governed.context.lastCriticalEvent,
        metadata: {
          ...(governed.context.metadata ?? {}),
          checkpointTruncated: true,
        },
      },
      toolProgress: governed.toolProgress?.slice(-Math.min(20, options.maxToolProgressEntries)),
    };
    json = JSON.stringify(governed);
    truncated = true;
  }

  if (json.length > options.maxStateChars) {
    governed = {
      ...governed,
      context: {
        summary: "Checkpoint truncado por limite de payload",
        lastCriticalEvent: governed.context.lastCriticalEvent,
        metadata: {
          checkpointTruncated: true,
          payloadChars: json.length,
        },
      },
      toolProgress: [],
    };
    json = JSON.stringify(governed);
    truncated = true;
  }

  return {
    state: governed,
    json,
    redactedFields: sanitized.redactedFields,
    truncated,
    droppedToolCachedResults,
  };
}

export function getCheckpointMaxPerJob(): number {
  return parsePositiveInt(process.env.RESUME_CHECKPOINT_MAX_PER_JOB, 50);
}

export function shouldRejectOutOfOrderCheckpoint(latestCheckpointSeq: number, nextCheckpointSeq: number): boolean {
  return latestCheckpointSeq > 0 && nextCheckpointSeq < latestCheckpointSeq;
}

export function isCheckpointVersionCompatible(checkpointVersion: number): boolean {
  const current = parsePositiveInt(process.env.RESUME_CHECKPOINT_VERSION, 1);
  const minCompat = parsePositiveInt(process.env.RESUME_CHECKPOINT_MIN_COMPAT_VERSION, current);
  return checkpointVersion >= minCompat && checkpointVersion <= current;
}
