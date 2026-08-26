import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveSync, spawn } from "bun";
import type { ProjectRequest } from "./domain";
import { selectionId } from "./domain";

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

const APP_NAME_DECLARATION_PATTERN = /^export const APP_NAME = .*;$/m;
const APP_DESCRIPTION_DECLARATION_PATTERN =
  /^export const APP_DESCRIPTION = .*;$/m;
const README_TITLE_PATTERN = /^# Starter monorepo$/m;
const ELECTRON_PRODUCT_NAME_PATTERN = /^productName: Starter$/m;
export const TEMPLATE_COMMIT = "5e4f8ad5c214366e293839ee7941b565a4fad2a2";
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
    const detail = stderr.trim() || stdout.trim() || "No command output.";
    throw new Error(`${command.join(" ")} failed.\n${detail}`);
  }

  return stdout.trim();
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
  return contents.replace(pattern, replacement);
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
    desktopPackage.productName = request.displayName;
    await writeJsonObject(desktopPackagePath, desktopPackage);

    const electronBuilderPath = join(
      destination,
      "apps/desktop/electron-builder.yml"
    );
    const electronBuilder = await readFile(electronBuilderPath, "utf8");
    await writeFile(
      electronBuilderPath,
      replaceRequired({
        contents: electronBuilder,
        label: "Electron product name",
        pattern: ELECTRON_PRODUCT_NAME_PATTERN,
        replacement: `productName: ${JSON.stringify(request.displayName)}`,
      }),
      "utf8"
    );
    formattedPaths.push("apps/desktop/package.json");
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
