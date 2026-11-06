#!/usr/bin/env bun

import { resolve } from "node:path";
import { cancel, intro, log, note, outro, spinner } from "@clack/prompts";
import packageJson from "../package.json" with { type: "json" };
import { HELP_TEXT, parseArgs } from "./args";
import { clackPrompts, PromptCancelledError } from "./clack-prompts";
import {
  collectProjectRequest,
  requiredProviders,
  selectionId,
} from "./domain";
import {
  applyProjectNaming,
  assertDestinationAvailable,
  assertGeneratedProject,
  assertGitIdentity,
  assertOutsideParentWorkspace,
  type CommitProjectResult,
  checkProject,
  commitProject,
  composeProject,
  installProject,
  installProjectSkills,
  isProjectPrepared,
  resolveTemplate,
  typecheckProject,
} from "./generate";
import { runPreflight } from "./preflight";
import { clackProviderPrompts } from "./provider-prompts";
import { provisionProject } from "./provision";
import type { SetupState } from "./setup-files";

const writeLine = (value: string): void => {
  process.stdout.write(`${value}\n`);
};

interface TaskDefinition {
  enabled?: boolean;
  run: () => Promise<string>;
  title: string;
}

const runTasks = async (definitions: TaskDefinition[]): Promise<void> => {
  const [definition, ...remainingDefinitions] = definitions;
  if (!definition) {
    return;
  }

  if (definition.enabled !== false) {
    const taskSpinner = spinner();
    taskSpinner.start(definition.title);
    try {
      taskSpinner.stop(await definition.run());
    } catch (error) {
      taskSpinner.error(`${definition.title} failed`);
      throw error;
    }
  }

  await runTasks(remainingDefinitions);
};

const resumeCommand = (destination: string): string =>
  `bunx @mrk-us/create-app --resume ${destination}`;

const withResumeHint = async <Result>(
  destination: string,
  work: () => Promise<Result>
): Promise<Result> => {
  try {
    return await work();
  } catch (error) {
    const hint = `Resume with: ${resumeCommand(destination)}`;
    if (error instanceof PromptCancelledError) {
      cancel(`${error.message}\n${hint}`);
      throw error;
    }
    const message =
      error instanceof Error ? error.message : "Project setup failed.";
    throw new Error(`${message}\n${hint}`, { cause: error });
  }
};

const runProviderSetup = (destination: string): Promise<SetupState | null> =>
  provisionProject({
    destination,
    prompts: clackProviderPrompts,
    report: (message) => log.step(message),
  });

const installTask = (destination: string, enabled = true): TaskDefinition => ({
  enabled,
  run: async () => {
    await installProject(destination);
    return "Installed dependencies";
  },
  title: "Installing dependencies",
});

const prepareProject = async (
  destination: string,
  { checks, install }: { checks: boolean; install: boolean }
): Promise<void> => {
  let skillFailures: string[] = [];
  await runTasks([
    installTask(destination, install),
    {
      enabled: checks,
      run: async () => {
        await checkProject(destination);
        return "Passed Ultracite";
      },
      title: "Checking code",
    },
    {
      enabled: checks,
      run: async () => {
        await typecheckProject(destination);
        return "Passed typechecking";
      },
      title: "Typechecking workspaces",
    },
    {
      enabled: install,
      run: async () => {
        skillFailures = await installProjectSkills(destination);
        return skillFailures.length > 0
          ? "Some project skills were not installed"
          : "Installed project skills";
      },
      title: "Installing project skills",
    },
  ]);
  if (skillFailures.length > 0) {
    log.warn(
      `Setup continues without them. To try again, run these from the project directory:\n${skillFailures.join("\n")}`
    );
  }
};

const COMMIT_RESULTS: Record<CommitProjectResult, string> = {
  "already-initialized": "Initial commit already exists",
  committed: "Committed init",
  "updated-generated-files": "Committed updated Convex generated files",
};

const commitTask = (destination: string, enabled = true): TaskDefinition => ({
  enabled,
  run: async () => COMMIT_RESULTS[await commitProject(destination)],
  title: "Creating initial commit",
});

const printProviderNotes = (state: SetupState | null): void => {
  if (state?.completedStages.includes("workos.webhook")) {
    note(
      "The app sends the verification and password reset emails from its webhook. In the WorkOS Dashboard, go to Emails > Configuration, select Manage, and turn off the default email verification and password reset emails. If they stay on, users get two emails for each event.\n\nhttps://workos.com/docs/authkit/custom-emails",
      "Turn off the WorkOS default emails"
    );
  }
  if (state?.providers?.workos) {
    note(
      "WorkOS Actions are not configured. Setup generated a private placeholder so development can start. If you enable Actions later, replace WORKOS_ACTION_SECRET in packages/backend/.env.local and the Convex deployment with the Action signing secret from WorkOS.\n\nhttps://workos.com/docs/authkit/actions",
      "Optional WorkOS Actions"
    );
  }
  const stripe = state?.providers?.stripe;
  if (stripe?.claimUrl && !stripe.claimed) {
    note(
      `${stripe.claimUrl}\n\nbunx @stripe/cli@1.50.5 sandbox claim --project-name ${stripe.profileName}`,
      "Claim the Stripe sandbox"
    );
  }
  if (state?.providers?.resend?.fromEmail === "onboarding@resend.dev") {
    note(
      "The Resend test sender can only deliver to the email address associated with your Resend account. Configure a verified domain before sending to other recipients.",
      "Resend test sender"
    );
  }
};

