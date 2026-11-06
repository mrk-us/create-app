import {
  type CANCEL_SYMBOL,
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

const unwrapPrompt = <Value>(value: Value | typeof CANCEL_SYMBOL): Value => {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    throw new PromptCancelledError();
  }
  return value;
};

// A prompt waits forever when stdin cannot answer it. Runs that ask nothing, such
// as a finished resume, still work without a terminal.
export const requireTerminal = <Prompts extends object>(
  prompts: Prompts
): Prompts =>
  new Proxy(prompts, {
    get: (target, property, receiver) => {
      if (!process.stdin.isTTY) {
        throw new Error(
          "create-app needs to ask a question, but no interactive terminal is available. Run it in a terminal."
        );
      }
      return Reflect.get(target, property, receiver);
    },
  });

export const clackPrompts: PromptClient = requireTerminal({
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
});
