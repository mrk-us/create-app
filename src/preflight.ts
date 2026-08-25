import { runCommand } from "./generate";

const MINIMUM_NODE_MAJOR = 22;
const MINIMUM_NODE_MINOR = 11;
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

  const meetsMinimum =
    version.major > MINIMUM_NODE_MAJOR ||
    (version.major === MINIMUM_NODE_MAJOR &&
      version.minor >= MINIMUM_NODE_MINOR);
  if (!meetsMinimum) {
    throw new Error(
      `Node.js 22.11 or newer is required. PATH currently resolves node to ${versionOutput.trim()}.\nActivate Node.js 22, verify with "node --version", then run create-app again.`
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
      'Node.js 22.11 or newer must be available on PATH. Verify with "node --version".',
      { cause: error }
    );
  }

  assertSupportedNodeVersion(versionOutput);
};
