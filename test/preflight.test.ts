import { describe, expect, test } from "bun:test";
import { assertSupportedNodeVersion, parseNodeVersion } from "../src/preflight";

describe("Node.js preflight", () => {
  test("parses standard Node.js version output", () => {
    expect(parseNodeVersion("v22.16.0\n")).toEqual({
      major: 22,
      minor: 16,
      patch: 0,
    });
    expect(parseNodeVersion("not a version")).toBeNull();
  });

  test("accepts Node.js 22.11 and newer", () => {
    expect(() => assertSupportedNodeVersion("v22.11.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("v24.0.0")).not.toThrow();
  });

  test("rejects the Node.js 20 runtime that breaks Ultracite", () => {
    expect(() => assertSupportedNodeVersion("v20.19.5")).toThrow(
      "Node.js 22.11 or newer is required. PATH currently resolves node to v20.19.5."
    );
  });
});
