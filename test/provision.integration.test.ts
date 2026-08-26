import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProjectRequest } from "../src/domain";
import { applyProjectNaming, composeProject } from "../src/generate";
import type { ProvisionPromptClient } from "../src/provider-prompts";
import {
  type CommandExecutor,
  type CommandOptions,
  convexCommand,
  executeCommand,
  provisionProject,
} from "../src/provision";
import { readEnvFile, upsertEnvFile } from "../src/setup-files";

const templateCheckout = resolve(import.meta.dir, "../../starter-boilerplate");
let outputRoot = "";

const request: ProjectRequest = {
  displayName: "Acme Books",
  selection: {
    capability: "stripe",
    electron: true,
    framework: "tanstack",
    kind: "product",
    marketing: true,
  },
  slug: "acme-books",
};

const successful = (stdout = "") => ({
  exitCode: 0,
  stderr: "",
  stdout,
});

const has = (options: CommandOptions, ...parts: string[]): boolean =>
  parts.every((part) => options.command.includes(part));

const createExecutor = (
  destination: string,
  mutations: string[],
  convexEnvironmentUpdates: Record<string, string | undefined>[]
): CommandExecutor => {
  let convexPushes = 0;
  let stripeProductCreated = false;
  let workosWebhook:
    | {
        endpoint_url: string;
        id: string;
        secret: string;
      }
    | undefined;

  return async (options) => {
    if (has(options, "git", "config", "user.email")) {
      return successful("developer@example.com");
    }
    if (has(options, "login", "status")) {
      return successful(
        "Status: Logged in\nTeams: 1 team accessible\n  - Acme team (acme-team)"
      );
    }
    if (has(options, "project", "create")) {
      mutations.push("convex.project");
      return successful();
    }
    if (has(options, "deployment", "create")) {
      const reference = options.command[options.command.indexOf("create") + 1];
      mutations.push(`convex.deployment:${reference}`);
      await upsertEnvFile(join(destination, ".env.local"), {
        CONVEX_DEPLOYMENT: "dev:swift-otter-123",
        CONVEX_SITE_URL: "https://swift-otter-123.convex.site",
        CONVEX_URL: "https://swift-otter-123.convex.cloud",
      });
      return successful();
    }
    if (has(options, "env", "set", "--from-file")) {
      const pathIndex = options.command.indexOf("--from-file") + 1;
      const path = options.command[pathIndex];
      if (!path) {
        throw new Error("Missing fake Convex env path.");
      }
      convexEnvironmentUpdates.push(await readEnvFile(path));
      return successful();
    }
    if (has(options, "dev", "--once")) {
      convexPushes += 1;
      mutations.push(`convex.push.${convexPushes}`);
      if (convexPushes === 1) {
        await upsertEnvFile(join(destination, ".env.local"), {
          WORKOS_API_KEY: "sk_test_workos",
          WORKOS_CLIENT_ID: "client_test",
        });
      }
      return successful();
    }
    if (has(options, "workos@0.21.1", "--version")) {
      return successful("0.21.1");
    }
    if (has(options, "workos@0.21.1", "webhook", "list")) {
      return successful(
        JSON.stringify({
          data: workosWebhook ? [workosWebhook] : [],
          listMetadata: { after: null, before: null },
        })
      );
    }
    if (has(options, "workos@0.21.1", "webhook", "create")) {
      mutations.push("workos.webhook");
      const urlArgument = options.command.find((value) =>
        value.startsWith("--url=")
      );
      workosWebhook = {
        endpoint_url: urlArgument?.slice("--url=".length) ?? "missing-url",
        id: "we_workos",
        secret: "workos_signing_secret",
      };
      return successful(
        JSON.stringify({
          data: workosWebhook,
          message: "Webhook created",
          status: "ok",
        })
      );
    }
    if (has(options, "resend-cli@2.16.0", "--version")) {
      return successful("resend-cli v2.16.0");
    }
    if (has(options, "resend-cli@2.16.0", "api-keys", "list")) {
      return successful('{"object":"list","data":[]}');
    }
    if (has(options, "resend-cli@2.16.0", "webhooks", "create")) {
      mutations.push("resend.webhook");
      return successful(
        '{"id":"resend_webhook_123","signing_secret":"whsec_resend"}'
      );
    }
    if (has(options, "@stripe/cli@1.50.5", "--version")) {
      return successful("stripe version 1.50.5");
    }
    if (has(options, "@stripe/cli@1.50.5", "sandbox", "create")) {
      mutations.push("stripe.sandbox");
      return successful(`{
  "secret_key": "rkcs_stripe",
  "publishable_key": "pk_test_stripe",
  "claim_url": "https://dashboard.stripe.com/claim/test",
  "account_id": "acct_test",
  "expires_at": "2026-08-31"
}

Use the keys above to start building your integration.`);
    }
    if (has(options, "@stripe/cli@1.50.5", "accounts", "retrieve")) {
      return successful('{"id":"acct_dashboard","object":"account"}');
    }
    if (has(options, "@stripe/cli@1.50.5", "products", "retrieve")) {
      return successful(
        stripeProductCreated
          ? '{"id":"prod_acme_books_pro","object":"product"}'
          : '{"error":{"code":"resource_missing","message":"No such product: prod_acme_books_pro","type":"invalid_request_error"}}'
      );
    }
    if (has(options, "@stripe/cli@1.50.5", "products", "create")) {
      mutations.push("stripe.product");
      stripeProductCreated = true;
      return successful('{"id":"prod_acme_books_pro"}');
    }
    if (has(options, "@stripe/cli@1.50.5", "prices", "list")) {
      return successful('{"object":"list","data":[]}');
    }
    if (has(options, "@stripe/cli@1.50.5", "prices", "create")) {
      const yearly = options.command.includes("--recurring.interval=year");
      mutations.push(yearly ? "stripe.price.year" : "stripe.price.month");
      return successful(
        JSON.stringify({ id: yearly ? "price_year" : "price_month" })
      );
    }
    if (
      has(
        options,
        "@stripe/cli@1.50.5",
        "billing_portal",
        "configurations",
        "list"
      )
    ) {
      return successful('{"object":"list","data":[{"id":"bpc_default"}]}');
    }
    if (
      has(
        options,
        "@stripe/cli@1.50.5",
        "billing_portal",
        "configurations",
        "update"
      )
    ) {
      mutations.push("stripe.portal");
      return successful('{"id":"bpc_default"}');
    }
    if (has(options, "@stripe/cli@1.50.5", "webhook_endpoints", "list")) {
      return successful('{"object":"list","data":[]}');
    }
    if (has(options, "@stripe/cli@1.50.5", "webhook_endpoints", "create")) {
      mutations.push("stripe.webhook");
      return successful('{"id":"we_test","secret":"whsec_stripe"}');
    }
    throw new Error(`Unhandled fake command: ${options.command.join(" ")}`);
  };
};

