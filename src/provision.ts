import { randomBytes } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "bun";
import type {
  ProvisionPromptClient,
  StripeSetupMethod,
} from "./provider-prompts";
import {
  readEnvFile,
  readSetupState,
  type SetupState,
  upsertEnvFile,
  withTemporaryEnvFile,
  writeSetupState,
} from "./setup-files";

const WORKOS_CLI = "workos@0.21.1";
const RESEND_CLI = "resend-cli@2.16.0";
const STRIPE_CLI = "@stripe/cli@1.50.5";
const LOCAL_APP_URL = "http://localhost:3001";
const PLACEHOLDER_WEBHOOK_SECRET = "whsec_create_app_initial_setup";
const WORKOS_ACTION_SECRET_BYTES = 32;
const STRIPE_MISSING_PRODUCT_PATTERN = /resource_missing|no such product/i;
const STRIPE_SECRET_OUTPUT_PATTERN = /Secret key:\s+(\S+)/;
const STRIPE_RUNTIME_KEY_PATTERN = /^(?:rkcs_|rk_test_|sk_test_)/;
const STAGE_LABELS: Record<string, string> = {
  "convex.deployment": "Creating Convex development deployment",
  "convex.environment": "Storing provider environment in Convex",
  "convex.final-push": "Pushing configured Convex functions",
  "convex.initial-push":
    "Provisioning WorkOS and pushing initial Convex functions",
  "convex.project": "Creating Convex project",
  "resend.configured": "Configuring Resend webhook",
  "stripe.portal": "Configuring Stripe customer portal",
  "stripe.prices": "Creating Stripe monthly and yearly prices",
  "stripe.product": "Creating Stripe Pro product",
  "stripe.sandbox": "Connecting Stripe sandbox",
  "stripe.sandbox-access": "Confirming Stripe sandbox ownership",
  "stripe.webhook": "Creating Stripe webhook",
  "workos.webhook": "Creating WorkOS webhook",
};

interface PresetSelection {
  app: boolean;
  auth: boolean;
  database: boolean;
  electron: boolean;
  framework: "next" | "tanstack" | null;
  marketing: boolean;
  payments: boolean;
}

interface WebhookProvisioning {
  events: string[];
  webhookPath: string;
}

interface StripeProvisioning extends WebhookProvisioning {
  apiVersion: string;
  currency: string;
  prices: Array<{
    interval: "month" | "year";
    lookupKey: string;
    unitAmount: number;
  }>;
}

interface GeneratedPreset {
  manifestSchemaVersion: number;
  preset: string;
  project: {
    displayName: string;
    slug: string;
  };
  provisioning?: {
    appUrl: string;
    resend?: WebhookProvisioning;
    stripe?: StripeProvisioning;
    workos?: WebhookProvisioning;
  };
  selection: PresetSelection;
}

export interface CommandOptions {
  command: string[];
  cwd: string;
  env?: Record<string, string>;
  interactive?: boolean;
}

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export type CommandExecutor = (
  options: CommandOptions
) => Promise<CommandResult>;

export interface ProvisionOptions {
  destination: string;
  execute?: CommandExecutor;
  prompts: ProvisionPromptClient;
  report?: (message: string) => void;
}

interface ProviderInputs {
  convexTeam: string;
  resendApiKey?: string;
  resendFromEmail?: string;
  stripeApiKey?: string;
  stripeEmail?: string;
  stripeSetupMethod?: StripeSetupMethod;
}

interface JsonRecord {
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const commandText = (command: string[]): string => command.join(" ");

export const executeCommand: CommandExecutor = async (options) => {
  const subprocess = spawn(options.command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stderr: options.interactive ? "inherit" : "pipe",
    stdin: options.interactive ? "inherit" : undefined,
    stdout: options.interactive ? "inherit" : "pipe",
  });
  if (options.interactive) {
    return {
      exitCode: await subprocess.exited,
      stderr: "",
      stdout: "",
    };
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() };
};

const requireSuccess = (
  result: CommandResult,
  command: string[],
  label?: string
): string => {
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout || "No command output.";
    throw new Error(`${label ?? commandText(command)} failed.\n${detail}`);
  }
  return result.stdout;
};

const run = async (
  execute: CommandExecutor,
  options: CommandOptions,
  label?: string
): Promise<string> =>
  requireSuccess(await execute(options), options.command, label);

const parseJson = (value: string, label: string): JsonRecord => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // The error below includes the provider boundary without echoing secrets.
  }
  throw new Error(`${label} returned an unexpected response.`);
};

const parseLeadingJson = (value: string, label: string): JsonRecord => {
  const start = value.indexOf("{");
  if (start === -1) {
    throw new Error(`${label} returned an unexpected response.`);
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return parseJson(value.slice(start, index + 1), label);
      }
    }
  }
  throw new Error(`${label} returned incomplete JSON.`);
};

const findString = (
  value: unknown,
  names: Set<string>,
  prefix?: string
): string | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, names, prefix);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const [name, child] of Object.entries(value)) {
    if (
      names.has(name) &&
      typeof child === "string" &&
      (!prefix || child.startsWith(prefix))
    ) {
      return child;
    }
  }
  for (const child of Object.values(value)) {
    const found = findString(child, names, prefix);
    if (found) {
      return found;
    }
  }
  return undefined;
};

const bunx = (packageName: string, ...args: string[]): string[] => [
  process.execPath,
  "x",
  "--bun",
  packageName,
  ...args,
];

export const convexCommand = (...args: string[]): string[] => [
  process.execPath,
  "x",
  "--bun",
  "--no-install",
  "convex",
  ...args,
];