const selectionSummary = (
  request: Awaited<ReturnType<typeof collectProjectRequest>>
): string => {
  const { selection } = request;
  if (selection.kind === "marketing-only") {
    return `Project: ${request.displayName}\nApps: Marketing site`;
  }

  const framework =
    selection.framework === "next" ? "Next.js" : "TanStack Start";
  const capabilities = [
    selection.capability === "plain" ? null : "Convex",
    selection.capability === "auth" || selection.capability === "stripe"
      ? "WorkOS and Resend"
      : null,
    selection.capability === "stripe" ? "Stripe" : null,
    selection.electron ? "Electron" : null,
  ].filter((value): value is string => value !== null);
  const apps = ["App", selection.marketing ? "Marketing site" : null].filter(
    (value): value is string => value !== null
  );
  return [
    `Project: ${request.displayName}`,
    `Apps: ${apps.join(", ")}`,
    `Framework: ${framework}`,
    `Capabilities: ${capabilities.join(", ") || "None"}`,
  ].join("\n");
};

const run = async (): Promise<void> => {
  const command = parseArgs(process.argv.slice(2));
  if (command.kind === "help") {
    writeLine(HELP_TEXT);
    return;
  }
  if (command.kind === "version") {
    writeLine(packageJson.version);
    return;
  }

  await runPreflight();
  if (command.kind === "resume") {
    const destination = resolve(command.path);
    intro("create-app provider setup");
    await assertGeneratedProject(destination);
    const state = await withResumeHint(destination, async () => {
      await assertGitIdentity(destination);
      if (await isProjectPrepared(destination)) {
        // The dependencies can be gone even when setup already started.
        await runTasks([installTask(destination)]);
      } else {
        await prepareProject(destination, { checks: true, install: true });
      }
      const providerState = await runProviderSetup(destination);
      await runTasks([commitTask(destination)]);
      return providerState;
    });
    printProviderNotes(state);
    note(`cd ${destination}\nbun run dev`, "Next steps");
    outro(
      state
        ? `Provider setup complete for ${state.project.displayName}`
        : `${destination} has no provider setup to resume.`
    );
    return;
  }

  intro("create-app");

  const request = await collectProjectRequest(clackPrompts);
  const destination = resolve(process.cwd(), request.slug);
  await assertDestinationAvailable(destination);
  await assertOutsideParentWorkspace(destination);
  note(selectionSummary(request), "Project configuration");

  const templateSpinner = spinner();
  templateSpinner.start("Loading template");
  const template = await resolveTemplate(command.templatePath).catch(
    (error) => {
      templateSpinner.error("Loading template failed");
      throw error;
    }
  );
  templateSpinner.stop(
    template.source === "remote"
      ? "Downloaded pinned template"
      : "Using local template"
  );

  try {
    await runTasks([
      {
        run: async () => {
          await composeProject({
            destination,
            request,
            templatePath: template.path,
          });
          return `Composed ${selectionId(request.selection)}`;
        },
        title: "Creating project files",
      },
      {
        run: async () => {
          await applyProjectNaming({ destination, request });
          return `Named ${request.displayName}`;
        },
        title: "Applying project name",
      },
    ]);
  } finally {
    await template.cleanup();
  }

  const providers = requiredProviders(request.selection);
  await withResumeHint(destination, async () => {
    if (!command.skipInstall) {
      await assertGitIdentity(destination);
    }
    await prepareProject(destination, {
      checks: !command.skipChecks,
      install: !command.skipInstall,
    });

    if (providers.length > 0 && command.skipProvision) {
      note(
        `Provider setup was skipped. Resume it with:\n\n${resumeCommand(destination)}`,
        "Provider setup skipped"
      );
    } else if (providers.length > 0) {
      printProviderNotes(await runProviderSetup(destination));
    }

    await runTasks([commitTask(destination, !command.skipInstall)]);
  });

  const needsResume =
    command.skipInstall || (providers.length > 0 && command.skipProvision);
  note(
    [
      ...(needsResume ? [resumeCommand(destination)] : []),
      `cd ${request.slug}`,
      "bun run dev",
    ].join("\n"),
    "Next steps"
  );
  outro(`Created ${request.displayName}`);
};

try {
  await run();
} catch (error) {
  if (error instanceof PromptCancelledError) {
    process.exitCode = 0;
  } else {
    log.error(
      error instanceof Error ? error.message : "Unable to create project."
    );
    process.exitCode = 1;
  }
}
