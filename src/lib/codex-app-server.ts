import { copyFile, mkdir } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

export type DisplayWindow = {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetAt: number;
  resetAfterSeconds: number;
  limitWindowSeconds: number;
};

export type AdditionalDisplayLimit = {
  limitName: string;
  primaryWindow: DisplayWindow;
  secondaryWindow: DisplayWindow;
};

export type DisplaySnapshot = {
  source: "app-server" | "app-server-error-body";
  email?: string;
  planType?: string;
  selectedWindow: DisplayWindow;
  primaryWindow: DisplayWindow;
  secondaryWindow: DisplayWindow;
  additionalRateLimits: AdditionalDisplayLimit[];
  fetchedAt: number;
};

type RpcSuccess<T> = {
  id: string;
  result: T;
};

type RpcFailure = {
  id: string;
  error: {
    code: number;
    message: string;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type AccountReadResult = {
  account?: {
    email?: string;
    planType?: string;
  };
};

type RawWindow = {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number;
};

type RawRateLimit = {
  primary_window: RawWindow;
  secondary_window: RawWindow;
};

type RawAdditionalLimit = {
  limit_name: string;
  rate_limit: RawRateLimit;
};

type RawUsageBody = {
  email?: string;
  plan_type?: string;
  rate_limit: RawRateLimit;
  additional_rate_limits?: RawAdditionalLimit[];
};

type AppServerRateLimitResult =
  | RawUsageBody
  | {
      email?: string;
      planType?: string;
      rateLimit?: {
        primaryWindow: {
          usedPercent: number;
          limitWindowSeconds: number;
          resetAfterSeconds: number;
          resetAt: number;
        };
        secondaryWindow: {
          usedPercent: number;
          limitWindowSeconds: number;
          resetAfterSeconds: number;
          resetAt: number;
        };
      };
      additionalRateLimits?: Array<{
        limitName: string;
        rateLimit: {
          primaryWindow: {
            usedPercent: number;
            limitWindowSeconds: number;
            resetAfterSeconds: number;
            resetAt: number;
          };
          secondaryWindow: {
            usedPercent: number;
            limitWindowSeconds: number;
            resetAfterSeconds: number;
            resetAt: number;
          };
        };
      }>;
    };

class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private lineBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private initializePromise?: Promise<void>;
  private requestCounter = 0;
  private resolvedBinaryPath?: string;
  private cachedSnapshot?: DisplaySnapshot;

  getCachedSnapshot(): DisplaySnapshot | undefined {
    return this.cachedSnapshot;
  }

  async readDisplaySnapshot(): Promise<DisplaySnapshot> {
    await this.ensureReady();

    const [account, rateLimits] = await Promise.all([
      this.request<AccountReadResult>("account/read", {}),
      this.readRateLimits(),
    ]);

    const snapshot = {
      ...rateLimits,
      email: rateLimits.email ?? account.account?.email,
      planType: rateLimits.planType ?? account.account?.planType,
    };

    this.cachedSnapshot = snapshot;
    return snapshot;
  }

  private async readRateLimits(): Promise<DisplaySnapshot> {
    try {
      const result = await this.request<AppServerRateLimitResult>("account/rateLimits/read", {});
      return normalizeRateLimits(result, "app-server");
    } catch (error) {
      if (!(error instanceof RpcError)) {
        throw error;
      }

      const rawBody = extractRateLimitBody(error.message);
      if (!rawBody) {
        throw error;
      }

      return normalizeRateLimits(rawBody, "app-server-error-body");
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = this.start().catch((error) => {
      this.initializePromise = undefined;
      throw error;
    });

    return this.initializePromise;
  }

  private async start(): Promise<void> {
    const binaryPath = await this.resolveBinaryPath();
    this.child = await this.spawnAppServer(binaryPath);
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.onStdout(chunk);
    });
    this.child.on("exit", () => {
      this.rejectAll(new Error("Codex app-server exited."));
      this.child = undefined;
      this.initializePromise = undefined;
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex-limit-tracker",
        version: "0.1.0",
      },
      capabilities: {},
    });
  }

  private onStdout(chunk: string): void {
    this.lineBuffer += chunk;

    while (true) {
      const newlineIndex = this.lineBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      const message = JSON.parse(line) as RpcSuccess<unknown> | RpcFailure;
      const pending = this.pending.get(message.id);
      if (!pending) {
        continue;
      }

      this.pending.delete(message.id);

      if ("error" in message) {
        pending.reject(new RpcError(message.error.message, message.error.code));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private async request<T>(method: string, params: object): Promise<T> {
    if (!this.child) {
      throw new Error("Codex app-server is not running.");
    }

    const id = `${method}:${++this.requestCounter}`;
    const payload = JSON.stringify({ id, method, params });

    return new Promise<T>((resolvePromise, rejectPromise) => {
      this.pending.set(id, {
        resolve: (value) => resolvePromise(value as T),
        reject: rejectPromise,
      });

      this.child!.stdin.write(`${payload}\n`, "utf8", (error) => {
        if (!error) {
          return;
        }

        this.pending.delete(id);
        rejectPromise(error);
      });
    });
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private async resolveBinaryPath(): Promise<string> {
    if (this.resolvedBinaryPath) {
      return this.resolvedBinaryPath;
    }

    const candidates = [
      process.env.CODEX_CLI_PATH,
      ...platformCandidates(),
      ...pathCommandCandidates(),
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
      try {
        const runnablePath = await ensureRunnableBinary(candidate);
        this.resolvedBinaryPath = runnablePath;
        return runnablePath;
      } catch {
        continue;
      }
    }

    throw new Error("Codex CLI was not found. Install Codex desktop and sign in first.");
  }

  private async spawnAppServer(binaryPath: string): Promise<ChildProcessWithoutNullStreams> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(binaryPath, ["app-server"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr.resume();

      const onError = (error: Error) => {
        child.removeListener("spawn", onSpawn);
        rejectPromise(error);
      };

      const onSpawn = () => {
        child.removeListener("error", onError);
        resolvePromise(child);
      };

      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
  }
}

function normalizeRateLimits(
  result: AppServerRateLimitResult,
  source: DisplaySnapshot["source"],
): DisplaySnapshot {
  if ("rate_limit" in result) {
    const primaryWindow = normalizeWindow(result.rate_limit.primary_window, "5h");
    const secondaryWindow = normalizeWindow(result.rate_limit.secondary_window, "7d");

    return {
      source,
      email: result.email,
      planType: result.plan_type,
      selectedWindow: pickSelectedWindow(primaryWindow, secondaryWindow),
      primaryWindow,
      secondaryWindow,
      additionalRateLimits: (result.additional_rate_limits ?? []).map((limit) => ({
        limitName: limit.limit_name,
        primaryWindow: normalizeWindow(limit.rate_limit.primary_window, "5h"),
        secondaryWindow: normalizeWindow(limit.rate_limit.secondary_window, "7d"),
      })),
      fetchedAt: Date.now(),
    };
  }

  if (!result.rateLimit) {
    throw new Error("Codex app-server returned an unexpected rate-limit payload.");
  }

  const primaryWindow = normalizeWindowCamel(result.rateLimit.primaryWindow, "5h");
  const secondaryWindow = normalizeWindowCamel(result.rateLimit.secondaryWindow, "7d");

  return {
    source,
    email: result.email,
    planType: result.planType,
    selectedWindow: pickSelectedWindow(primaryWindow, secondaryWindow),
    primaryWindow,
    secondaryWindow,
    additionalRateLimits: (result.additionalRateLimits ?? []).map((limit) => ({
      limitName: limit.limitName,
      primaryWindow: normalizeWindowCamel(limit.rateLimit.primaryWindow, "5h"),
      secondaryWindow: normalizeWindowCamel(limit.rateLimit.secondaryWindow, "7d"),
    })),
    fetchedAt: Date.now(),
  };
}

function normalizeWindow(window: RawWindow, label: string): DisplayWindow {
  return {
    label,
    usedPercent: clampPercent(window.used_percent),
    remainingPercent: clampPercent(100 - window.used_percent),
    resetAt: window.reset_at,
    resetAfterSeconds: window.reset_after_seconds,
    limitWindowSeconds: window.limit_window_seconds,
  };
}

function normalizeWindowCamel(
  window: {
    usedPercent: number;
    limitWindowSeconds: number;
    resetAfterSeconds: number;
    resetAt: number;
  },
  label: string,
): DisplayWindow {
  return {
    label,
    usedPercent: clampPercent(window.usedPercent),
    remainingPercent: clampPercent(100 - window.usedPercent),
    resetAt: window.resetAt,
    resetAfterSeconds: window.resetAfterSeconds,
    limitWindowSeconds: window.limitWindowSeconds,
  };
}

function pickSelectedWindow(primaryWindow: DisplayWindow, secondaryWindow: DisplayWindow): DisplayWindow {
  return primaryWindow.usedPercent >= secondaryWindow.usedPercent ? primaryWindow : secondaryWindow;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function extractRateLimitBody(message: string): RawUsageBody | undefined {
  const marker = "body=";
  const markerIndex = message.indexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }

  const bodyText = message.slice(markerIndex + marker.length).trim();
  try {
    return JSON.parse(bodyText) as RawUsageBody;
  } catch {
    return undefined;
  }
}

async function ensureRunnableBinary(candidate: string): Promise<string> {
  if (platform() !== "win32") {
    return candidate;
  }

  const probe = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  });

  if (!probe.error) {
    return candidate;
  }

  const spawnError = probe.error as NodeJS.ErrnoException;

  if (!["EPERM", "EACCES"].includes(spawnError.code ?? "")) {
    throw spawnError;
  }

  const cacheDir = join(homedir(), ".codex-limit-tracker", "bin");
  await mkdir(cacheDir, { recursive: true });
  const copiedBinaryPath = join(cacheDir, "codex.exe");
  await copyFile(candidate, copiedBinaryPath);
  return copiedBinaryPath;
}

function pathCommandCandidates(): string[] {
  const command = platform() === "win32" ? "where" : "which";
  const target = platform() === "win32" ? "codex.exe" : "codex";
  const probe = spawnSync(command, [target], {
    encoding: "utf8",
    timeout: 5000,
  });

  if (probe.status !== 0) {
    return [];
  }

  return probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function platformCandidates(): string[] {
  if (platform() === "win32") {
    return [
      join(
        "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.409.1734.0_x64__2p2nqsd0c76g0",
        "app",
        "resources",
        "codex.exe",
      ),
      join(
        homedir(),
        "AppData",
        "Local",
        "Packages",
        "OpenAI.Codex_2p2nqsd0c76g0",
        "LocalCache",
        "Local",
        "Microsoft",
        "WinGet",
        "Links",
        "codex.exe",
      ),
    ];
  }

  if (platform() === "darwin") {
    return [
      "/Applications/Codex.app/Contents/Resources/codex",
      resolve(homedir(), "Applications/Codex.app/Contents/Resources/codex"),
      "/usr/local/bin/codex",
      "/opt/homebrew/bin/codex",
    ];
  }

  return [];
}
