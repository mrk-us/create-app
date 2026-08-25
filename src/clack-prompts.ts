import {
  cancel,
  confirm,
  isCancel,
  multiselect,
  select,
  text,
} from "@clack/prompts";
import {
  type AppChoice,
  type Framework,
  type PromptClient,
  validateProjectName,
} from "./domain";

export class PromptCancelledError extends Error {
  constructor() {
    super("Setup cancelled.");
    this.name = "PromptCancelledError";
  }
}

const unwrapPrompt = <Value>(value: Value | symbol): Value => {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    throw new PromptCancelledError();
  }
  return value;
};

export const clackPrompts: PromptClient = {
  addAuth: async () =>
    unwrapPrompt(
      await confirm({
        initialValue: false,
        message: "Add authentication?",
      })
    ),
  addDatabase: async () =>
    unwrapPrompt(
      await confirm({
        initialValue: false,
        message: "Add a database?",
      })
    ),
  addElectron: async () =>
    unwrapPrompt(
      await confirm({
        initialValue: false,
        message: "Add Electron?",
      })
    ),
  addPayments: async () =>
    unwrapPrompt(
      await confirm({
        initialValue: false,
        message: "Add Stripe payments?",
      })
    ),
  projectName: async () =>
    unwrapPrompt(
      await text({
        message: "Project name",
        placeholder: "Acme Books",
        validate: validateProjectName,
      })
    ),
  selectApps: async () =>
    unwrapPrompt(
      await multiselect<AppChoice>({
        message: "Select apps",
        options: [
          {
            hint: "apps/web",
            label: "Marketing site",
            value: "marketing",
          },
          { hint: "apps/app", label: "App", value: "app" },
        ],
        required: true,
      })
    ),
  selectFramework: async () =>
    unwrapPrompt(
      await select<Framework>({
        initialValue: "next",
        message: "Framework",
        options: [
          { label: "Next.js", value: "next" },
          { label: "TanStack Start", value: "tanstack" },
        ],
      })
    ),
};
