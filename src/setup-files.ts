import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SetupState {
  completedStages: string[];
  convex?: {
    deploymentName?: string;
    projectSlug: string;
    teamSlug: string;
  };
  lastFailure?: {
    message: string;
    stage: string;
  };
  project: {
    displayName: string;
    path: string;
    slug: string;
  };
  providers?: {
    resend?: {
      fromEmail?: string;
      webhookId?: string;
    };
    stripe?: {
      accountId?: string;
      claimed?: boolean;
      claimUrl?: string;
      expiresAt?: string;
      monthlyPriceId?: string;
      portalConfigurationId?: string;
      productId?: string;
      profileName: string;
      source?: "claimable" | "dashboard";
      webhookId?: string;
      yearlyPriceId?: string;
    };
    workos?: {
      webhookId?: string;
    };
  };
  schemaVersion: 1;
  selectionId: string;
  updatedAt: string;
}

const ENV_ASSIGNMENT_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const INLINE_ENV_COMMENT_PATTERN = /\s+#.*$/;
const SAFE_ENV_VALUE_PATTERN = /^[A-Za-z0-9_./:@+-]*$/;
const LINE_BREAK_PATTERN = /\r?\n/;

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const atomicWrite = async (
  path: string,
  contents: string,
  mode: number
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode });
  await chmod(temporaryPath, mode);
  await rename(temporaryPath, path);
};

const decodeEnvValue = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : trimmed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(INLINE_ENV_COMMENT_PATTERN, "").trimEnd();
};

const encodeEnvValue = (value: string): string =>
  SAFE_ENV_VALUE_PATTERN.test(value) ? value : JSON.stringify(value);

export const readEnvFile = async (
  path: string
): Promise<Record<string, string | undefined>> => {
  if (!(await exists(path))) {
    return {};
  }
  const contents = await readFile(path, "utf8");
  const values: Record<string, string | undefined> = {};
  for (const line of contents.split(LINE_BREAK_PATTERN)) {
    const match = ENV_ASSIGNMENT_PATTERN.exec(line);
    if (match?.[1] && match[2] !== undefined) {
      values[match[1]] = decodeEnvValue(match[2]);
    }
  }
  return values;
};

export const upsertEnvFile = async (
  path: string,
  additions: Record<string, string>
): Promise<void> => {
  const currentContents = (await exists(path))
    ? await readFile(path, "utf8")
    : "";
  const pending = new Map(Object.entries(additions));
  const lines = currentContents.split(LINE_BREAK_PATTERN).map((line) => {
    const match = ENV_ASSIGNMENT_PATTERN.exec(line);
    const name = match?.[1];
    if (!(name && pending.has(name))) {
      return line;
    }
    const value = pending.get(name);
    pending.delete(name);
    return `${name}=${encodeEnvValue(value ?? "")}`;
  });
  while (lines.at(-1) === "") {
    lines.pop();
  }
  if (pending.size > 0 && lines.length > 0) {
    lines.push("");
  }
  for (const [name, value] of pending) {
    lines.push(`${name}=${encodeEnvValue(value)}`);
  }
  await atomicWrite(path, `${lines.join("\n")}\n`, 0o600);
};

export const setupStatePath = (destination: string): string =>
  join(destination, ".starter/setup-state.json");

export const readSetupState = async (
  destination: string
): Promise<SetupState | null> => {
  const path = setupStatePath(destination);
  if (!(await exists(path))) {
    return null;
  }
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("schemaVersion" in parsed) ||
    parsed.schemaVersion !== 1
  ) {
    throw new Error(`Unsupported setup state at ${path}.`);
  }
  return parsed as SetupState;
};

export const writeSetupState = async (
  destination: string,
  state: SetupState
): Promise<void> => {
  const updated = { ...state, updatedAt: new Date().toISOString() };
  await atomicWrite(
    setupStatePath(destination),
    `${JSON.stringify(updated, null, 2)}\n`,
    0o600
  );
};

export const withTemporaryEnvFile = async <Value>({
  destination,
  values,
  run,
}: {
  destination: string;
  run: (path: string) => Promise<Value>;
  values: Record<string, string>;
}): Promise<Value> => {
  const path = join(destination, ".starter/.env.provisioning");
  await atomicWrite(
    path,
    `${Object.entries(values)
      .map(([name, value]) => `${name}=${encodeEnvValue(value)}`)
      .join("\n")}\n`,
    0o600
  );
  try {
    return await run(path);
  } finally {
    await unlink(path).catch((error: unknown) => {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    });
  }
};