const readPreset = async (destination: string): Promise<GeneratedPreset> => {
  const path = join(destination, ".starter/preset.json");
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !(isRecord(parsed) && isRecord(parsed.project)) ||
    typeof parsed.project.displayName !== "string" ||
    typeof parsed.project.slug !== "string" ||
    !isRecord(parsed.selection)
  ) {
    throw new Error(`Invalid generated preset: ${path}`);
  }
  return parsed as unknown as GeneratedPreset;
};

const selectionName = (selection: PresetSelection): string => {
  if (!selection.app) {
    return "marketing-only";
  }
  let capability = "plain";
  if (selection.payments) {
    capability = "stripe";
  } else if (selection.auth) {
    capability = "auth";
  } else if (selection.database) {
    capability = "convex";
  }
  const parts = [selection.framework, capability];
  if (selection.marketing) {
    parts.push("marketing");
  }
  if (selection.electron) {
    parts.push("electron");
  }
  return parts.join("-");
};

const initialState = (
  destination: string,
  preset: GeneratedPreset
): SetupState => ({
  completedStages: [],
  project: {
    displayName: preset.project.displayName,
    path: destination,
    slug: preset.project.slug,
  },
  schemaVersion: 1,
  selectionId: selectionName(preset.selection),
  updatedAt: new Date().toISOString(),
});

const hasStage = (state: SetupState, stage: string): boolean =>
  state.completedStages.includes(stage);

const completeStage = async (
  destination: string,
  state: SetupState,
  stage: string
): Promise<void> => {
  if (!hasStage(state, stage)) {
    state.completedStages.push(stage);
  }
  Reflect.deleteProperty(state, "lastFailure");
  await writeSetupState(destination, state);
};

const markFailure = async (
  destination: string,
  state: SetupState,
  stage: string,
  error: unknown
): Promise<void> => {
  state.lastFailure = {
    message: error instanceof Error ? error.message : "Unknown setup failure.",
    stage,
  };
  await writeSetupState(destination, state);
};

const oneTeamSlug = (status: string): string | undefined => {
  const matches = [...status.matchAll(/^\s*- .* \(([^)]+)\)$/gm)];
  return matches.length === 1 ? matches[0]?.[1] : undefined;
};

const gitEmail = async (
  destination: string,
  execute: CommandExecutor
): Promise<string | undefined> => {
  const result = await execute({
    command: ["git", "config", "user.email"],
    cwd: destination,
  });
  return result.exitCode === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : undefined;
};

const collectInputs = async ({
  destination,
  execute,
  preset,
  prompts,
  state,
}: {
  destination: string;
  execute: CommandExecutor;
  preset: GeneratedPreset;
  prompts: ProvisionPromptClient;
  state: SetupState;
}): Promise<ProviderInputs> => {
  const convexStatusCommand = convexCommand("login", "status");
  let convexStatusResult = await execute({
    command: convexStatusCommand,
    cwd: destination,
  });
  if (convexStatusResult.exitCode !== 0) {
    const loginCommand = convexCommand("login");
    await run(
      execute,
      { command: loginCommand, cwd: destination, interactive: true },
      "Convex login"
    );
    convexStatusResult = await execute({
      command: convexStatusCommand,
      cwd: destination,
    });
  }
  const convexStatus = requireSuccess(
    convexStatusResult,
    convexStatusCommand,
    "Convex login check"
  );
  const convexTeam =
    state.convex?.teamSlug ??
    process.env.CONVEX_TEAM ??
    oneTeamSlug(convexStatus) ??
    (await prompts.convexTeam());

  let resendApiKey: string | undefined;
  let resendFromEmail: string | undefined;
  if (preset.selection.auth && !hasStage(state, "resend.configured")) {
    await run(
      execute,
      { command: bunx(RESEND_CLI, "--version"), cwd: destination },
      "Resend CLI preflight"
    );
    resendApiKey =
      process.env.CREATE_APP_RESEND_API_KEY ??
      process.env.RESEND_API_KEY ??
      (await prompts.resendApiKey());
    resendFromEmail =
      state.providers?.resend?.fromEmail ??
      process.env.RESEND_FROM_EMAIL ??
      (await prompts.resendFromEmail());
    const listCommand = bunx(
      RESEND_CLI,
      "api-keys",
      "list",
      "--limit",
      "1",
      "--quiet"
    );
    await run(
      execute,
      {
        command: listCommand,
        cwd: destination,
        env: { RESEND_API_KEY: resendApiKey },
      },
      "Resend credential check"
    );
  }
  if (preset.selection.auth && !hasStage(state, "workos.webhook")) {
    await run(
      execute,
      { command: bunx(WORKOS_CLI, "--version"), cwd: destination },
      "WorkOS CLI preflight"
    );
  }

  let stripeApiKey: string | undefined;
  let stripeEmail: string | undefined;
  let stripeSetupMethod: StripeSetupMethod | undefined;
  if (preset.selection.payments && !hasStage(state, "stripe.sandbox")) {
    await run(
      execute,
      { command: bunx(STRIPE_CLI, "--version"), cwd: destination },
      "Stripe CLI preflight"
    );
    stripeSetupMethod = await prompts.stripeSetupMethod();
    if (stripeSetupMethod === "dashboard") {
      stripeApiKey = await prompts.stripeApiKey();
    } else {
      const suggestedEmail = await gitEmail(destination, execute);
      stripeEmail = suggestedEmail ?? (await prompts.stripeEmail());
    }
  }

  return {
    convexTeam,
    ...(resendApiKey ? { resendApiKey } : {}),
    ...(resendFromEmail ? { resendFromEmail } : {}),
    ...(stripeApiKey ? { stripeApiKey } : {}),
    ...(stripeEmail ? { stripeEmail } : {}),
    ...(stripeSetupMethod ? { stripeSetupMethod } : {}),
  };
};

