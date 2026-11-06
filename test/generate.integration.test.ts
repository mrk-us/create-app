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
  assertGeneratedProject,
  assertGitIdentity,
  assertOutsideParentWorkspace,
  checkoutTemplate,
  commitProject,
  composeProject,
  detectProjectSkillStack,
  isProjectPrepared,
  projectSkillCommands,
  resolveTemplatePath,
  runCommand,
  runSkillInstallations,
  TEMPLATE_COMMIT,
} from "../src/generate";
import { setupStatePath } from "../src/setup-files";

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
    const addSkill = (source: string): string =>
      `x --bun skills add ${source} --agent claude-code codex --yes`;
    const turborepoCommand = addSkill("vercel/turborepo");
    const nextjsCommand = addSkill("vercel/next.js");
    const convexCommand = "x --bun --no-install convex ai-files install";
    const emptyStack = {
      clerk: false,
      convex: false,
      nextjs: false,
      resend: false,
      stripe: false,
      workos: false,
    };

    expect(commandTexts(emptyStack)).toEqual([turborepoCommand]);
    expect(commandTexts({ ...emptyStack, nextjs: true })).toEqual([
      turborepoCommand,
      nextjsCommand,
    ]);
    expect(commandTexts({ ...emptyStack, clerk: true })).toEqual([
      turborepoCommand,
      addSkill("clerk/skills"),
    ]);
    expect(
      commandTexts({
        ...emptyStack,
        convex: true,
        resend: true,
        workos: true,
      })
    ).toEqual([
      turborepoCommand,
      convexCommand,
      addSkill("workos/skills"),
      addSkill("resend/resend-skills"),
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
      turborepoCommand,
      nextjsCommand,
      convexCommand,
      addSkill("workos/skills"),
      addSkill("https://docs.stripe.com"),
      addSkill("resend/resend-skills"),
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
    const checkout = await checkoutTemplate({
      commit: TEMPLATE_COMMIT,
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
      const rootPackage = JSON.parse(
        await readFile(join(destination, "package.json"), "utf8")
      );
      expect(rootPackage.engines.node).toBe(">=26.0.0");
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
    await runCommand({
      command: ["git", "symbolic-ref", "HEAD", "refs/heads/trunk"],
      cwd: destination,
    });

    expect(await commitProject(destination)).toBe("committed");
    expect(
      await runCommand({
        command: ["git", "branch", "--show-current"],
        cwd: destination,
      })
    ).toBe("main");
    expect(
      await runCommand({
        command: ["git", "log", "-1", "--format=%s"],
        cwd: destination,
      })
    ).toBe("init");
    expect(
      await runCommand({
        command: ["git", "rev-parse", "main"],
        cwd: destination,
      })
    ).toBe(
      await runCommand({
        command: ["git", "rev-parse", "production"],
        cwd: destination,
      })
    );
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

  test("inserts replacement patterns in a project name literally", async () => {
    const destination = join(outputRoot, "replacement-patterns");
    const displayName = "Cash $& Carry $1 $$ $` $'";
    const projectRequest = {
      ...request({
        capability: "plain",
        electron: true,
        framework: "next",
        marketing: false,
      }),
      displayName,
    };

    await composeProject({
      destination,
      request: projectRequest,
      templatePath: templateCheckout,
    });
    await applyProjectNaming({ destination, request: projectRequest });

    const contents = await Promise.all(
      [
        "README.md",
        "apps/desktop/electron-builder.yml",
        "packages/config/src/index.ts",
      ].map((path) => readFile(join(destination, path), "utf8"))
    );
    for (const content of contents) {
      expect(content).toContain(displayName);
    }
  });

  test("continues past a skill that fails to install", async () => {
    const destination = join(outputRoot, "skill-failures");
    await mkdir(destination, { recursive: true });
    const failing = [process.execPath, "-e", "process.exit(1)"];
    const missingOutput = [process.execPath, "-e", "process.exit(0)"];

    const failures = await runSkillInstallations(destination, [
      { command: failing, expectedPaths: [] },
      { command: missingOutput, expectedPaths: ["missing/SKILL.md"] },
      {
        command: [
          process.execPath,
          "-e",
          'await Bun.write("installed/SKILL.md", "")',
        ],
        expectedPaths: ["installed/SKILL.md"],
      },
    ]);

    expect(failures).toEqual([failing.join(" "), missingOutput.join(" ")]);
    expect(await exists(join(destination, "installed/SKILL.md"))).toBe(true);
  });

  test("commits only regenerated Convex files after the first commit", async () => {
    const destination = join(outputRoot, "regenerated-convex-files");
    const generatedFile = join(
      destination,
      "packages/backend/convex/_generated/api.d.ts"
    );
    const git = (...args: string[]): Promise<string> =>
      runCommand({ command: ["git", ...args], cwd: destination });
    await mkdir(join(destination, "packages/backend/convex/_generated"), {
      recursive: true,
    });
    await git("init");
    await git("config", "user.name", "create-app test");
    await git("config", "user.email", "create-app@example.com");
    await writeFile(generatedFile, "// first\n", "utf8");
    await writeFile(join(destination, "notes.md"), "first\n", "utf8");
    expect(await commitProject(destination)).toBe("committed");

    await writeFile(generatedFile, "// second\n", "utf8");
    await writeFile(join(destination, "notes.md"), "second\n", "utf8");
    expect(await commitProject(destination)).toBe("updated-generated-files");

    expect(await git("status", "--porcelain")).toBe("M notes.md");
    expect(await git("log", "-1", "--format=%s")).toBe(
      "chore: update Convex generated files"
    );
    expect(await git("log", "-1", "--format=%s", "production")).toBe("init");
    expect(await commitProject(destination)).toBe("already-initialized");
  });

  test("rejects a destination inside the nearest parent workspace", async () => {
    const root = join(outputRoot, "parent-workspaces");
    const writePackage = async (directory: string, contents: string) => {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, "package.json"), contents, "utf8");
    };
    const rejection = (path: string): Promise<string | undefined> =>
      assertOutsideParentWorkspace(join(root, path)).then(
        () => undefined,
        (error: Error) => error.message
      );
    await writePackage(
      ".",
      JSON.stringify({
        workspaces: {
          packages: [
            "apps/*",
            "!apps/skip",
            "./deep/**",
            "other/",
            "plain/*",
            "broken/*",
            "near/*/*",
          ],
        },
      })
    );
    await writePackage("plain", JSON.stringify({ name: "plain" }));
    await writePackage("broken", "{");
    await writePackage("near", JSON.stringify({ workspaces: ["pkg/*"] }));

    expect(await rejection("apps/foo")).toContain(`at ${root},`);
    expect(await rejection("deep/a/b")).toContain(`at ${root},`);
    expect(await rejection("other")).toContain(`at ${root},`);
    expect(await rejection("plain/foo")).toContain(`at ${root},`);
    expect(await rejection("broken/foo")).toContain(`at ${root},`);
    expect(await rejection("near/pkg/foo")).toContain(
      `at ${join(root, "near")},`
    );
    expect(await rejection("apps/skip")).toBeUndefined();
    expect(await rejection("unrelated/foo")).toBeUndefined();
    expect(await rejection("near/app/foo")).toBeUndefined();
  });

  test("reports a missing git identity with the commands that set it", async () => {
    const destination = join(outputRoot, "git-identity");
    const git = (...args: string[]): Promise<string> =>
      runCommand({ command: ["git", ...args], cwd: destination });
    await mkdir(destination, { recursive: true });
    await git("init");
    await git("config", "user.useConfigOnly", "true");
    await git("config", "user.name", "");
    await git("config", "user.email", "");

    await expect(assertGitIdentity(destination)).rejects.toThrow(
      "git config --global user.name"
    );

    await git("config", "user.name", "create-app test");
    await git("config", "user.email", "create-app@example.com");
    expect(await assertGitIdentity(destination)).toBeUndefined();
  });

  test("tells a generated project from a path that is not one", async () => {
    const destination = join(outputRoot, "resume-target");
    await expect(assertGeneratedProject(destination)).rejects.toThrow(
      `No generated project found at ${destination}.`
    );

    await composeProject({
      destination,
      request: request({
        capability: "plain",
        electron: false,
        framework: "next",
        marketing: false,
      }),
      templatePath: templateCheckout,
    });
    expect(await assertGeneratedProject(destination)).toBeUndefined();
  });

  test("treats a project as prepared after setup state or a commit exists", async () => {
    const destination = join(outputRoot, "prepared-project");
    const projectRequest = request({
      capability: "plain",
      electron: false,
      framework: "next",
      marketing: false,
    });
    await composeProject({
      destination,
      request: projectRequest,
      templatePath: templateCheckout,
    });
    expect(await isProjectPrepared(destination)).toBe(false);

    const statePath = setupStatePath(destination);
    await writeFile(statePath, "{}\n", "utf8");
    expect(await isProjectPrepared(destination)).toBe(true);
    await rm(statePath);

    await runCommand({
      command: ["git", "config", "user.name", "create-app test"],
      cwd: destination,
    });
    await runCommand({
      command: ["git", "config", "user.email", "create-app@example.com"],
      cwd: destination,
    });
    await commitProject(destination);
    expect(await isProjectPrepared(destination)).toBe(true);
  });
});
