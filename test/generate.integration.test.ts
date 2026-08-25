import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Capability, Framework, ProjectRequest } from "../src/domain";
import { selectionId } from "../src/domain";
import {
  applyProjectNaming,
  assertDestinationAvailable,
  composeProject,
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
  test("recognizes the local template checkout", async () => {
    expect(await resolveTemplatePath(templateCheckout)).toBe(templateCheckout);
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
      templatePath: templateCheckout,
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
      templatePath: templateCheckout,
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
  });
});
