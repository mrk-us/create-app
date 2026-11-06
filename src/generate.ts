import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Glob, resolveSync, spawn } from "bun";
import type { ProjectRequest } from "./domain";
import { selectionId } from "./domain";
import { setupStatePath } from "./setup-files";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonObject | JsonPrimitive | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

export interface GenerateProjectOptions {
  destination: string;
  request: ProjectRequest;
  runChecks: boolean;
  runInstall: boolean;
  templatePath: string;
}

export interface TemplateCheckout {
  cleanup: () => Promise<void>;
  path: string;
  source: "local" | "remote";
}

export interface TemplateSource {
  commit: string;
  repositoryUrl: string;
}

interface CommandOptions {
  command: string[];
  cwd: string;
}

interface SkillInstallation {
  command: string[];
  expectedPaths: string[];
}

export interface ProjectSkillStack {
  clerk: boolean;
  convex: boolean;
  nextjs: boolean;
  resend: boolean;
  stripe: boolean;
  workos: boolean;
}

export type CommitProjectResult =
  | "already-initialized"
  | "committed"
  | "updated-generated-files";

const APP_NAME_DECLARATION_PATTERN = /^export const APP_NAME = .*;$/m;
const APP_DESCRIPTION_DECLARATION_PATTERN =
  /^export const APP_DESCRIPTION = .*;$/m;
const BILLING_CONSTANTS_PATH = "packages/backend/convex/billing/constants.ts";
const STRIPE_LOOKUP_KEY_PATTERN = /"(pro_(?:monthly|yearly))"/g;
const README_TITLE_PATTERN = /^# Starter monorepo$/m;
const ELECTRON_APP_ID_PATTERN = /^appId: com\.starter\.app$/m;
const ELECTRON_PRODUCT_NAME_PATTERN = /^productName: Starter$/m;
const WORKSPACE_PATTERN_EDGE_PATTERN = /^\.\/|\/$/g;
const CONVEX_GENERATED_PATH = "packages/backend/convex/_generated";
const PACKAGE_DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const PROJECT_PACKAGE_PATHS = [
  "package.json",
  join("apps", "app", "package.json"),
  join("apps", "web", "package.json"),
  join("packages", "backend", "package.json"),
  join("packages", "email", "package.json"),
];
export const TEMPLATE_COMMIT = "0ef17563793d2b4391e7a501f4f5dd5960325692";
const DEFAULT_TEMPLATE_SOURCE = {
  commit: TEMPLATE_COMMIT,
  repositoryUrl: "https://github.com/mrk-us/starter-boilerplate.git",
} satisfies TemplateSource;

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const biomeBinaryPath = (): string =>
  resolveSync("@biomejs/biome/bin/biome", import.meta.dir);
const biomeFormatConfigPath = (): string =>
  join(PACKAGE_ROOT, "biome.format.json");

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonObject = async (path: string): Promise<JsonObject> => {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isJsonObject(value)) {
    throw new Error(`Expected a JSON object in ${path}.`);
  }
  return value;
};