const prompts = (
  calls: string[],
  stripeSetupMethod: "claimable" | "dashboard" = "claimable",
  stripeClaimChoice: "claimed" | "dashboard" = "claimed"
): ProvisionPromptClient => ({
  confirmProvisioning: (summary) => {
    calls.push(`confirm:${summary}`);
    return Promise.resolve(true);
  },
  convexTeam: () => {
    calls.push("convex-team");
    return Promise.resolve("unused-team");
  },
  resendApiKey: () => {
    calls.push("resend-key");
    return Promise.resolve("re_bootstrap");
  },
  resendFromEmail: () => {
    calls.push("resend-from");
    return Promise.resolve("onboarding@resend.dev");
  },
  stripeApiKey: () => {
    calls.push("stripe-api-key");
    return Promise.resolve("rk_test_dashboard");
  },
  stripeClaimChoice: () => {
    calls.push("stripe-claim");
    return Promise.resolve(stripeClaimChoice);
  },
  stripeEmail: () => {
    calls.push("stripe-email");
    return Promise.resolve("unused@example.com");
  },
  stripeSetupMethod: () => {
    calls.push("stripe-setup");
    return Promise.resolve(stripeSetupMethod);
  },
});

beforeAll(async () => {
  outputRoot = await mkdtemp(join(tmpdir(), "create-app-provision-"));
});

