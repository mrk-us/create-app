import { describe, expect, test } from "bun:test";
import { version as bunVersion } from "bun";
import {
  assertSupportedBunVersion,
  assertSupportedNodeVersion,
  parseNodeVersion,
} from "../src/preflight";

describe("Bun preflight", () => {
  test("accepts the running Bun release and newer ones", () => {
    for (const version of [bunVersion, "99.0.0"]) {
      expect(() => assertSupportedBunVersion(version)).not.toThrow();
    }
  });

  test("rejects a Bun release older than the engines range", () => {
    expect(() => assertSupportedBunVersion("1.3.14")).toThrow(
      "This run uses Bun 1.3.14."
    );
  });
});

describe("Node.js preflight", () => {
  test("parses standard Node.js version output", () => {
    expect(parseNodeVersion("v22.16.0\n")).toEqual({
      major: 22,
      minor: 16,
      patch: 0,
    });
    expect(parseNodeVersion("not a version")).toBeNull();
  });

  test("accepts supported Node.js releases", () => {
    for (const version of ["v26.0.0", "v26.13.0", "v27.0.0"]) {
      expect(() => assertSupportedNodeVersion(version)).not.toThrow();
    }
  });

  test("rejects releases outside the supported Node.js range", () => {
    for (const version of [
      "v20.19.5",
      "v22.23.2",
      "v23.11.1",
      "v24.15.0",
      "v24.20.0",
      "v25.9.0",
    ]) {
      expect(() => assertSupportedNodeVersion(version)).toThrow(
        "Node.js 26.0.0 or newer is required."
      );
    }
  });
});
