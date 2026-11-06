import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PromptCancelledError } from "../src/clack-prompts";
import { type ProjectRequest, projectSlug } from "../src/domain";
import { applyProjectNaming, composeProject } from "../src/generate";
import type { ProvisionPromptClient } from "../src/provider-prompts";
import {
  type CommandExecutor,
  type CommandOptions,
  convexCommand,
  executeCommand,
  provisionProject,
} from "../src/provision";
import {
  readEnvFile,
  readSetupState,
  upsertEnvFile,
  writeSetupState,
} from "../src/setup-files";

const templateCheckout = resolve(import.meta.dir, "../../starter-boilerplate");
const PLACEHOLDER_SECRET_PATTERN = /^whsec_[\w-]{43}$/;
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
      // The Convex CLI prints its team list to stderr.
      return {
        exitCode: 0,
        stderr:
          "Status: Logged in\nTeams: 1 team accessible\n  - Acme team (acme-team)",
        stdout: "",
      };
    }
    if (has(options, "project", "create")) {
      mutations.push("convex.project");
      const slug = projectSlug(options.command.at(-1) ?? "");
      return {
        exitCode: 0,
        stderr: `Created project ${slug} in team acme-team, manage it at https://dashboard.convex.dev/t/acme-team/${slug}`,
        stdout: "",
      };
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
    if (has(options, "resend-cli@2.16.0", "webhooks", "list")) {
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
        "create"
      )
    ) {
      mutations.push("stripe.portal");
      return successful('{"id":"bpc_app"}');
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
  stripeEmail: (suggestedEmail) => {
    calls.push(`stripe-email:${suggestedEmail}`);
    return Promise.resolve("confirmed@example.com");
  },
  stripeSetupMethod: () => {
    calls.push("stripe-setup");
    return Promise.resolve(stripeSetupMethod);
  },
});

const generate = async (name: string): Promise<string> => {
  const destination = join(outputRoot, name);
  await composeProject({
    destination,
    request,
    templatePath: templateCheckout,
  });
  await applyProjectNaming({ destination, request });
  return destination;
};

const setupState = async (destination: string) =>
  await readSetupState(destination);

beforeAll(async () => {
  outputRoot = await mkdtemp(join(tmpdir(), "create-app-provision-"));
});

afterAll(async () => {
  await rm(outputRoot, { force: true, recursive: true });
});