const provisioningSummary = (preset: GeneratedPreset): string => {
  const resources = ["Convex project and cloud dev deployment"];
  if (preset.selection.auth) {
    resources.push("WorkOS development environment and webhook");
    resources.push("Resend webhook");
  }
  if (preset.selection.payments) {
    resources.push("Stripe sandbox catalog, portal, and webhook");
  }
  return resources.map((resource) => `• ${resource}`).join("\n");
};

const runStage = async ({
  destination,
  name,
  report,
  runStageAction,
  state,
  validateCompleted,
}: {
  destination: string;
  name: string;
  report: (message: string) => void;
  runStageAction: () => Promise<void>;
  state: SetupState;
  validateCompleted?: () => Promise<boolean>;
}): Promise<void> => {
  if (hasStage(state, name) && !validateCompleted) {
    return;
  }
  try {
    if (hasStage(state, name) && (await validateCompleted?.())) {
      return;
    }
    report(STAGE_LABELS[name] ?? name);
    await runStageAction();
    await completeStage(destination, state, name);
  } catch (error) {
    await markFailure(destination, state, name, error);
    throw error;
  }
};

const setConvexEnvironment = async ({
  destination,
  execute,
  values,
}: {
  destination: string;
  execute: CommandExecutor;
  values: Record<string, string>;
}): Promise<void> => {
  await withTemporaryEnvFile({
    destination,
    run: async (path) => {
      const command = convexCommand(
        "env",
        "set",
        "--from-file",
        path,
        "--force"
      );
      await run(execute, { command, cwd: destination }, "Convex env update");
    },
    values,
  });
};

const requireEnvValue = (
  values: Record<string, string | undefined>,
  name: string,
  file: string
): string => {
  const value = values[name];
  if (!value) {
    throw new Error(`${name} was not written to ${file}.`);
  }
  return value;
};

const syncConvexLocalEnvironment = async ({
  destination,
  preset,
}: {
  destination: string;
  preset: GeneratedPreset;
}): Promise<Record<string, string | undefined>> => {
  const rootPath = join(destination, ".env.local");
  const rootEnv = await readEnvFile(rootPath);
  await chmod(rootPath, 0o600);
  const convexUrl = requireEnvValue(rootEnv, "CONVEX_URL", rootPath);
  const deployment = requireEnvValue(rootEnv, "CONVEX_DEPLOYMENT", rootPath);
  const siteUrl = requireEnvValue(rootEnv, "CONVEX_SITE_URL", rootPath);
  const backendValues: Record<string, string> = {
    APP_URL: preset.provisioning?.appUrl ?? LOCAL_APP_URL,
    CONVEX_DEPLOYMENT: deployment,
    CONVEX_SITE_URL: siteUrl,
    CONVEX_URL: convexUrl,
  };
  const appValues: Record<string, string> = {};
  if (preset.selection.framework === "next") {
    appValues.NEXT_PUBLIC_CONVEX_URL = convexUrl;
  } else if (preset.selection.framework === "tanstack") {
    appValues.VITE_CONVEX_URL = convexUrl;
  }

  if (preset.selection.auth) {
    const clientId = requireEnvValue(rootEnv, "WORKOS_CLIENT_ID", rootPath);
    const apiKey = requireEnvValue(rootEnv, "WORKOS_API_KEY", rootPath);
    const currentAppEnv = await readEnvFile(
      join(destination, "apps/app/.env.local")
    );
    const cookiePassword =
      currentAppEnv.WORKOS_COOKIE_PASSWORD ??
      randomBytes(32).toString("base64url");
    Object.assign(backendValues, {
      WORKOS_API_KEY: apiKey,
      WORKOS_CLIENT_ID: clientId,
    });
    Object.assign(appValues, {
      WORKOS_API_KEY: apiKey,
      WORKOS_CLIENT_ID: clientId,
      WORKOS_COOKIE_PASSWORD: cookiePassword,
      ...(preset.selection.framework === "next"
        ? {
            NEXT_PUBLIC_WORKOS_REDIRECT_URI: `${preset.provisioning?.appUrl ?? LOCAL_APP_URL}/callback`,
          }
        : {
            WORKOS_REDIRECT_URI: `${preset.provisioning?.appUrl ?? LOCAL_APP_URL}/callback`,
          }),
    });
  }

  await upsertEnvFile(
    join(destination, "packages/backend/.env.local"),
    backendValues
  );
  await upsertEnvFile(join(destination, "apps/app/.env.local"), appValues);
  return rootEnv;
};

const parseWebhookResponse = (
  output: string,
  provider: "Resend" | "WorkOS"
): { id?: string; secret: string } => {
  const parsed = parseJson(output, `${provider} webhook creation`);
  const secret = findString(
    parsed,
    new Set(["secret", "signing_secret", "signingSecret"]),
    provider === "Resend" ? "whsec_" : undefined
  );
  if (!secret) {
    throw new Error(`${provider} did not return its webhook signing secret.`);
  }
  const id = findString(parsed, new Set(["id", "webhook_id", "webhookId"]));
  return {
    ...(id ? { id } : {}),
    secret,
  };
};

const listData = (response: JsonRecord): JsonRecord[] => {
  const { data } = response;
  return Array.isArray(data) ? data.filter(isRecord) : [];
};

