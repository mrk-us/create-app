import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnvFile } from "../src/setup-files";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true }))
  );
});

describe("environment files", () => {
  test("removes Convex inline comments from unquoted values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "create-app-env-"));
    temporaryDirectories.push(directory);
    const path = join(directory, ".env.local");
    await writeFile(
      path,
      [
        "CONVEX_DEPLOYMENT=dev:peaceful-poodle-533 # team: hi-mrk-us, project: cunt",
        'QUOTED="value # retained"',
        "",
      ].join("\n"),
      "utf8"
    );

    expect(await readEnvFile(path)).toEqual({
      CONVEX_DEPLOYMENT: "dev:peaceful-poodle-533",
      QUOTED: "value # retained",
    });
  });
});