afterAll(async () => {
  await rm(outputRoot, { force: true, recursive: true });
});

describe("provider provisioning", () => {
  test("uses the installed Convex version without downloading it", async () => {
    const command = convexCommand("--version");
    expect(command).toEqual([
      process.execPath,
      "x",
      "--bun",
      "--no-install",
      "convex",
      "--version",
    ]);

    const result = await executeCommand({
      command,
      cwd: templateCheckout,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stderr: "",
      stdout: "1.45.0",
    });
  });

  test("provisions a Convex-only selection without empty provider env writes", async () => {
    const destination = join(outputRoot, "convex-only");
    const convexRequest: ProjectRequest = {
      displayName: "Convex App",
      selection: {
        capability: "convex",
        electron: false,
        framework: "next",
        kind: "product",
        marketing: false,
      },
      slug: "convex-app",
    };
    await composeProject({
      destination,
      request: convexRequest,
      templatePath: templateCheckout,
    });
    await applyProjectNaming({
      destination,
      request: convexRequest,
    });
    const mutations: string[] = [];
    const convexEnvironmentUpdates: Record<string, string | undefined>[] = [];

    await provisionProject({
      destination,
      execute: createExecutor(destination, mutations, convexEnvironmentUpdates),
      prompts: prompts([]),
    });

    expect(mutations).toEqual([
      "convex.project",
      "convex.deployment:acme-team:convex-app:dev/create-app",
      "convex.push.1",
    ]);
    expect(convexEnvironmentUpdates).toEqual([]);
    expect(
      await readEnvFile(join(destination, "apps/app/.env.local"))
    ).toMatchObject({
      NEXT_PUBLIC_CONVEX_URL: "https://swift-otter-123.convex.cloud",
    });
  });

  test("configures the full selection and resumes without duplicate writes", async () => {
    const destination = join(outputRoot, "full-tanstack");
    await composeProject({
      destination,
      request,
      templatePath: templateCheckout,
    });
    await applyProjectNaming({
      destination,
      request,
    });

    const mutations: string[] = [];
    const convexEnvironmentUpdates: Record<string, string | undefined>[] = [];
    const promptCalls: string[] = [];
    const reports: string[] = [];
    const execute = createExecutor(
      destination,
      mutations,
      convexEnvironmentUpdates
    );
    const state = await provisionProject({
      destination,
      execute,
      prompts: prompts(promptCalls),
      report: (message) => reports.push(message),
    });

    expect(state?.completedStages).toContain("convex.final-push");
    expect(mutations).toEqual([
      "convex.project",
      "convex.deployment:acme-team:acme-books:dev/create-app",
      "convex.push.1",
      "workos.webhook",
      "resend.webhook",
      "stripe.sandbox",
      "stripe.product",
      "stripe.price.month",
      "stripe.price.year",
      "stripe.portal",
      "stripe.webhook",
      "convex.push.2",
    ]);
    expect(promptCalls).toEqual([
      "resend-key",
      "resend-from",
      "stripe-setup",
      expect.stringContaining("Convex project and cloud dev deployment"),
      "stripe-claim",
    ]);
    expect(reports).toContain("Creating Stripe Pro product");
    expect(reports.some((message) => message.startsWith("Create "))).toBe(
      false
    );

    const appEnv = await readEnvFile(join(destination, "apps/app/.env.local"));
    expect(appEnv).toMatchObject({
      VITE_CONVEX_URL: "https://swift-otter-123.convex.cloud",
      WORKOS_API_KEY: "sk_test_workos",
      WORKOS_CLIENT_ID: "client_test",
      WORKOS_REDIRECT_URI: "http://localhost:3001/callback",
    });
    expect(appEnv.WORKOS_COOKIE_PASSWORD?.length).toBeGreaterThanOrEqual(32);

    const backendEnv = await readEnvFile(
      join(destination, "packages/backend/.env.local")
    );
    expect(backendEnv).toMatchObject({
      RESEND_API_KEY: "re_bootstrap",
      RESEND_FROM_EMAIL: "onboarding@resend.dev",
      RESEND_WEBHOOK_SECRET: "whsec_resend",
      STRIPE_PORTAL_CONFIGURATION_ID: "bpc_default",
      STRIPE_SECRET_KEY: "rkcs_stripe",
      STRIPE_WEBHOOK_SECRET: "whsec_stripe",
      WORKOS_WEBHOOK_SECRET: "workos_signing_secret",
    });
    expect(backendEnv.WORKOS_ACTION_SECRET?.length).toBeGreaterThanOrEqual(32);
    expect(convexEnvironmentUpdates[0]).toMatchObject({
      WORKOS_ACTION_SECRET: backendEnv.WORKOS_ACTION_SECRET,
      WORKOS_WEBHOOK_SECRET: "whsec_create_app_initial_setup",
    });
    expect(convexEnvironmentUpdates.at(-1)).toMatchObject({
      RESEND_API_KEY: "re_bootstrap",
      STRIPE_SECRET_KEY: "rkcs_stripe",
      WORKOS_ACTION_SECRET: backendEnv.WORKOS_ACTION_SECRET,
      WORKOS_WEBHOOK_SECRET: "workos_signing_secret",
    });

    const stateContents = await readFile(
      join(destination, ".starter/setup-state.json"),
      "utf8"
    );
    expect(stateContents).not.toContain("sk_test_");
    expect(stateContents).not.toContain("re_bootstrap");
    expect(stateContents).not.toContain("whsec_");
    expect(stateContents).not.toContain("workos_signing_secret");
    expect(stateContents).not.toContain(
      backendEnv.WORKOS_ACTION_SECRET ?? "missing action secret"
    );
    expect(
      (await stat(join(destination, ".starter/setup-state.json"))).mode % 512
    ).toBe(0o600);

    const mutationCount = mutations.length;
    await provisionProject({
      destination,
      execute,
      prompts: prompts([]),
    });
    expect(mutations).toHaveLength(mutationCount);
  });

  test("uses a Dashboard sandbox without creating a claimable sandbox", async () => {
    const destination = join(outputRoot, "dashboard-stripe");
    await composeProject({
      destination,
      request,
      templatePath: templateCheckout,
    });
    await applyProjectNaming({
      destination,
      request,
    });

    const mutations: string[] = [];
    const promptCalls: string[] = [];
    const state = await provisionProject({
      destination,
      execute: createExecutor(destination, mutations, []),
      prompts: prompts(promptCalls, "dashboard"),
    });

    expect(mutations).not.toContain("stripe.sandbox");
    expect(promptCalls).toContain("stripe-api-key");
    expect(promptCalls).not.toContain("stripe-claim");
    expect(state?.providers?.stripe).toMatchObject({
      accountId: "acct_dashboard",
      source: "dashboard",
    });
    expect(
      await readEnvFile(join(destination, "packages/backend/.env.local"))
    ).toMatchObject({ STRIPE_SECRET_KEY: "rk_test_dashboard" });
  });

  test("switches an unclaimed sandbox to a Dashboard sandbox", async () => {
    const destination = join(outputRoot, "replace-claimable-stripe");
    await composeProject({
      destination,
      request,
      templatePath: templateCheckout,
    });
    await applyProjectNaming({
      destination,
      request,
    });

    const mutations: string[] = [];
    const promptCalls: string[] = [];
    const state = await provisionProject({
      destination,
      execute: createExecutor(destination, mutations, []),
      prompts: prompts(promptCalls, "claimable", "dashboard"),
    });

    expect(mutations).toContain("stripe.sandbox");
    expect(promptCalls).toContain("stripe-claim");
    expect(promptCalls).toContain("stripe-api-key");
    expect(state?.providers?.stripe).toMatchObject({
      accountId: "acct_dashboard",
      source: "dashboard",
    });
    expect(state?.providers?.stripe?.claimUrl).toBeUndefined();
    expect(
      await readEnvFile(join(destination, "packages/backend/.env.local"))
    ).toMatchObject({ STRIPE_SECRET_KEY: "rk_test_dashboard" });
  });

  test("recovers a created WorkOS webhook without creating a duplicate", async () => {
    const destination = join(outputRoot, "workos-resume");
    await composeProject({
      destination,
      request,
      templatePath: templateCheckout,
    });
    await applyProjectNaming({
      destination,
      request,
    });

    const mutations: string[] = [];
    const baseExecutor = createExecutor(destination, mutations, []);
    let hideCreateSecret = true;
    const execute: CommandExecutor = async (options) => {
      const result = await baseExecutor(options);
      if (
        hideCreateSecret &&
        has(options, "workos@0.21.1", "webhook", "create")
      ) {
        hideCreateSecret = false;
        return successful(
          JSON.stringify({
            data: { id: "we_workos" },
            message: "Webhook created",
            status: "ok",
          })
        );
      }
      return result;
    };

    await expect(
      provisionProject({
        destination,
        execute,
        prompts: prompts([]),
      })
    ).rejects.toThrow("WorkOS did not return its webhook signing secret");
    await provisionProject({
      destination,
      execute,
      prompts: prompts([]),
    });

    expect(
      mutations.filter((mutation) => mutation === "workos.webhook")
    ).toHaveLength(1);
    expect(
      await readEnvFile(join(destination, "packages/backend/.env.local"))
    ).toMatchObject({ WORKOS_WEBHOOK_SECRET: "workos_signing_secret" });
  });

  test("revalidates a completed Stripe product stage on resume", async () => {
    const destination = join(outputRoot, "stripe-product-resume");
    await composeProject({
      destination,
      request,
      templatePath: templateCheckout,
    });
    await applyProjectNaming({
      destination,
      request,
    });

    const mutations: string[] = [];
    const baseExecutor = createExecutor(destination, mutations, []);
    const remoteState: { productMissing: boolean } = { productMissing: false };
    const execute: CommandExecutor = async (options) => {
      if (
        remoteState.productMissing &&
        has(options, "@stripe/cli@1.50.5", "products", "retrieve")
      ) {
        return successful(
          '{"error":{"code":"resource_missing","message":"No such product: prod_acme_books_pro","type":"invalid_request_error"}}'
        );
      }
      const result = await baseExecutor(options);
      if (
        remoteState.productMissing &&
        has(options, "@stripe/cli@1.50.5", "products", "create")
      ) {
        remoteState.productMissing = false;
      }
      return result;
    };

    await provisionProject({
      destination,
      execute,
      prompts: prompts([]),
    });
    remoteState.productMissing = true;
    await provisionProject({
      destination,
      execute,
      prompts: prompts([]),
    });

    expect(
      mutations.filter((mutation) => mutation === "stripe.product")
    ).toHaveLength(2);
  });

  test("reuses the entered Resend key after a webhook failure", async () => {
    const destination = join(outputRoot, "resend-resume");
    await composeProject({
      destination,
      request,
      templatePath: templateCheckout,
    });
    await applyProjectNaming({
      destination,
      request,
    });

    const mutations: string[] = [];
    const baseExecutor = createExecutor(destination, mutations, []);
    let failWebhook = true;
    const execute: CommandExecutor = async (options) => {
      if (
        failWebhook &&
        has(options, "resend-cli@2.16.0", "webhooks", "create")
      ) {
        failWebhook = false;
        return {
          exitCode: 1,
          stderr: "temporary Resend failure",
          stdout: "",
        };
      }
      return await baseExecutor(options);
    };

    await expect(
      provisionProject({
        destination,
        execute,
        prompts: prompts([]),
      })
    ).rejects.toThrow("temporary Resend failure");
    await provisionProject({
      destination,
      execute,
      prompts: prompts([]),
    });

    expect(mutations).not.toContain("resend.key");
    expect(
      mutations.filter((mutation) => mutation === "resend.webhook")
    ).toHaveLength(1);
  });
});