const createWorkosWebhook = async ({
  destination,
  execute,
  preset,
  rootEnv,
  state,
}: {
  destination: string;
  execute: CommandExecutor;
  preset: GeneratedPreset;
  rootEnv: Record<string, string | undefined>;
  state: SetupState;
}): Promise<void> => {
  const config = preset.provisioning?.workos;
  if (!config) {
    throw new Error(
      "The generated preset is missing WorkOS provisioning data."
    );
  }
  const apiKey = requireEnvValue(
    rootEnv,
    "WORKOS_API_KEY",
    join(destination, ".env.local")
  );
  const siteUrl = requireEnvValue(
    rootEnv,
    "CONVEX_SITE_URL",
    join(destination, ".env.local")
  );
  const url = `${siteUrl}${config.webhookPath}`;
  const environment = { WORKOS_API_KEY: apiKey, WORKOS_MODE: "agent" };
  const lookupCommand = bunx(WORKOS_CLI, "webhook", "list", "--json");
  const lookupResponse = parseJson(
    await run(
      execute,
      {
        command: lookupCommand,
        cwd: destination,
        env: environment,
      },
      "WorkOS webhook lookup"
    ),
    "WorkOS webhook lookup"
  );
  const matchingWebhooks = listData(lookupResponse).filter(
    (endpoint) => endpoint.endpoint_url === url
  );
  if (matchingWebhooks.length > 1) {
    throw new Error(
      `Multiple WorkOS webhooks already exist for ${url}. Remove the duplicates, then resume setup.`
    );
  }
  const [existingWebhook] = matchingWebhooks;
  const webhook = existingWebhook
    ? parseWebhookResponse(JSON.stringify(existingWebhook), "WorkOS")
    : parseWebhookResponse(
        await run(
          execute,
          {
            command: bunx(
              WORKOS_CLI,
              "webhook",
              "create",
              `--url=${url}`,
              `--events=${config.events.join(",")}`,
              "--json"
            ),
            cwd: destination,
            env: environment,
          },
          "WorkOS webhook creation"
        ),
        "WorkOS"
      );
  await upsertEnvFile(join(destination, "packages/backend/.env.local"), {
    WORKOS_WEBHOOK_SECRET: webhook.secret,
  });
  state.providers = state.providers ?? {};
  state.providers.workos = { ...(webhook.id ? { webhookId: webhook.id } : {}) };
};

const createResendResources = async ({
  destination,
  execute,
  inputs,
  preset,
  state,
}: {
  destination: string;
  execute: CommandExecutor;
  inputs: ProviderInputs;
  preset: GeneratedPreset;
  state: SetupState;
}): Promise<void> => {
  const apiKey = inputs.resendApiKey;
  const fromEmail = inputs.resendFromEmail;
  const config = preset.provisioning?.resend;
  if (!(apiKey && fromEmail && config)) {
    throw new Error("Resend provisioning inputs are incomplete.");
  }
  const backendEnvPath = join(destination, "packages/backend/.env.local");
  state.providers = state.providers ?? {};
  await upsertEnvFile(backendEnvPath, {
    RESEND_API_KEY: apiKey,
    RESEND_FROM_EMAIL: fromEmail,
  });
  state.providers.resend = {
    ...state.providers.resend,
    fromEmail,
  };

  const backendEnv = await readEnvFile(backendEnvPath);
  const siteUrl = requireEnvValue(
    backendEnv,
    "CONVEX_SITE_URL",
    backendEnvPath
  );
  if (backendEnv.RESEND_WEBHOOK_SECRET) {
    return;
  }
  const webhookCommand = bunx(
    RESEND_CLI,
    "webhooks",
    "create",
    "--endpoint",
    `${siteUrl}${config.webhookPath}`,
    "--events",
    ...config.events,
    "--quiet"
  );
  const webhook = parseWebhookResponse(
    await run(
      execute,
      {
        command: webhookCommand,
        cwd: destination,
        env: { RESEND_API_KEY: apiKey },
      },
      "Resend webhook creation"
    ),
    "Resend"
  );
  await upsertEnvFile(backendEnvPath, {
    RESEND_WEBHOOK_SECRET: webhook.secret,
  });
  state.providers.resend = {
    ...state.providers.resend,
    ...(webhook.id ? { webhookId: webhook.id } : {}),
  };
};

const stripe = (profile: string | undefined, ...args: string[]): string[] =>
  bunx(STRIPE_CLI, ...args, ...(profile ? ["--project-name", profile] : []));

const stripeCommandOptions = async (
  destination: string,
  profile: string,
  args: string[]
): Promise<CommandOptions> => {
  const backendEnv = await readEnvFile(
    join(destination, "packages/backend/.env.local")
  );
  const apiKey = backendEnv.STRIPE_SECRET_KEY;
  if (apiKey && STRIPE_RUNTIME_KEY_PATTERN.test(apiKey)) {
    return {
      command: stripe(undefined, ...args),
      cwd: destination,
      env: { STRIPE_API_KEY: apiKey },
    };
  }
  return { command: stripe(profile, ...args), cwd: destination };
};

interface StripeApiError {
  code?: string;
  message: string;
}

const stripeApiError = (response: JsonRecord): StripeApiError | undefined => {
  const { error } = response;
  if (!isRecord(error)) {
    return undefined;
  }
  return {
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    message:
      typeof error.message === "string"
        ? error.message
        : "Stripe returned an API error.",
  };
};

const throwStripeApiError = (label: string, error: StripeApiError): never => {
  throw new Error(
    `${label} failed.\n${error.code ? `${error.code}: ` : ""}${error.message}`
  );
};

const stripeJson = async (
  destination: string,
  execute: CommandExecutor,
  profile: string,
  args: string[],
  label: string
): Promise<JsonRecord> => {
  const options = await stripeCommandOptions(destination, profile, args);
  const response = parseJson(await run(execute, options, label), label);
  const error = stripeApiError(response);
  if (error) {
    throwStripeApiError(label, error);
  }
  return response;
};

