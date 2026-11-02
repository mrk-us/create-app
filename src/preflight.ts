import { semver } from "bun";
import { runCommand } from "./generate";

const SUPPORTED_NODE_VERSIONS = ">=24.15.0";
const NODE_VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)/;

interface NodeVersion {
  major: number;
  minor: number;
  patch: number;
}

export const parseNodeVersion = (value: string): NodeVersion | null => {
  const match = NODE_VERSION_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }

  const [, major, minor, patch] = match;
  if (!(major && minor && patch)) {
    return null;
  }

  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
  };
};

export const assertSupportedNodeVersion = (versionOutput: string): void => {
  const version = parseNodeVersion(versionOutput);
  if (!version) {
    throw new Error(
      `Unable to read the Node.js version from: ${versionOutput.trim()}`
    );
  }

  if (!semver.satisfies(versionOutput.trim(), SUPPORTED_NODE_VERSIONS)) {
    throw new Error(
      `Node.js 24.15.0 or newer is required. PATH currently resolves node to ${versionOutput.trim()}.\nActivate a supported Node.js version, verify with "node --version", then run create-app again.`
    );
  }
};

export const runPreflight = async (): Promise<void> => {
  let versionOutput: string;
  try {
    versionOutput = await runCommand({
      command: ["node", "--version"],
      cwd: process.cwd(),
    });
  } catch (error) {
    throw new Error(
      'Node.js 24.15.0 or newer must be available on PATH. Verify with "node --version".',
      { cause: error }
    );
  }

  assertSupportedNodeVersion(versionOutput);
};
