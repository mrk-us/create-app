export type CliCommand =
  | {
      kind: "create";
      skipChecks: boolean;
      skipInstall: boolean;
      skipProvision: boolean;
      templatePath?: string;
    }
  | { kind: "resume"; path: string }
  | { kind: "help" }
  | { kind: "version" };

export const HELP_TEXT = `Usage: create-app [options]

Options:
  --template-path <path>  Use a local starter-boilerplate checkout
  --skip-install          Skip dependency installation and static checks
  --skip-checks           Install dependencies without running static checks
  --skip-provision        Generate provider files without creating resources
  --resume <path>         Resume provider setup in a generated project
  --help                  Show this help
  --version               Show the CLI version`;

const nextArgument = (args: string[], index: number, flag: string): string => {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
};

export const parseArgs = (args: string[]): CliCommand => {
  let templatePath: string | undefined;
  let skipInstall = false;
  let skipChecks = false;
  let skipProvision = false;
  let resumePath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--help":
      case "-h":
        return { kind: "help" };
      case "--version":
      case "-v":
        return { kind: "version" };
      case "--template-path":
        templatePath = nextArgument(args, index, argument);
        index += 1;
        break;
      case "--skip-install":
        skipInstall = true;
        break;
      case "--skip-checks":
        skipChecks = true;
        break;
      case "--skip-provision":
        skipProvision = true;
        break;
      case "--resume":
        resumePath = nextArgument(args, index, argument);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${argument ?? ""}`);
    }
  }

  if (resumePath) {
    if (templatePath || skipInstall || skipChecks || skipProvision) {
      throw new Error("--resume cannot be combined with generation options.");
    }
    return { kind: "resume", path: resumePath };
  }

  const command = {
    kind: "create",
    skipChecks: skipChecks || skipInstall,
    skipInstall,
    skipProvision: skipProvision || skipInstall,
    ...(templatePath ? { templatePath } : {}),
  } satisfies CliCommand;
  return command;
};