const setupStripeSandbox = async ({
  destination,
  execute,
  inputs,
  preset,
  state,
}: {
  destination: string;
  execute: CommandExecutor;
  inputs: ProviderInputs;
  preset: GeneratedPreset;
  state: SetupState;
}): Promise<void> => {
  const profileName = `create-app-${preset.project.slug}`;
  const method = inputs.stripeSetupMethod;
  if (method === "dashboard") {
    const secretKey = inputs.stripeApiKey;
    if (!(secretKey && STRIPE_RUNTIME_KEY_PATTERN.test(secretKey))) {
      throw new Error("A Stripe sandbox test API key is required.");
    }
    await upsertEnvFile(join(destination, "packages/backend/.env.local"), {
      STRIPE_SECRET_KEY: secretKey,
    });
    const account = await stripeJson(
      destination,
      execute,
      profileName,
      ["accounts", "retrieve"],
      "Stripe sandbox credential check"
    );
    const accountId = findString(account, new Set(["id"]), "acct_");
    state.providers = state.providers ?? {};
    state.providers.stripe = {
      ...(accountId ? { accountId } : {}),
      profileName,
      source: "dashboard",
    };
    return;
  }
  if (method !== "claimable") {
    throw new Error("Stripe sandbox setup method is missing.");
  }
  const email = inputs.stripeEmail;
  if (!email) {
    throw new Error("Stripe sandbox email is missing.");
  }
  const createCommand = stripe(
    profileName,
    "sandbox",
    "create",
    "--email",
    email,
    "--non-interactive"
  );
  const output = await run(
    execute,
    { command: createCommand, cwd: destination },
    "Stripe sandbox creation"
  );
  let response: JsonRecord = {};
  if (output.includes("{")) {
    response = parseLeadingJson(output, "Stripe sandbox creation");
  }
  const plainSecret = STRIPE_SECRET_OUTPUT_PATTERN.exec(output)?.[1];
  const secretKey =
    findString(response, new Set(["secret_key"])) ?? plainSecret;
  if (!(secretKey && STRIPE_RUNTIME_KEY_PATTERN.test(secretKey))) {
    throw new Error(
      "Stripe created or selected a sandbox but did not return its development key. Run the printed Stripe login step, then resume setup."
    );
  }
  await upsertEnvFile(join(destination, "packages/backend/.env.local"), {
    STRIPE_SECRET_KEY: secretKey,
  });
  state.providers = state.providers ?? {};
  const accountId = findString(response, new Set(["account_id"]));
  const claimUrl = findString(response, new Set(["claim_url"]));
  const expiresAt = findString(response, new Set(["expires_at"]));
  state.providers.stripe = {
    ...(accountId ? { accountId } : {}),
    claimed: false,
    ...(claimUrl ? { claimUrl } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    profileName,
    source: "claimable",
  };
};

const resetStripeResourceStages = (state: SetupState): void => {
  const resourceStages = new Set([
    "stripe.portal",
    "stripe.prices",
    "stripe.product",
    "stripe.webhook",
  ]);
  state.completedStages = state.completedStages.filter(
    (stage) => !resourceStages.has(stage)
  );
};

const confirmStripeSandboxAccess = async ({
  destination,
  execute,
  prompts,
  state,
}: {
  destination: string;
  execute: CommandExecutor;
  prompts: ProvisionPromptClient;
  state: SetupState;
}): Promise<void> => {
  const stripeState = state.providers?.stripe;
  if (!stripeState) {
    throw new Error("Stripe sandbox state is missing.");
  }
  if (stripeState.source === "dashboard" || stripeState.claimed) {
    return;
  }
  if (!stripeState.claimUrl) {
    stripeState.source = "dashboard";
    return;
  }
  const choice = await prompts.stripeClaimChoice(
    stripeState.claimUrl,
    stripeState.expiresAt
  );
  if (choice === "claimed") {
    stripeState.claimed = true;
    stripeState.source = "claimable";
    return;
  }

  const secretKey = await prompts.stripeApiKey();
  if (!STRIPE_RUNTIME_KEY_PATTERN.test(secretKey)) {
    throw new Error("A Stripe sandbox test API key is required.");
  }
  const backendEnvPath = join(destination, "packages/backend/.env.local");
  await upsertEnvFile(backendEnvPath, {
    STRIPE_PORTAL_CONFIGURATION_ID: "",
    STRIPE_SECRET_KEY: secretKey,
    STRIPE_WEBHOOK_SECRET: "",
  });
  const account = await stripeJson(
    destination,
    execute,
    stripeState.profileName,
    ["accounts", "retrieve"],
    "Stripe sandbox credential check"
  );
  const accountId = findString(account, new Set(["id"]), "acct_");
  if (accountId) {
    stripeState.accountId = accountId;
  } else {
    Reflect.deleteProperty(stripeState, "accountId");
  }
  stripeState.source = "dashboard";
  Reflect.deleteProperty(stripeState, "claimed");
  Reflect.deleteProperty(stripeState, "claimUrl");
  Reflect.deleteProperty(stripeState, "expiresAt");
  Reflect.deleteProperty(stripeState, "monthlyPriceId");
  Reflect.deleteProperty(stripeState, "portalConfigurationId");
  Reflect.deleteProperty(stripeState, "productId");
  Reflect.deleteProperty(stripeState, "webhookId");
  Reflect.deleteProperty(stripeState, "yearlyPriceId");
  resetStripeResourceStages(state);
};

const stripeProductId = (slug: string): string =>
  `prod_${slug.replaceAll("-", "_").slice(0, 80)}_pro`;

const stripeProductExists = async ({
  destination,
  execute,
  productId,
  profileName,
}: {
  destination: string;
  execute: CommandExecutor;
  productId: string;
  profileName: string;
}): Promise<boolean> => {
  const options = await stripeCommandOptions(destination, profileName, [
    "products",
    "retrieve",
    productId,
  ]);
  const result = await execute(options);
  if (result.exitCode !== 0) {
    if (
      STRIPE_MISSING_PRODUCT_PATTERN.test(`${result.stderr}\n${result.stdout}`)
    ) {
      return false;
    }
    requireSuccess(result, options.command, "Stripe product lookup");
  }
  const response = parseJson(result.stdout, "Stripe product lookup");
  const error = stripeApiError(response);
  if (error) {
    if (
      error.code === "resource_missing" ||
      STRIPE_MISSING_PRODUCT_PATTERN.test(error.message)
    ) {
      return false;
    }
    throwStripeApiError("Stripe product lookup", error);
  }
  const existingId = findString(response, new Set(["id"]), "prod_");
  if (existingId !== productId) {
    throw new Error("Stripe product lookup returned an unexpected product.");
  }
  return true;
};

const ensureStripeProduct = async ({
  destination,
  execute,
  preset,
  state,
}: {
  destination: string;
  execute: CommandExecutor;
  preset: GeneratedPreset;
  state: SetupState;
}): Promise<void> => {
  const stripeState = state.providers?.stripe;
  if (!stripeState) {
    throw new Error("Stripe sandbox state is missing.");
  }
  const productId = stripeProductId(preset.project.slug);
  if (
    !(await stripeProductExists({
      destination,
      execute,
      productId,
      profileName: stripeState.profileName,
    }))
  ) {
    const created = await stripeJson(
      destination,
      execute,
      stripeState.profileName,
      [
        "products",
        "create",
        `--id=${productId}`,
        `--name=${preset.project.displayName} Pro`,
        "--confirm",
      ],
      "Stripe product creation"
    );
    if (findString(created, new Set(["id"]), "prod_") !== productId) {
      throw new Error("Stripe did not return the expected product ID.");
    }
  }
  stripeState.productId = productId;
};

const requireNumber = (value: unknown, label: string): number => {
  if (typeof value !== "number") {
    throw new Error(`${label} was missing from the Stripe response.`);
  }
  return value;
};

const ensureStripePrice = async ({
  destination,
  execute,
  price,
  preset,
  state,
}: {
  destination: string;
  execute: CommandExecutor;
  price: StripeProvisioning["prices"][number];
  preset: GeneratedPreset;
  state: SetupState;
}): Promise<string> => {
  const stripeState = state.providers?.stripe;
  const config = preset.provisioning?.stripe;
  if (!(stripeState?.productId && config)) {
    throw new Error("Stripe product state is missing.");
  }
  const listed = listData(
    await stripeJson(
      destination,
      execute,
      stripeState.profileName,
      ["prices", "list", `--lookup-keys=${price.lookupKey}`, "--limit=10"],
      `Stripe ${price.interval} price lookup`
    )
  );
  const [existing] = listed;
  if (existing) {
    const recurring = isRecord(existing.recurring) ? existing.recurring : {};
    const valid =
      existing.product === stripeState.productId &&
      existing.currency === config.currency &&
      requireNumber(existing.unit_amount, "Stripe unit amount") ===
        price.unitAmount &&
      recurring.interval === price.interval;
    if (!valid) {
      throw new Error(
        `Stripe lookup key ${price.lookupKey} already exists with different pricing.`
      );
    }
    const { id } = existing;
    if (typeof id === "string") {
      return id;
    }
  }
  const created = await stripeJson(
    destination,
    execute,
    stripeState.profileName,
    [
      "prices",
      "create",
      `--currency=${config.currency}`,
      `--unit-amount=${price.unitAmount}`,
      `--product=${stripeState.productId}`,
      `--recurring.interval=${price.interval}`,
      `--lookup-key=${price.lookupKey}`,
      "--confirm",
      `--idempotency=create-app-${preset.project.slug}-${price.lookupKey}`,
    ],
    `Stripe ${price.interval} price creation`
  );
  const id = findString(created, new Set(["id"]), "price_");
  if (!id) {
    throw new Error(`Stripe did not return the ${price.interval} price ID.`);
  }
  return id;
};

const configureStripePortal = async ({
  destination,
  execute,
  preset,
  state,
}: {
  destination: string;
  execute: CommandExecutor;
  preset: GeneratedPreset;
  state: SetupState;
}): Promise<void> => {
  const stripeState = state.providers?.stripe;
  if (!stripeState) {
    throw new Error("Stripe sandbox state is missing.");
  }
  const configurations = listData(
    await stripeJson(
      destination,
      execute,
      stripeState.profileName,
      [
        "billing_portal",
        "configurations",
        "list",
        "--is-default=true",
        "--limit=1",
      ],
      "Stripe portal lookup"
    )
  );
  const existingConfigurationId = configurations[0]?.id;
  const settings = [
    `--default-return-url=${preset.provisioning?.appUrl ?? LOCAL_APP_URL}/account/billing`,
    "--features.customer-update.enabled=true",
    "--features.customer-update.allowed-updates=name",
    "--features.customer-update.allowed-updates=address",
    "--features.invoice-history.enabled=true",
    "--features.payment-method-update.enabled=true",
    "--features.subscription-cancel.enabled=true",
    "--features.subscription-cancel.mode=at_period_end",
    "--confirm",
  ];
  const configuration = await stripeJson(
    destination,
    execute,
    stripeState.profileName,
    typeof existingConfigurationId === "string"
      ? [
          "billing_portal",
          "configurations",
          "update",
          existingConfigurationId,
          ...settings,
        ]
      : ["billing_portal", "configurations", "create", ...settings],
    "Stripe portal configuration"
  );
  const configurationId =
    typeof existingConfigurationId === "string"
      ? existingConfigurationId
      : configuration.id;
  if (typeof configurationId !== "string") {
    throw new Error("Stripe did not return its portal configuration ID.");
  }
  await upsertEnvFile(join(destination, "packages/backend/.env.local"), {
    STRIPE_PORTAL_CONFIGURATION_ID: configurationId,
  });
  stripeState.portalConfigurationId = configurationId;
};

const createStripeWebhook = async ({
  destination,
  execute,
  preset,
  state,
}: {
  destination: string;
  execute: CommandExecutor;
  preset: GeneratedPreset;
  state: SetupState;
}): Promise<void> => {
  const stripeState = state.providers?.stripe;
  const config = preset.provisioning?.stripe;
  if (!(stripeState && config)) {
    throw new Error("Stripe webhook configuration is missing.");
  }
  const backendEnvPath = join(destination, "packages/backend/.env.local");
  const backendEnv = await readEnvFile(backendEnvPath);
  const siteUrl = requireEnvValue(
    backendEnv,
    "CONVEX_SITE_URL",
    backendEnvPath
  );
  const url = `${siteUrl}${config.webhookPath}`;
  const existing = listData(
    await stripeJson(
      destination,
      execute,
      stripeState.profileName,
      ["webhook_endpoints", "list", "--limit=100"],
      "Stripe webhook lookup"
    )
  ).find((endpoint) => endpoint.url === url);
  if (existing) {
    throw new Error(
      `A Stripe webhook already exists for ${url}, but its signing secret is not recoverable. Remove that endpoint, then resume setup.`
    );
  }
  const created = await stripeJson(
    destination,
    execute,
    stripeState.profileName,
    [
      "webhook_endpoints",
      "create",
      `--url=${url}`,
      `--api-version=${config.apiVersion}`,
      ...config.events.map((event) => `--enabled-events=${event}`),
      "--confirm",
      `--idempotency=create-app-${preset.project.slug}-webhook`,
    ],
    "Stripe webhook creation"
  );
  const secret = findString(created, new Set(["secret"]), "whsec_");
  const webhookId = findString(created, new Set(["id"]), "we_");
  if (!(secret && webhookId)) {
    throw new Error("Stripe did not return its webhook ID and signing secret.");
  }
  await upsertEnvFile(backendEnvPath, { STRIPE_WEBHOOK_SECRET: secret });
  stripeState.webhookId = webhookId;
};

const pushConvex = async (
  destination: string,
  execute: CommandExecutor,
  interactive: boolean
): Promise<void> => {
  const command = convexCommand(
    "dev",
    "--once",
    "--typecheck",
    "enable",
    "--tail-logs",
    "disable"
  );
  await run(
    execute,
    { command, cwd: destination, interactive },
    "Convex development push"
  );
};

const configureConvex = async ({
  destination,
  execute,
  inputs,
  preset,
  report,
  state,
}: {
  destination: string;
  execute: CommandExecutor;
  inputs: ProviderInputs;
  preset: GeneratedPreset;
  report: (message: string) => void;
  state: SetupState;
}): Promise<Record<string, string | undefined>> => {
  await runStage({
    destination,
    name: "convex.project",
    report,
    runStageAction: async () => {
      const command = convexCommand(
        "project",
        "create",
        preset.project.slug,
        "--team",
        inputs.convexTeam
      );
      await run(
        execute,
        { command, cwd: destination },
        "Convex project creation"
      );
      state.convex = {
        projectSlug: preset.project.slug,
        teamSlug: inputs.convexTeam,
      };
    },
    state,
  });

  const team = state.convex?.teamSlug ?? inputs.convexTeam;
  const project = state.convex?.projectSlug ?? preset.project.slug;
  await runStage({
    destination,
    name: "convex.deployment",
    report,
    runStageAction: async () => {
      const command = convexCommand(
        "deployment",
        "create",
        `${team}:${project}:dev/create-app`,
        "--type",
        "dev",
        "--select"
      );
      await run(
        execute,
        { command, cwd: destination },
        "Convex dev deployment creation"
      );
      const rootEnv = await readEnvFile(join(destination, ".env.local"));
      const deploymentName = rootEnv.CONVEX_DEPLOYMENT;
      state.convex = {
        ...(deploymentName ? { deploymentName } : {}),
        projectSlug: project,
        teamSlug: team,
      };
    },
    state,
  });

  if (preset.selection.auth && !hasStage(state, "convex.initial-push")) {
    const backendEnvPath = join(destination, "packages/backend/.env.local");
    const backendEnv = await readEnvFile(backendEnvPath);
    const actionSecret =
      backendEnv.WORKOS_ACTION_SECRET ??
      randomBytes(WORKOS_ACTION_SECRET_BYTES).toString("base64url");
    await upsertEnvFile(backendEnvPath, {
      WORKOS_ACTION_SECRET: actionSecret,
    });
    await setConvexEnvironment({
      destination,
      execute,
      values: {
        WORKOS_ACTION_SECRET: actionSecret,
        WORKOS_WEBHOOK_SECRET: PLACEHOLDER_WEBHOOK_SECRET,
      },
    });
  }
  await runStage({
    destination,
    name: "convex.initial-push",
    report,
    runStageAction: async () => {
      await pushConvex(destination, execute, preset.selection.auth);
    },
    state,
  });
  return await syncConvexLocalEnvironment({ destination, preset });
};

const configureStripe = async ({
  destination,
  execute,
  inputs,
  preset,
  prompts,
  report,
  state,
}: {
  destination: string;
  execute: CommandExecutor;
  inputs: ProviderInputs;
  preset: GeneratedPreset;
  prompts: ProvisionPromptClient;
  report: (message: string) => void;
  state: SetupState;
}): Promise<void> => {
  await runStage({
    destination,
    name: "stripe.sandbox",
    report,
    runStageAction: async () => {
      await setupStripeSandbox({ destination, execute, inputs, preset, state });
    },
    state,
  });
  await runStage({
    destination,
    name: "stripe.sandbox-access",
    report,
    runStageAction: async () => {
      await confirmStripeSandboxAccess({
        destination,
        execute,
        prompts,
        state,
      });
    },
    state,
  });
  await runStage({
    destination,
    name: "stripe.product",
    report,
    runStageAction: async () => {
      await ensureStripeProduct({ destination, execute, preset, state });
    },
    state,
    validateCompleted: async () => {
      const stripeState = state.providers?.stripe;
      if (!stripeState) {
        return false;
      }
      return await stripeProductExists({
        destination,
        execute,
        productId: stripeProductId(preset.project.slug),
        profileName: stripeState.profileName,
      });
    },
  });
  await runStage({
    destination,
    name: "stripe.prices",
    report,
    runStageAction: async () => {
      const config = preset.provisioning?.stripe;
      if (!config) {
        throw new Error("The generated preset is missing Stripe pricing data.");
      }
      const monthly = config.prices.find((price) => price.interval === "month");
      const yearly = config.prices.find((price) => price.interval === "year");
      if (!(monthly && yearly)) {
        throw new Error(
          "The generated preset must declare monthly and yearly prices."
        );
      }
      const monthlyPriceId = await ensureStripePrice({
        destination,
        execute,
        preset,
        price: monthly,
        state,
      });
      const yearlyPriceId = await ensureStripePrice({
        destination,
        execute,
        preset,
        price: yearly,
        state,
      });
      const stripeState = state.providers?.stripe;
      if (!stripeState) {
        throw new Error("Stripe sandbox state is missing.");
      }
      stripeState.monthlyPriceId = monthlyPriceId;
      stripeState.yearlyPriceId = yearlyPriceId;
    },
    state,
  });
  await runStage({
    destination,
    name: "stripe.portal",
    report,
    runStageAction: async () => {
      await configureStripePortal({ destination, execute, preset, state });
    },
    state,
  });
  await runStage({
    destination,
    name: "stripe.webhook",
    report,
    runStageAction: async () => {
      const backendEnv = await readEnvFile(
        join(destination, "packages/backend/.env.local")
      );
      if (backendEnv.STRIPE_WEBHOOK_SECRET) {
        return;
      }
      await createStripeWebhook({ destination, execute, preset, state });
    },
    state,
  });
};

const finalEnvironment = async (
  destination: string,
  preset: GeneratedPreset
): Promise<Record<string, string>> => {
  const backend = await readEnvFile(
    join(destination, "packages/backend/.env.local")
  );
  const names = [
    ...(preset.selection.auth
      ? [
          "WORKOS_API_KEY",
          "WORKOS_ACTION_SECRET",
          "WORKOS_CLIENT_ID",
          "WORKOS_WEBHOOK_SECRET",
          "RESEND_API_KEY",
          "RESEND_WEBHOOK_SECRET",
          "RESEND_FROM_EMAIL",
          "APP_URL",
        ]
      : []),
    ...(preset.selection.payments
      ? [
          "STRIPE_SECRET_KEY",
          "STRIPE_WEBHOOK_SECRET",
          "STRIPE_PORTAL_CONFIGURATION_ID",
        ]
      : []),
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      requireEnvValue(
        backend,
        name,
        join(destination, "packages/backend/.env.local")
      ),
    ])
  );
};