describe("provider provisioning", () => {
  test("uses the installed Convex version without downloading it", async () => {
    const installedConvex = JSON.parse(
      await readFile(
        join(templateCheckout, "node_modules/convex/package.json"),
        "utf8"
      )
    );
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
      stdout: installedConvex.version,
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
      expect.stringContaining("Convex project and cloud dev deployment"),
      "resend-key",
      "resend-from",
      "stripe-setup",
      "stripe-email:developer@example.com",
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
      STRIPE_PORTAL_CONFIGURATION_ID: "bpc_app",
      STRIPE_SECRET_KEY: "rkcs_stripe",
      STRIPE_WEBHOOK_SECRET: "whsec_stripe",
      WORKOS_WEBHOOK_SECRET: "workos_signing_secret",
    });
    expect(backendEnv.WORKOS_ACTION_SECRET?.length).toBeGreaterThanOrEqual(32);
    expect(convexEnvironmentUpdates[0]).toMatchObject({
      WORKOS_ACTION_SECRET: backendEnv.WORKOS_ACTION_SECRET,
      WORKOS_WEBHOOK_SECRET: expect.stringMatching(PLACEHOLDER_SECRET_PATTERN),
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
    const resumedPromptCalls: string[] = [];
    await provisionProject({
      destination,
      execute,
      prompts: prompts(resumedPromptCalls),
    });

    expect(mutations).not.toContain("resend.key");
    expect(
      mutations.filter((mutation) => mutation === "resend.webhook")
    ).toHaveLength(1);
    expect(resumedPromptCalls).not.toContain("resend-key");
    expect(resumedPromptCalls).not.toContain("resend-from");
  });

  test("keeps the entered Resend details when an earlier stage fails", async () => {
    const destination = join(outputRoot, "resend-earlier-failure");
    await composeProject({
      destination,
      request,
      templatePath: templateCheckout,
    });
    await applyProjectNaming({
      destination,
      request,
    });

    const baseExecutor = createExecutor(destination, [], []);
    let failWebhook = true;
    const execute: CommandExecutor = async (options) => {
      if (failWebhook && has(options, "workos@0.21.1", "webhook", "create")) {
        failWebhook = false;
        return { exitCode: 1, stderr: "temporary WorkOS failure", stdout: "" };
      }
      return await baseExecutor(options);
    };

    const firstPromptCalls: string[] = [];
    await expect(
      provisionProject({
        destination,
        execute,
        prompts: prompts(firstPromptCalls),
      })
    ).rejects.toThrow("temporary WorkOS failure");
    expect(firstPromptCalls).toContain("resend-key");
    expect(firstPromptCalls).toContain("resend-from");

    const resumedPromptCalls: string[] = [];
    await provisionProject({
      destination,
      execute,
      prompts: prompts(resumedPromptCalls),
    });

    expect(resumedPromptCalls).not.toContain("resend-key");
    expect(resumedPromptCalls).not.toContain("resend-from");
    const backendEnvPath = join(destination, "packages/backend/.env.local");
    expect(await readEnvFile(backendEnvPath)).toMatchObject({
      RESEND_API_KEY: "re_bootstrap",
      RESEND_FROM_EMAIL: "onboarding@resend.dev",
    });
    expect((await stat(backendEnvPath)).mode % 0o1000).toBe(0o600);
  });

  test.each(["claimable", "dashboard"] as const)(
    "keeps the %s Stripe answers when an earlier stage fails",
    async (method) => {
      const destination = await generate(`stripe-earlier-failure-${method}`);
      const baseExecutor = createExecutor(destination, [], []);
      let failWebhook = true;
      const execute: CommandExecutor = async (options) => {
        if (failWebhook && has(options, "workos@0.21.1", "webhook", "create")) {
          failWebhook = false;
          return { exitCode: 1, stderr: "temporary failure", stdout: "" };
        }
        return await baseExecutor(options);
      };

      const firstCalls: string[] = [];
      await expect(
        provisionProject({
          destination,
          execute,
          prompts: prompts(firstCalls, method),
        })
      ).rejects.toThrow("temporary failure");
      expect(firstCalls).toContain("stripe-setup");

      const resumedCalls: string[] = [];
      await provisionProject({
        destination,
        execute,
        prompts: prompts(resumedCalls, method),
      });
      expect(
        resumedCalls.filter(
          (call) =>
            call === "stripe-setup" ||
            call === "stripe-api-key" ||
            call.startsWith("stripe-email")
        )
      ).toEqual([]);
    }
  );

  test("asks for the Stripe answers again when the sandbox stage fails", async () => {
    const destination = await generate("stripe-sandbox-failure");
    const baseExecutor = createExecutor(destination, [], []);
    let failSandbox = true;
    const execute: CommandExecutor = async (options) => {
      if (
        failSandbox &&
        has(options, "@stripe/cli@1.50.5", "sandbox", "create")
      ) {
        failSandbox = false;
        return { exitCode: 1, stderr: "email rejected", stdout: "" };
      }
      return await baseExecutor(options);
    };

    await expect(
      provisionProject({ destination, execute, prompts: prompts([]) })
    ).rejects.toThrow("email rejected");

    const resumedCalls: string[] = [];
    await provisionProject({
      destination,
      execute,
      prompts: prompts(resumedCalls),
    });
    expect(resumedCalls).toContain("stripe-setup");
    expect(
      resumedCalls.some((call) => call.startsWith("stripe-email"))
    ).toBeTrue();
  });

  test("reports a possible duplicate after a lost sandbox or project reply", async () => {
    const destination = await generate("create-attempt-lost-reply");
    const baseExecutor = createExecutor(destination, [], []);
    let failNext = "project";
    const execute: CommandExecutor = async (options) => {
      if (failNext === "project" && has(options, "project", "create")) {
        failNext = "sandbox";
        return { exitCode: 1, stderr: "connection lost", stdout: "" };
      }
      if (
        failNext === "sandbox" &&
        has(options, "@stripe/cli@1.50.5", "sandbox", "create")
      ) {
        failNext = "";
        return { exitCode: 1, stderr: "connection lost", stdout: "" };
      }
      return await baseExecutor(options);
    };

    const reports: string[] = [];
    const attempt = () =>
      provisionProject({
        destination,
        execute,
        prompts: prompts([]),
        report: (message) => reports.push(message),
      });

    await expect(attempt()).rejects.toThrow("connection lost");
    expect(reports.join("\n")).not.toContain("may have created");
    await expect(attempt()).rejects.toThrow("connection lost");
    expect(reports.join("\n")).toContain(
      "An earlier attempt may have created a Convex project."
    );
    expect(reports.join("\n")).not.toContain("a Stripe sandbox.");
    await attempt();
    expect(reports.join("\n")).toContain(
      "An earlier attempt may have created a Stripe sandbox."
    );
  });

  test("declining consent cancels setup and saves nothing", async () => {
    const destination = join(outputRoot, "declined-consent");
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
    await expect(
      provisionProject({
        destination,
        execute: createExecutor(destination, mutations, []),
        prompts: {
          ...prompts([]),
          confirmProvisioning: () => Promise.resolve(false),
        },
      })
    ).rejects.toBeInstanceOf(PromptCancelledError);

    expect(mutations).toEqual([]);
    expect(
      await readEnvFile(join(destination, "packages/backend/.env.local"))
    ).not.toHaveProperty("RESEND_API_KEY");
  });

  test("does not pass a surrounding project's deployment to commands", async () => {
    const names = [
      "CONVEX_DEPLOYMENT",
      "CONVEX_DEPLOY_KEY",
      "CONVEX_SELF_HOSTED_ADMIN_KEY",
      "CONVEX_SELF_HOSTED_URL",
    ];
    const original = names.map((name) => process.env[name]);
    for (const name of names) {
      process.env[name] = "surrounding-project";
    }
    try {
      const result = await executeCommand({
        command: [
          process.execPath,
          "-e",
          "console.log(JSON.stringify(process.env))",
        ],
        cwd: outputRoot,
        env: { CONVEX_DEPLOYMENT: "explicit" },
      });
      const childEnv = JSON.parse(result.stdout);
      expect(childEnv.CONVEX_DEPLOYMENT).toBe("explicit");
      expect(childEnv.CONVEX_DEPLOY_KEY).toBeUndefined();
      expect(childEnv.CONVEX_SELF_HOSTED_ADMIN_KEY).toBeUndefined();
      expect(childEnv.CONVEX_SELF_HOSTED_URL).toBeUndefined();
    } finally {
      for (const [index, name] of names.entries()) {
        const value = original[index];
        if (value === undefined) {
          Reflect.deleteProperty(process.env, name);
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  test("logs in when Convex reports a logged-out status with exit code zero", async () => {
    const destination = await generate("convex-logged-out");
    const baseExecutor = createExecutor(destination, [], []);
    let loggedIn = false;
    const commands: string[] = [];
    const execute: CommandExecutor = async (options) => {
      if (has(options, "login", "status") && !loggedIn) {
        return { exitCode: 0, stderr: "Status: Not logged in", stdout: "" };
      }
      if (options.command.at(-1) === "login") {
        commands.push("login");
        loggedIn = true;
        return successful();
      }
      return await baseExecutor(options);
    };
    const promptCalls: string[] = [];

    await provisionProject({
      destination,
      execute,
      prompts: prompts(promptCalls),
    });

    expect(commands).toEqual(["login"]);
    expect(promptCalls[1]).toBe("resend-key");
  });

  test("stops and records preflight when Convex login does not complete", async () => {
    const destination = await generate("convex-login-fails");
    const baseExecutor = createExecutor(destination, [], []);
    const execute: CommandExecutor = async (options) => {
      if (has(options, "login", "status")) {
        return { exitCode: 0, stderr: "Status: Not logged in", stdout: "" };
      }
      if (options.command.at(-1) === "login") {
        return successful();
      }
      return await baseExecutor(options);
    };
    const promptCalls: string[] = [];

    await expect(
      provisionProject({
        destination,
        execute,
        prompts: prompts(promptCalls),
      })
    ).rejects.toThrow("Convex login did not complete");

    expect(promptCalls).toHaveLength(1);
    expect(await setupState(destination)).toMatchObject({
      lastFailure: { stage: "preflight" },
    });
  });

  test("asks for consent before commands and provider keys", async () => {
    const destination = await generate("consent-first");
    const commands: string[][] = [];
    const promptCalls: string[] = [];

    await expect(
      provisionProject({
        destination,
        execute: (options) => {
          commands.push(options.command);
          return Promise.resolve(successful());
        },
        prompts: {
          ...prompts(promptCalls),
          confirmProvisioning: () => {
            promptCalls.push("declined");
            return Promise.resolve(false);
          },
        },
      })
    ).rejects.toBeInstanceOf(PromptCancelledError);

    expect(commands).toEqual([]);
    expect(promptCalls).toEqual(["declined"]);
  });

  test("names the project with the display name and uses the reported slug", async () => {
    const destination = await generate("convex-other-slug");
    const mutations: string[] = [];
    const baseExecutor = createExecutor(destination, mutations, []);
    const projectCommands: string[][] = [];
    const execute: CommandExecutor = async (options) => {
      if (has(options, "project", "create")) {
        projectCommands.push(options.command);
        return {
          exitCode: 0,
          stderr:
            "Created project \u001B[1macme-books-2\u001B[22m in team \u001B[1macme-team\u001B[22m, manage it at https://dashboard.convex.dev",
          stdout: "",
        };
      }
      return await baseExecutor(options);
    };

    const state = await provisionProject({
      destination,
      execute,
      prompts: prompts([]),
    });

    expect(projectCommands[0]?.slice(-5)).toEqual([
      "create",
      "--team",
      "acme-team",
      "--",
      "Acme Books",
    ]);
    expect(mutations).toContain(
      "convex.deployment:acme-team:acme-books-2:dev/create-app"
    );
    expect(state?.convex?.projectSlug).toBe("acme-books-2");
  });

  test("stops when Convex does not report the created project slug", async () => {
    const destination = await generate("convex-no-slug");
    const mutations: string[] = [];
    const baseExecutor = createExecutor(destination, mutations, []);
    const execute: CommandExecutor = async (options) =>
      has(options, "project", "create")
        ? successful()
        : await baseExecutor(options);

    await expect(
      provisionProject({ destination, execute, prompts: prompts([]) })
    ).rejects.toThrow("did not report the project slug");

    expect(mutations).toEqual([]);
  });

  test("selects an existing deployment after a lost creation reply", async () => {
    const destination = await generate("convex-lost-deployment");
    const baseExecutor = createExecutor(destination, [], []);
    let createAttempts = 0;
    const selected: string[] = [];
    const execute: CommandExecutor = async (options) => {
      if (has(options, "deployment", "create")) {
        createAttempts += 1;
        if (createAttempts === 1) {
          await baseExecutor(options);
          return { exitCode: 1, stderr: "connection reset", stdout: "" };
        }
        return { exitCode: 1, stderr: "already exists", stdout: "" };
      }
      if (has(options, "deployment", "select")) {
        selected.push(options.command.at(-1) ?? "");
        return successful();
      }
      return await baseExecutor(options);
    };

    await provisionProject({ destination, execute, prompts: prompts([]) });

    expect(selected).toEqual(["acme-team:acme-books:dev/create-app"]);
  });

  test("does not select a deployment from an unconfirmed project slug", async () => {
    const destination = await generate("convex-unconfirmed-slug");
    await writeSetupState(destination, {
      completedStages: ["consent", "convex.project"],
      convex: { projectSlug: "acme-books", teamSlug: "acme-team" },
      project: {
        displayName: request.displayName,
        path: destination,
        slug: request.slug,
      },
      schemaVersion: 1,
      selectionId: "tanstack-stripe-marketing-electron",
      updatedAt: new Date().toISOString(),
    });
    const baseExecutor = createExecutor(destination, [], []);
    const selected: string[] = [];
    const execute: CommandExecutor = async (options) => {
      if (has(options, "deployment", "create")) {
        return { exitCode: 1, stderr: "already exists", stdout: "" };
      }
      if (has(options, "deployment", "select")) {
        selected.push(options.command.at(-1) ?? "");
        return successful();
      }
      return await baseExecutor(options);
    };

    await expect(
      provisionProject({ destination, execute, prompts: prompts([]) })
    ).rejects.toThrow("already exists");

    expect(selected).toEqual([]);
  });

  test("replaces only the Resend webhook at this deployment's URL", async () => {
    const destination = await generate("resend-lost-reply");
    const preset = JSON.parse(
      await readFile(join(destination, ".starter/preset.json"), "utf8")
    );
    const baseExecutor = createExecutor(destination, [], []);
    const deleted: string[] = [];
    const execute: CommandExecutor = async (options) => {
      if (has(options, "resend-cli@2.16.0", "webhooks", "list")) {
        return successful(
          JSON.stringify({
            data: [
              {
                endpoint: `https://swift-otter-123.convex.site${preset.provisioning.resend.webhookPath}`,
                id: "stale",
              },
              { endpoint: "https://other.example.com/hook", id: "other" },
            ],
          })
        );
      }
      if (has(options, "resend-cli@2.16.0", "webhooks", "delete")) {
        deleted.push(options.command.at(-3) ?? "");
        return successful();
      }
      return await baseExecutor(options);
    };

    await provisionProject({ destination, execute, prompts: prompts([]) });

    expect(deleted).toEqual(["stale"]);
    expect(
      await readEnvFile(join(destination, "packages/backend/.env.local"))
    ).toMatchObject({ RESEND_WEBHOOK_SECRET: "whsec_resend" });
  });

  test("replaces only the Stripe webhook at this deployment's URL", async () => {
    const destination = await generate("stripe-lost-reply");
    const preset = JSON.parse(
      await readFile(join(destination, ".starter/preset.json"), "utf8")
    );
    const baseExecutor = createExecutor(destination, [], []);
    const deleted: string[] = [];
    const execute: CommandExecutor = async (options) => {
      if (has(options, "@stripe/cli@1.50.5", "webhook_endpoints", "list")) {
        return successful(
          JSON.stringify({
            data: [
              {
                id: "we_stale",
                url: `https://swift-otter-123.convex.site${preset.provisioning.stripe.webhookPath}`,
              },
              { id: "we_other", url: "https://other.example.com/hook" },
            ],
          })
        );
      }
      if (has(options, "@stripe/cli@1.50.5", "webhook_endpoints", "delete")) {
        deleted.push(
          options.command[options.command.indexOf("delete") + 1] ?? ""
        );
        return successful('{"deleted":true}');
      }
      return await baseExecutor(options);
    };

    await provisionProject({ destination, execute, prompts: prompts([]) });

    expect(deleted).toEqual(["we_stale"]);
    expect(
      await readEnvFile(join(destination, "packages/backend/.env.local"))
    ).toMatchObject({ STRIPE_WEBHOOK_SECRET: "whsec_stripe" });
  });

  test("creates a new price when an archived price holds the lookup key", async () => {
    const destination = await generate("stripe-archived-price");
    const baseExecutor = createExecutor(destination, [], []);
    const createCommands: string[][] = [];
    const execute: CommandExecutor = async (options) => {
      if (has(options, "@stripe/cli@1.50.5", "prices", "list")) {
        const yearly = options.command.includes(
          "--lookup-keys=acme-books_pro_yearly"
        );
        return successful(
          JSON.stringify({
            data: [
              {
                active: false,
                currency: "usd",
                id: "price_archived",
                product: "prod_acme_books_pro",
                recurring: { interval: yearly ? "year" : "month" },
                unit_amount: yearly ? 8000 : 800,
              },
            ],
          })
        );
      }
      if (has(options, "@stripe/cli@1.50.5", "prices", "create")) {
        createCommands.push(options.command);
      }
      return await baseExecutor(options);
    };

    const state = await provisionProject({
      destination,
      execute,
      prompts: prompts([]),
    });

    expect(state?.providers?.stripe?.monthlyPriceId).toBe("price_month");
    expect(state?.providers?.stripe?.yearlyPriceId).toBe("price_year");
    expect(createCommands[0]).toContain("--transfer-lookup-key=true");
    expect(
      createCommands[0]?.some(
        (part) =>
          part.startsWith("--idempotency=") && part.endsWith("-price_archived")
      )
    ).toBe(true);
  });

  test("creates a portal configuration for this app only", async () => {
    const destination = await generate("stripe-own-portal");
    const baseExecutor = createExecutor(destination, [], []);
    const portalCommands: string[][] = [];
    const execute: CommandExecutor = async (options) => {
      if (has(options, "billing_portal")) {
        portalCommands.push(options.command);
      }
      return await baseExecutor(options);
    };

    await provisionProject({ destination, execute, prompts: prompts([]) });

    expect(portalCommands).toHaveLength(1);
    expect(portalCommands[0]).toContain("create");
    expect(portalCommands[0]).toContain("--name=Acme Books");
    expect(portalCommands[0]).not.toContain("update");
  });

  test("uses the confirmed email for the claimable sandbox", async () => {
    const destination = await generate("stripe-confirmed-email");
    const baseExecutor = createExecutor(destination, [], []);
    const sandboxCommands: string[][] = [];
    const execute: CommandExecutor = async (options) => {
      if (has(options, "@stripe/cli@1.50.5", "sandbox", "create")) {
        sandboxCommands.push(options.command);
      }
      return await baseExecutor(options);
    };

    await provisionProject({ destination, execute, prompts: prompts([]) });

    expect(sandboxCommands[0]).toContain("confirmed@example.com");
  });

  test("generates a different placeholder webhook secret for each setup", async () => {
    const placeholderFromSetup = async (name: string) => {
      const destination = await generate(name);
      const updates: Record<string, string | undefined>[] = [];
      await provisionProject({
        destination,
        execute: createExecutor(destination, [], updates),
        prompts: prompts([]),
      });
      return updates[0]?.WORKOS_WEBHOOK_SECRET;
    };

    const first = await placeholderFromSetup("placeholder-one");
    const second = await placeholderFromSetup("placeholder-two");

    expect(first).toEqual(expect.stringMatching(PLACEHOLDER_SECRET_PATTERN));
    expect(second).toEqual(expect.stringMatching(PLACEHOLDER_SECRET_PATTERN));
    expect(first).not.toBe(second);
  });

  test("keeps secrets out of stored and thrown failures", async () => {
    const destination = await generate("redacted-failure");
    const baseExecutor = createExecutor(destination, [], []);
    const execute: CommandExecutor = async (options) => {
      if (has(options, "@stripe/cli@1.50.5", "products", "retrieve")) {
        const { WORKOS_ACTION_SECRET: actionSecret } = await readEnvFile(
          join(destination, "packages/backend/.env.local")
        );
        return {
          exitCode: 1,
          stderr: `request failed key=sk_test_LEAKMARK action=${actionSecret} resend=re_bootstrap_key`,
          stdout: "",
        };
      }
      return await baseExecutor(options);
    };

    const error = await provisionProject({
      destination,
      execute,
      prompts: prompts([]),
    }).catch((caught: unknown) => caught);

    const { WORKOS_ACTION_SECRET: actionSecret } = await readEnvFile(
      join(destination, "packages/backend/.env.local")
    );
    const stored = await readFile(
      join(destination, ".starter/setup-state.json"),
      "utf8"
    );
    for (const text of [(error as Error).message, stored]) {
      expect(text).toContain("request failed key=[redacted]");
      expect(text).not.toContain("LEAKMARK");
      expect(text).not.toContain("re_bootstrap");
      expect(text).not.toContain(actionSecret ?? "missing action secret");
    }
  });

  test("keeps secrets out of Stripe API errors with exit code zero", async () => {
    const destination = await generate("redacted-stripe-error");
    const baseExecutor = createExecutor(destination, [], []);
    const execute: CommandExecutor = async (options) =>
      has(options, "@stripe/cli@1.50.5", "prices", "list")
        ? successful(
            '{"error":{"message":"Invalid key provided: rk_test_LEAKMARK"}}'
          )
        : await baseExecutor(options);

    const error = await provisionProject({
      destination,
      execute,
      prompts: prompts([]),
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain(
      "Invalid key provided: [redacted]"
    );
    expect(await setupState(destination)).toMatchObject({
      lastFailure: {
        message: expect.not.stringContaining("LEAKMARK"),
        stage: "stripe.prices",
      },
    });
  });

  test("points at the terminal output when an interactive command fails", async () => {
    const destination = await generate("interactive-push-failure");
    const baseExecutor = createExecutor(destination, [], []);
    const execute: CommandExecutor = async (options) =>
      options.interactive && has(options, "dev", "--once")
        ? { exitCode: 1, stderr: "", stdout: "" }
        : await baseExecutor(options);

    const error = await provisionProject({
      destination,
      execute,
      prompts: prompts([]),
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(
      "Convex development push failed.\nSee the output above."
    );
  });
});
