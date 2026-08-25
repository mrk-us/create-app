import {
  confirm,
  isCancel,
  note,
  password,
  select,
  text,
} from "@clack/prompts";
import { PromptCancelledError } from "./clack-prompts";

const CONVEX_DASHBOARD_URL = "https://dashboard.convex.dev/";
const RESEND_API_KEYS_URL = "https://resend.com/api-keys";
const STRIPE_DASHBOARD_URL = "https://dashboard.stripe.com/";
const STRIPE_TEST_KEY_PATTERN = /^(?:rk_test_|sk_test_)/;

export type StripeClaimChoice = "claimed" | "dashboard";
export type StripeSetupMethod = "claimable" | "dashboard";

export interface ProvisionPromptClient {
  confirmProvisioning: (summary: string) => Promise<boolean>;
  convexTeam: (suggestedTeam?: string) => Promise<string>;
  resendApiKey: () => Promise<string>;
  resendFromEmail: () => Promise<string>;
  stripeApiKey: () => Promise<string>;
  stripeClaimChoice: (
    claimUrl: string,
    expiresAt?: string
  ) => Promise<StripeClaimChoice>;
  stripeEmail: (suggestedEmail?: string) => Promise<string>;
  stripeSetupMethod: () => Promise<StripeSetupMethod>;
}

const unwrapPrompt = <Value>(value: Value | symbol): Value => {
  if (isCancel(value)) {
    throw new PromptCancelledError();
  }
  return value;
};

const required = (value: string | undefined): string | undefined =>
  value?.trim() ? undefined : "This value is required.";

const email = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim() ?? "";
  if (!trimmed.includes("@")) {
    return "Enter an email address.";
  }
  return undefined;
};

const stripeTestKey = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim() ?? "";
  if (!STRIPE_TEST_KEY_PATTERN.test(trimmed)) {
    return "Enter a sandbox test key beginning with rk_test_ or sk_test_.";
  }
  return undefined;
};

export const clackProviderPrompts: ProvisionPromptClient = {
  confirmProvisioning: async (summary) =>
    unwrapPrompt(
      await confirm({
        initialValue: true,
        message: `Create these development resources?\n${summary}`,
      })
    ),
  convexTeam: async (suggestedTeam) =>
    unwrapPrompt(
      await text({
        ...(suggestedTeam ? { initialValue: suggestedTeam } : {}),
        message: `Convex team slug\nFind it at ${CONVEX_DASHBOARD_URL}`,
        placeholder: "my-team",
        validate: required,
      })
    ).trim(),
  resendApiKey: async () =>
    unwrapPrompt(
      await password({
        mask: "•",
        message: `Resend full-access API key\nUsed by the generated app and webhook setup. Create one at ${RESEND_API_KEYS_URL}`,
        validate: required,
      })
    ).trim(),
  resendFromEmail: async () =>
    unwrapPrompt(
      await text({
        initialValue: "onboarding@resend.dev",
        message: "Resend sender email",
        validate: email,
      })
    ).trim(),
  stripeApiKey: async () => {
    note(
      `1. Open ${STRIPE_DASHBOARD_URL}\n2. Account picker > Switch to sandbox > Manage sandboxes > Create sandbox\n3. Open the sandbox, then go to Developers > API keys\n4. Create a restricted test key, or reveal the standard test secret key`,
      "Stripe Dashboard sandbox"
    );
    return unwrapPrompt(
      await password({
        mask: "•",
        message: "Stripe sandbox API key",
        validate: stripeTestKey,
      })
    ).trim();
  },
  stripeClaimChoice: async (claimUrl, expiresAt) => {
    note(
      `${claimUrl}${expiresAt ? `\n\nClaim before ${expiresAt}.` : ""}`,
      "Claim the Stripe sandbox"
    );
    return unwrapPrompt(
      await select<StripeClaimChoice>({
        initialValue: "claimed",
        message: "Stripe sandbox ownership",
        options: [
          {
            hint: "Continue with the temporary sandbox",
            label: "I claimed this sandbox",
            value: "claimed",
          },
          {
            hint: "Use a sandbox under your existing Stripe account",
            label: "Use a Dashboard sandbox instead",
            value: "dashboard",
          },
        ],
      })
    );
  },
  stripeEmail: async (suggestedEmail) =>
    unwrapPrompt(
      await text({
        ...(suggestedEmail ? { initialValue: suggestedEmail } : {}),
        message: "Email for the Stripe sandbox",
        validate: email,
      })
    ).trim(),
  stripeSetupMethod: async () =>
    unwrapPrompt(
      await select<StripeSetupMethod>({
        initialValue: "dashboard",
        message: "Stripe sandbox",
        options: [
          {
            hint: "Recommended if you already have a Stripe account",
            label: "Use a Dashboard sandbox",
            value: "dashboard",
          },
          {
            hint: "No account required, but it expires unless claimed",
            label: "Create a temporary claimable sandbox",
            value: "claimable",
          },
        ],
      })
    ),
};
