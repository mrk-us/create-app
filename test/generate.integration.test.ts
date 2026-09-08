import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Capability, Framework, ProjectRequest } from "../src/domain";
import { selectionId } from "../src/domain";
import {
  applyProjectNaming,
  assertDestinationAvailable,
  checkoutTemplate,
  commitProject,
  composeProject,
  detectProjectSkillStack,
  projectSkillCommands,
  resolveTemplatePath,
  runCommand,
} from "../src/generate";

const templateCheckout = resolve(import.meta.dir, "../../starter-boilerplate");
let outputRoot = "";

const exists = async (path: string): Promise<boolean> => {
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

const request = ({
  capability,
  electron,
  framework,
  marketing,
}: {
  capability: Capability;
  electron: boolean;
  framework: Framework;
  marketing: boolean;
}): ProjectRequest => ({
  displayName: 'Acme "Books"',
  selection: {
    capability,
    electron,
    framework,
    kind: "product",
    marketing,
  },
  slug: "acme-books",
});

beforeAll(async () => {
  outputRoot = await mkdtemp(join(tmpdir(), "create-app-integration-"));
});

afterAll(async () => {
  await rm(outputRoot, { force: true, recursive: true });
});

describe("template integration", () => {
  test("builds skill commands from the selected architecture", () => {
    const commandTexts = (stack: Parameters<typeof projectSkillCommands>[0]) =>
      projectSkillCommands(stack).map((command) => command.slice(1).join(" "));
    const coreCommand =
      "x --bun skills add mrk-us/skills --skill add-component-reference choose-library laws-of-ux microcopy organize-files park-that --yes";
    const turborepoCommand = "x --bun skills add vercel/turborepo --yes";
    const nextjsCommand = "x --bun skills add vercel/next.js --yes";
    const convexCommand = "x --bun --no-install convex ai-files install";
    const emptyStack = {
      clerk: false,
      convex: false,
      nextjs: false,
      resend: false,
      stripe: false,
      workos: false,
    };

    expect(commandTexts(emptyStack)).toEqual([coreCommand, turborepoCommand]);
    expect(commandTexts({ ...emptyStack, nextjs: true })).toEqual([
      coreCommand,
      turborepoCommand,
      nextjsCommand,
    ]);
    expect(commandTexts({ ...emptyStack, clerk: true })).toEqual([
      coreCommand,
      turborepoCommand,
      "x --bun skills add clerk/skills --yes",
    ]);
    expect(
      commandTexts({
        ...emptyStack,
        convex: true,
        resend: true,
        workos: true,
      })
    ).toEqual([
      coreCommand,
      turborepoCommand,
      convexCommand,
      "x --bun skills add workos/skills --yes",
      "x --bun skills add resend/resend-skills --yes",
    ]);
    expect(
      commandTexts({
        clerk: false,
        convex: true,
        nextjs: true,
        resend: true,
        stripe: true,
        workos: true,
      })
    ).toEqual([
      coreCommand,
      turborepoCommand,
      nextjsCommand,
      convexCommand,
      "x --bun skills add workos/skills --yes",
      "x --bun skills add https://docs.stripe.com --yes",
      "x --bun skills add resend/resend-skills --yes",
    ]);
  });

  test("detects Clerk from generated package dependencies", async () => {
    const destination = join(outputRoot, "clerk-stack");
    await mkdir(join(destination, "apps/app"), { recursive: true });
    await writeFile(
      join(destination, "package.json"),
      `${JSON.stringify({ devDependencies: { turbo: "^2.0.0" } })}\n`,
      "utf8"
    );
    await writeFile(
      join(destination, "apps/app/package.json"),
      `${JSON.stringify({ dependencies: { "@clerk/nextjs": "^7.0.0", convex: "^1.0.0" } })}\n`,
      "utf8"
    );

    expect(await detectProjectSkillStack(destination)).toEqual({
      clerk: true,
      convex: true,
      nextjs: false,
      resend: false,
      stripe: false,
      workos: false,
    });
  });

  test("detects Next.js in app and marketing workspaces", async () => {
    const nextDestinations = await Promise.all(
      ["app", "web"].map(async (workspace) => {
        const destination = join(outputRoot, `next-${workspace}-stack`);
        await mkdir(join(destination, "apps", workspace), { recursive: true });
        await writeFile(
          join(destination, "package.json"),
          `${JSON.stringify({ devDependencies: { turbo: "^2.0.0" } })}\n`,
          "utf8"
        );
        await writeFile(
          join(destination, `apps/${workspace}/package.json`),
          `${JSON.stringify({ dependencies: { next: "16.0.0" } })}\n`,
          "utf8"
        );
        return destination;
      })
    );
    const nextDetections = await Promise.all(
      nextDestinations.map((destination) =>
        detectProjectSkillStack(destination)
      )
    );
    expect(nextDetections.every(({ nextjs }) => nextjs)).toBe(true);

    const tanstackDestination = join(outputRoot, "tanstack-only-stack");
    await mkdir(join(tanstackDestination, "apps/app"), { recursive: true });
    await writeFile(
      join(tanstackDestination, "package.json"),
      `${JSON.stringify({ devDependencies: { turbo: "^2.0.0" } })}\n`,
      "utf8"
    );
    await writeFile(
      join(tanstackDestination, "apps/app/package.json"),
      `${JSON.stringify({ dependencies: { "@tanstack/react-start": "^1.0.0" } })}\n`,
      "utf8"
    );

    expect((await detectProjectSkillStack(tanstackDestination)).nextjs).toBe(
      false
    );
  });

  test("preserves stdout and stderr when a command fails", async () => {
    let commandError: Error | undefined;
    try {
      await runCommand({
        command: [
          process.execPath,
          "-e",
          'console.log("compiler diagnostic"); console.error("runner summary"); process.exit(1)',
        ],
        cwd: outputRoot,
      });
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      commandError = error;
    }

    expect(commandError?.message).toContain("compiler diagnostic");
    expect(commandError?.message).toContain("runner summary");
  });

  test("recognizes the local template checkout", async () => {
    expect(await resolveTemplatePath(templateCheckout)).toBe(templateCheckout);
  });

  test("checks out and composes from an exact template commit", async () => {
    const commit = await runCommand({
      command: ["git", "rev-parse", "HEAD"],
      cwd: templateCheckout,
    });
    const checkout = await checkoutTemplate({
      commit,
      repositoryUrl: templateCheckout,
    });
    const destination = join(outputRoot, "downloaded-next-plain");
    try {
      expect(await exists(join(checkout.path, "node_modules"))).toBe(false);
      await composeProject({
        destination,
        request: request({
          capability: "plain",
          electron: false,
          framework: "next",
          marketing: false,
        }),
        templatePath: checkout.path,
      });
      expect(await exists(join(destination, "apps/app/package.json"))).toBe(
        true
      );
    } finally {
      await checkout.cleanup();
    }
    expect(await exists(checkout.path)).toBe(false);
  });

  test("the CLI selection IDs match the complete template matrix", async () => {
    const capabilities: Capability[] = ["plain", "convex", "auth", "stripe"];
    const frameworks: Framework[] = ["next", "tanstack"];
    const ids = new Set(["marketing-only"]);
    for (const framework of frameworks) {
      for (const capability of capabilities) {
        for (const marketing of [false, true]) {
          for (const electron of [false, true]) {
            ids.add(
              selectionId({
                capability,
                electron,
                framework,
                kind: "product",
                marketing,
              })
            );
          }
        }
      }
    }

    const templateIds = (
      await runCommand({
        command: [
          process.execPath,
          join(templateCheckout, ".starter/compose.ts"),
          "--list",
        ],
        cwd: templateCheckout,
      })
    ).split("\n");
    expect([...ids].sort()).toEqual(templateIds.sort());
    expect(ids.size).toBe(33);
  });

  test("composes and names a clean non-Electron project", async () => {
    const destination = join(outputRoot, "next-plain-marketing");
    const projectRequest = request({
      capability: "plain",
      electron: false,
      framework: "next",
      marketing: true,
    });

    await assertDestinationAvailable(destination);
    await composeProject({
      destination,
      request: projectRequest,
      templatePath: templateCheckout,
    });
    await applyProjectNaming({
      destination,
      request: projectRequest,
    });

    const rootPackage = JSON.parse(
      await readFile(join(destination, "package.json"), "utf8")
    );
    const preset = JSON.parse(
      await readFile(join(destination, ".starter/preset.json"), "utf8")
    );
    const config = await readFile(
      join(destination, "packages/config/src/index.ts"),
      "utf8"
    );
    expect(rootPackage.name).toBe("acme-books");
    expect(preset.project).toEqual({
      displayName: 'Acme "Books"',
      slug: "acme-books",
    });
    expect(config).toContain(`APP_NAME = 'Acme "Books"'`);
    expect(await exists(join(destination, "apps/desktop"))).toBe(false);
    expect(
      await runCommand({
        command: ["git", "rev-list", "--all", "--count"],
        cwd: destination,
      })
    ).toBe("0");

    const exampleSkillPath = join(
      destination,
      ".agents/skills/example/SKILL.md"
    );
    await mkdir(join(destination, ".agents/skills/example"), {
      recursive: true,
    });
    await writeFile(exampleSkillPath, "# Example\n", "utf8");
    await runCommand({
      command: ["git", "config", "user.name", "create-app test"],
      cwd: destination,
    });
    await runCommand({
      command: ["git", "config", "user.email", "create-app@example.com"],
      cwd: destination,
    });

    expect(await commitProject(destination)).toBe("committed");
    expect(
      await runCommand({
        command: ["git", "log", "-1", "--format=%s"],
        cwd: destination,
      })
    ).toBe("init");
    expect(
      await runCommand({
        command: ["git", "status", "--porcelain"],
        cwd: destination,
      })
    ).toBe("");
    expect(
      await runCommand({
        command: ["git", "ls-files", ".agents/skills/example/SKILL.md"],
        cwd: destination,
      })
    ).toBe(".agents/skills/example/SKILL.md");
    expect(await commitProject(destination)).toBe("already-initialized");
  });

  test("preserves Electron and applies its product name", async () => {
    const destination = join(outputRoot, "tanstack-auth-electron");
    const projectRequest = request({
      capability: "auth",
      electron: true,
      framework: "tanstack",
      marketing: false,
    });

    await composeProject({
      destination,
      request: projectRequest,
      templatePath: templateCheckout,
    });
    await applyProjectNaming({
      destination,
      request: projectRequest,
    });

    const desktopPackage = JSON.parse(
      await readFile(join(destination, "apps/desktop/package.json"), "utf8")
    );
    const electronBuilder = await readFile(
      join(destination, "apps/desktop/electron-builder.yml"),
      "utf8"
    );
    expect(desktopPackage.productName).toBe('Acme "Books"');
    expect(electronBuilder).toContain('productName: "Acme \\"Books\\""');
    expect(await detectProjectSkillStack(destination)).toEqual({
      clerk: false,
      convex: true,
      nextjs: false,
      resend: true,
      stripe: false,
      workos: true,
    });
  });
});