export const provisionProject = async ({
  destination: destinationInput,
  execute = executeCommand,
  prompts,
  report = () => undefined,
}: ProvisionOptions): Promise<SetupState | null> => {
  const destination = resolve(destinationInput);
  const preset = await readPreset(destination);
  if (!preset.selection.database) {
    return null;
  }
  if (!preset.provisioning) {
    throw new Error(
      "This generated project predates provider provisioning. Regenerate it with the current template."
    );
  }
  const state =
    (await readSetupState(destination)) ?? initialState(destination, preset);
  await writeSetupState(destination, state);

  const inputs = await collectInputs({
    destination,
    execute,
    preset,
    prompts,
    state,
  });
  if (!hasStage(state, "consent")) {
    if (!(await prompts.confirmProvisioning(provisioningSummary(preset)))) {
      throw new Error(
        `Provider setup was not started. Resume later with --resume ${destination}`
      );
    }
    await completeStage(destination, state, "consent");
  }

  const rootEnv = await configureConvex({
    destination,
    execute,
    inputs,
    preset,
    report,
    state,
  });

  if (preset.selection.auth) {
    await runStage({
      destination,
      name: "workos.webhook",
      report,
      runStageAction: async () => {
        const backendEnv = await readEnvFile(
          join(destination, "packages/backend/.env.local")
        );
        if (!backendEnv.WORKOS_WEBHOOK_SECRET) {
          await createWorkosWebhook({
            destination,
            execute,
            preset,
            rootEnv,
            state,
          });
        }
      },
      state,
    });
    await runStage({
      destination,
      name: "resend.configured",
      report,
      runStageAction: async () => {
        const backendEnv = await readEnvFile(
          join(destination, "packages/backend/.env.local")
        );
        if (
          !(
            backendEnv.RESEND_API_KEY &&
            backendEnv.RESEND_WEBHOOK_SECRET &&
            backendEnv.RESEND_FROM_EMAIL
          )
        ) {
          await createResendResources({
            destination,
            execute,
            inputs,
            preset,
            state,
          });
        }
      },
      state,
    });
  }

  if (preset.selection.payments) {
    await configureStripe({
      destination,
      execute,
      inputs,
      preset,
      prompts,
      report,
      state,
    });
  }

  await runStage({
    destination,
    name: "convex.environment",
    report,
    runStageAction: async () => {
      const values = await finalEnvironment(destination, preset);
      if (Object.keys(values).length > 0) {
        await setConvexEnvironment({ destination, execute, values });
      }
    },
    state,
  });
  await runStage({
    destination,
    name: "convex.final-push",
    report,
    runStageAction: async () => {
      if (preset.selection.auth || preset.selection.payments) {
        await pushConvex(destination, execute, false);
      }
    },
    state,
  });
  return state;
};