const writeJsonObject = async (
  path: string,
  value: JsonObject
): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const pathExists = async (path: string): Promise<boolean> => {
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

export const runCommand = async ({
  command,
  cwd,
}: CommandOptions): Promise<string> => {
  const subprocess = spawn(command, {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);

  if (exitCode !== 0) {
    const commandOutput = [stdout.trim(), stderr.trim()]
      .filter((output) => output.length > 0)
      .join("\n");
    const detail = commandOutput || "No command output.";
    throw new Error(`${command.join(" ")} failed.\n${detail}`);
  }

  return stdout.trim();
};

// With no agent list, a HOME with no agent directory installs for every agent.
// Claude Code links to the .agents/skills copy that Codex reads directly.
const addSkillsCommand = (source: string): string[] => [
  process.execPath,
  "x",
  "--bun",
  "skills",
  "add",
  source,
  "--agent",
  "claude-code",
  "codex",
  "--yes",
];

const turborepoSkillInstallation = (): SkillInstallation => ({
  command: addSkillsCommand("vercel/turborepo"),
  expectedPaths: [join(".agents", "skills", "turborepo", "SKILL.md")],
});

const nextjsSkillInstallation = (): SkillInstallation => ({
  command: addSkillsCommand("vercel/next.js"),
  expectedPaths: [
    join(".agents", "skills", "next-cache-components-adoption", "SKILL.md"),
    join(".agents", "skills", "next-cache-components-optimizer", "SKILL.md"),
    join(".agents", "skills", "next-dev-loop", "SKILL.md"),
    join(".agents", "skills", "next-partial-prefetching-adoption", "SKILL.md"),
  ],
});

const convexSkillInstallation = (): SkillInstallation => ({
  command: [
    process.execPath,
    "x",
    "--bun",
    "--no-install",
    "convex",
    "ai-files",
    "install",
  ],
  expectedPaths: [
    join("packages", "backend", "convex", "_generated", "ai", "guidelines.md"),
  ],
});

const workosSkillInstallation = (): SkillInstallation => ({
  command: addSkillsCommand("workos/skills"),
  expectedPaths: [join(".agents", "skills", "workos", "SKILL.md")],
});

const clerkSkillInstallation = (): SkillInstallation => ({
  command: addSkillsCommand("clerk/skills"),
  expectedPaths: [join(".agents", "skills", "clerk", "SKILL.md")],
});

const stripeSkillInstallation = (): SkillInstallation => ({
  command: addSkillsCommand("https://docs.stripe.com"),
  expectedPaths: [
    join(".agents", "skills", "stripe-best-practices", "SKILL.md"),
  ],
});

const resendSkillInstallation = (): SkillInstallation => ({
  command: addSkillsCommand("resend/resend-skills"),
  expectedPaths: [join(".agents", "skills", "resend", "SKILL.md")],
});

const projectSkillInstallations = (
  stack: ProjectSkillStack
): SkillInstallation[] => {
  const installations = [turborepoSkillInstallation()];
  if (stack.nextjs) {
    installations.push(nextjsSkillInstallation());
  }
  if (stack.convex) {
    installations.push(convexSkillInstallation());
  }
  if (stack.workos) {
    installations.push(workosSkillInstallation());
  }
  if (stack.clerk) {
    installations.push(clerkSkillInstallation());
  }
  if (stack.stripe) {
    installations.push(stripeSkillInstallation());
  }
  if (stack.resend) {
    installations.push(resendSkillInstallation());
  }
  return installations;
};

export const projectSkillCommands = (stack: ProjectSkillStack): string[][] =>
  projectSkillInstallations(stack).map(({ command }) => command);

const dependencyNames = (packageJson: JsonObject): string[] =>
  PACKAGE_DEPENDENCY_SECTIONS.flatMap((section) => {
    const dependencies = packageJson[section];
    return isJsonObject(dependencies) ? Object.keys(dependencies) : [];
  });

export const detectProjectSkillStack = async (
  destination: string
): Promise<ProjectSkillStack> => {
  const packageJsons = await Promise.all(
    PROJECT_PACKAGE_PATHS.map(async (relativePath) => {
      const packagePath = join(destination, relativePath);
      return (await pathExists(packagePath))
        ? await readJsonObject(packagePath)
        : null;
    })
  );
  const packageNames = new Set<string>();
  for (const packageJson of packageJsons) {
    if (!packageJson) {
      continue;
    }
    for (const packageName of dependencyNames(packageJson)) {
      packageNames.add(packageName);
    }
  }

  return {
    clerk: [...packageNames].some((name) => name.startsWith("@clerk/")),
    convex: packageNames.has("convex"),
    nextjs: packageNames.has("next"),
    resend:
      packageNames.has("resend") ||
      packageNames.has("@convex-dev/resend") ||
      [...packageNames].some((name) => name.startsWith("@resend/")),
    stripe:
      packageNames.has("stripe") ||
      packageNames.has("@convex-dev/stripe") ||
      [...packageNames].some((name) => name.startsWith("@stripe/")),
    workos: [...packageNames].some((name) => name.startsWith("@workos-inc/")),
  };
};

const runSkillInstallation = async (
  destination: string,
  installation: SkillInstallation
): Promise<void> => {
  await runCommand({ command: installation.command, cwd: destination });
  const missingPaths = (
    await Promise.all(
      installation.expectedPaths.map(async (expectedPath) => ({
        exists: await pathExists(join(destination, expectedPath)),
        expectedPath,
      }))
    )
  ).filter(({ exists }) => !exists);
  if (missingPaths.length > 0) {
    throw new Error(
      `${installation.command.join(" ")} did not install ${missingPaths
        .map(({ expectedPath }) => expectedPath)
        .join(", ")}.`
    );
  }
};

/** Skills are optional, so a failure is returned as a command to retry. */
export const runSkillInstallations = async (
  destination: string,
  installations: SkillInstallation[]
): Promise<string[]> => {
  const [installation, ...remainingInstallations] = installations;
  if (!installation) {
    return [];
  }

  const failures = await runSkillInstallation(destination, installation).then(
    () => [],
    () => [installation.command.join(" ")]
  );
  return [
    ...failures,
    ...(await runSkillInstallations(destination, remainingInstallations)),
  ];
};

export const installProjectSkills = async (
  destination: string
): Promise<string[]> => {
  const stack = await detectProjectSkillStack(destination);
  return await runSkillInstallations(
    destination,
    projectSkillInstallations(stack)
  );
};

export const assertGitIdentity = async (destination: string): Promise<void> => {
  try {
    await runCommand({
      command: ["git", "var", "GIT_AUTHOR_IDENT"],
      cwd: destination,
    });
    await runCommand({
      command: ["git", "var", "GIT_COMMITTER_IDENT"],
      cwd: destination,
    });
  } catch (error) {
    throw new Error(
      'Git needs your name and email to create the initial commit. Set them with:\ngit config --global user.name "Your Name"\ngit config --global user.email "you@example.com"',
      { cause: error }
    );
  }
};

const countCommits = (destination: string): Promise<string> =>
  runCommand({
    command: ["git", "rev-list", "--all", "--count"],
    cwd: destination,
  });

/**
 * Installs, checks, and skills finish before provider setup writes its state,
 * and the first commit comes after all of them.
 */
export const isProjectPrepared = async (
  destination: string
): Promise<boolean> =>
  (await pathExists(setupStatePath(destination))) ||
  (await countCommits(destination)) !== "0";

// Provider setup can regenerate these tracked files after the first commit.
const commitConvexGeneratedFiles = async (
  destination: string
): Promise<CommitProjectResult> => {
  const status = await runCommand({
    command: ["git", "status", "--porcelain", "--", CONVEX_GENERATED_PATH],
    cwd: destination,
  });
  if (status.length === 0) {
    return "already-initialized";
  }

  await runCommand({
    command: ["git", "add", "--", CONVEX_GENERATED_PATH],
    cwd: destination,
  });
  await runCommand({
    command: [
      "git",
      "commit",
      "--no-verify",
      "--message",
      "chore: update Convex generated files",
      "--",
      CONVEX_GENERATED_PATH,
    ],
    cwd: destination,
  });
  return "updated-generated-files";
};

export const commitProject = async (
  destination: string
): Promise<CommitProjectResult> => {
  if ((await countCommits(destination)) !== "0") {
    return await commitConvexGeneratedFiles(destination);
  }

  const status = await runCommand({
    command: ["git", "status", "--porcelain"],
    cwd: destination,
  });
  if (status.length === 0) {
    throw new Error("The generated repository has no files to commit.");
  }

  await runCommand({
    command: ["git", "symbolic-ref", "HEAD", "refs/heads/main"],
    cwd: destination,
  });
  await runCommand({ command: ["git", "add", "--all"], cwd: destination });
  await runCommand({
    command: ["git", "commit", "--no-verify", "--message", "init"],
    cwd: destination,
  });
  await runCommand({
    command: ["git", "branch", "production", "main"],
    cwd: destination,
  });
  return "committed";
};

const validateTemplatePath = async (templatePath: string): Promise<string> => {
  const requiredPaths = [
    ".starter/compose.ts",
    ".starter/manifest.json",
    "package.json",
  ];
  const pathResults = await Promise.all(
    requiredPaths.map(async (requiredPath) => ({
      exists: await pathExists(join(templatePath, requiredPath)),
      requiredPath,
    }))
  );
  const missingPath = pathResults.find((result) => !result.exists);
  if (missingPath) {
    throw new Error(
      `Template checkout is missing ${missingPath.requiredPath}: ${templatePath}`
    );
  }

  await runCommand({
    command: ["git", "rev-parse", "--is-inside-work-tree"],
    cwd: templatePath,
  });
  return templatePath;
};

export const resolveTemplatePath = async (
  explicitPath?: string
): Promise<string> => {
  const configuredPath = explicitPath ?? process.env.CREATE_APP_TEMPLATE_PATH;
  if (!configuredPath) {
    throw new Error("No local template checkout configured.");
  }
  return await validateTemplatePath(resolve(configuredPath));
};

export const checkoutTemplate = async (
  source: TemplateSource = DEFAULT_TEMPLATE_SOURCE
): Promise<TemplateCheckout> => {
  const templatePath = await mkdtemp(join(tmpdir(), "create-app-template-"));
  try {
    await runCommand({
      command: ["git", "init", "--quiet"],
      cwd: templatePath,
    });
    await runCommand({
      command: ["git", "remote", "add", "origin", source.repositoryUrl],
      cwd: templatePath,
    });
    await runCommand({
      command: ["git", "fetch", "--depth=1", "origin", source.commit],
      cwd: templatePath,
    });
    await runCommand({
      command: ["git", "checkout", "--detach", "--quiet", "FETCH_HEAD"],
      cwd: templatePath,
    });
    const resolvedCommit = await runCommand({
      command: ["git", "rev-parse", "HEAD"],
      cwd: templatePath,
    });
    if (resolvedCommit !== source.commit) {
      throw new Error(
        `Template commit mismatch. Expected ${source.commit}, received ${resolvedCommit}.`
      );
    }
    await validateTemplatePath(templatePath);
    return {
      cleanup: async () =>
        await rm(templatePath, { force: true, recursive: true }),
      path: templatePath,
      source: "remote",
    };
  } catch (error) {
    await rm(templatePath, { force: true, recursive: true });
    const detail = error instanceof Error ? error.message : "Unknown error.";
    throw new Error(
      `Unable to download template commit ${source.commit}.\n${detail}`,
      { cause: error }
    );
  }
};

export const resolveTemplate = async (
  explicitPath?: string
): Promise<TemplateCheckout> => {
  const configuredPath = explicitPath ?? process.env.CREATE_APP_TEMPLATE_PATH;
  if (!configuredPath) {
    return await checkoutTemplate();
  }
  return {
    cleanup: () => Promise.resolve(),
    path: await validateTemplatePath(resolve(configuredPath)),
    source: "local",
  };
};

export const assertDestinationAvailable = async (
  destination: string
): Promise<void> => {
  if (await pathExists(destination)) {
    throw new Error(`Destination already exists: ${destination}`);
  }
};

export const assertGeneratedProject = async (
  destination: string
): Promise<void> => {
  if (!(await pathExists(join(destination, ".starter/preset.json")))) {
    throw new Error(
      `No generated project found at ${destination}. Check the path and try again.`
    );
  }
};

const readWorkspacePatterns = async (
  directory: string
): Promise<string[] | null> => {
  try {
    const { workspaces } = await readJsonObject(
      join(directory, "package.json")
    );
    const patterns = isJsonObject(workspaces)
      ? workspaces.packages
      : workspaces;
    return Array.isArray(patterns)
      ? patterns
          .filter((pattern) => typeof pattern === "string")
          .map((pattern) => pattern.replace(WORKSPACE_PATTERN_EDGE_PATTERN, ""))
      : null;
  } catch {
    return null;
  }
};

const workspaceCovers = (patterns: string[], path: string): boolean => {
  const matches = (pattern: string): boolean => new Glob(pattern).match(path);
  return (
    patterns.some((pattern) => !pattern.startsWith("!") && matches(pattern)) &&
    !patterns.some(
      (pattern) => pattern.startsWith("!") && matches(pattern.slice(1))
    )
  );
};

// Bun only considers the nearest ancestor that declares workspaces.
export const assertOutsideParentWorkspace = async (
  destination: string,
  directory = dirname(destination)
): Promise<void> => {
  const patterns = await readWorkspacePatterns(directory);
  if (patterns) {
    if (workspaceCovers(patterns, relative(directory, destination))) {
      throw new Error(
        `${destination} is inside the Bun workspace at ${directory}, so bun install would fail. Run create-app outside that workspace, or remove the matching entry from "workspaces" in its package.json.`
      );
    }
    return;
  }

  const parent = dirname(directory);
  if (parent !== directory) {
    await assertOutsideParentWorkspace(destination, parent);
  }
};

export const composeProject = async ({
  destination,
  request,
  templatePath,
}: Pick<
  GenerateProjectOptions,
  "destination" | "request" | "templatePath"
>): Promise<void> => {
  await runCommand({
    command: [
      process.execPath,
      join(templatePath, ".starter/compose.ts"),
      "--id",
      selectionId(request.selection),
      "--out",
      destination,
      "--biome-bin",
      biomeBinaryPath(),
      "--biome-config",
      biomeFormatConfigPath(),
    ],
    cwd: templatePath,
  });
};

const replaceRequired = ({
  contents,
  label,
  pattern,
  replacement,
}: {
  contents: string;
  label: string;
  pattern: RegExp;
  replacement: string;
}): string => {
  if (!pattern.test(contents)) {
    throw new Error(`Unable to find ${label} while applying project name.`);
  }
  return contents.replace(pattern, () => replacement);
};

// Stripe lookup keys are unique per account, so an app with other pricing would
// collide with an earlier app on that account unless each app has its own keys.
const namespaceStripeLookupKeys = async (
  path: string,
  slug: string
): Promise<void> => {
  const contents = await readFile(path, "utf8");
  if (contents.match(STRIPE_LOOKUP_KEY_PATTERN)?.length !== 2) {
    throw new Error(`Unable to find the Stripe lookup keys in ${path}.`);
  }
  await writeFile(
    path,
    contents.replace(STRIPE_LOOKUP_KEY_PATTERN, `"${slug}_$1"`),
    "utf8"
  );
};

export const applyProjectNaming = async ({
  destination,
  request,
}: Pick<GenerateProjectOptions, "destination" | "request">): Promise<void> => {
  const rootPackagePath = join(destination, "package.json");
  const rootPackage = await readJsonObject(rootPackagePath);
  rootPackage.name = request.slug;
  await writeJsonObject(rootPackagePath, rootPackage);

  const presetPath = join(destination, ".starter/preset.json");
  const preset = await readJsonObject(presetPath);
  preset.project = {
    displayName: request.displayName,
    slug: request.slug,
  };
  await writeJsonObject(presetPath, preset);

  const configPath = join(destination, "packages/config/src/index.ts");
  let config = await readFile(configPath, "utf8");
  config = replaceRequired({
    contents: config,
    label: "APP_NAME declaration",
    pattern: APP_NAME_DECLARATION_PATTERN,
    replacement: `export const APP_NAME = ${JSON.stringify(request.displayName)};`,
  });
  config = replaceRequired({
    contents: config,
    label: "APP_DESCRIPTION declaration",
    pattern: APP_DESCRIPTION_DECLARATION_PATTERN,
    replacement: `export const APP_DESCRIPTION = ${JSON.stringify(`${request.displayName} application.`)};`,
  });
  await writeFile(configPath, config, "utf8");

  const readmePath = join(destination, "README.md");
  const readme = await readFile(readmePath, "utf8");
  await writeFile(
    readmePath,
    replaceRequired({
      contents: readme,
      label: "README title",
      pattern: README_TITLE_PATTERN,
      replacement: `# ${request.displayName}`,
    }),
    "utf8"
  );

  const desktopPackagePath = join(destination, "apps/desktop/package.json");
  const formattedPaths = [
    ".starter/preset.json",
    "package.json",
    "packages/config/src/index.ts",
  ];
  if (await pathExists(desktopPackagePath)) {
    const desktopPackage = await readJsonObject(desktopPackagePath);
    desktopPackage.author = request.displayName;
    desktopPackage.productName = request.displayName;
    await writeJsonObject(desktopPackagePath, desktopPackage);

    const electronBuilderPath = join(
      destination,
      "apps/desktop/electron-builder.yml"
    );
    const electronBuilder = await readFile(electronBuilderPath, "utf8");
    const electronBuilderWithAppId = replaceRequired({
      contents: electronBuilder,
      label: "Electron app ID",
      pattern: ELECTRON_APP_ID_PATTERN,
      // The Windows installer derives its GUID from this ID, so two apps that
      // share it install over each other
      replacement: `appId: com.${request.slug}.app`,
    });
    await writeFile(
      electronBuilderPath,
      replaceRequired({
        contents: electronBuilderWithAppId,
        label: "Electron product name",
        pattern: ELECTRON_PRODUCT_NAME_PATTERN,
        replacement: `productName: ${JSON.stringify(request.displayName)}`,
      }),
      "utf8"
    );
    formattedPaths.push("apps/desktop/package.json");
  }

  const billingConstantsPath = join(destination, BILLING_CONSTANTS_PATH);
  if (await pathExists(billingConstantsPath)) {
    await namespaceStripeLookupKeys(billingConstantsPath, request.slug);
    await namespaceStripeLookupKeys(presetPath, request.slug);
    formattedPaths.push(BILLING_CONSTANTS_PATH);
  }

  await runCommand({
    command: [
      biomeBinaryPath(),
      "format",
      "--write",
      "--config-path",
      biomeFormatConfigPath(),
      ...formattedPaths,
    ],
    cwd: destination,
  });
};

export const installProject = async (destination: string): Promise<void> => {
  await runCommand({
    command: [process.execPath, "install"],
    cwd: destination,
  });
};

export const checkProject = async (destination: string): Promise<void> => {
  await runCommand({
    command: [process.execPath, "run", "check"],
    cwd: destination,
  });
};

export const typecheckProject = async (destination: string): Promise<void> => {
  await runCommand({
    command: [process.execPath, "run", "typecheck"],
    cwd: destination,
  });
};
