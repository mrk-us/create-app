import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/args";

describe("CLI arguments", () => {
  test("uses the interactive defaults", () => {
    expect(parseArgs([])).toEqual({
      kind: "create",
      skipChecks: false,
      skipInstall: false,
      skipProvision: false,
    });
  });

  test("accepts local development controls", () => {
    expect(
      parseArgs(["--template-path", "/tmp/template", "--skip-install"])
    ).toEqual({
      kind: "create",
      skipChecks: true,
      skipInstall: true,
      skipProvision: true,
      templatePath: "/tmp/template",
    });
  });

  test("handles informational commands", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
  });

  test("accepts provider controls", () => {
    expect(parseArgs(["--skip-provision"])).toEqual({
      kind: "create",
      skipChecks: false,
      skipInstall: false,
      skipProvision: true,
    });
    expect(parseArgs(["--resume", "./acme-books"])).toEqual({
      kind: "resume",
      path: "./acme-books",
    });
    expect(() => parseArgs(["--resume", "./acme", "--skip-checks"])).toThrow(
      "--resume cannot be combined with generation options."
    );
  });

  test("rejects incomplete and unknown options", () => {
    expect(() => parseArgs(["--template-path"])).toThrow(
      "--template-path requires a value."
    );
    expect(() => parseArgs(["--wat"])).toThrow("Unknown option: --wat");
  });
});
