import { describe, expect, test } from "bun:test";
import {
  collectProjectRequest,
  type PromptClient,
  projectSlug,
  requiredProviders,
  selectionId,
  validateProjectName,
} from "../src/domain";

interface PromptAnswers {
  apps: Awaited<ReturnType<PromptClient["selectApps"]>>;
  auth: boolean;
  database: boolean;
  electron: boolean;
  framework: Awaited<ReturnType<PromptClient["selectFramework"]>>;
  name: string;
  payments: boolean;
}

const promptClient = (
  answers: PromptAnswers,
  calls: string[]
): PromptClient => ({
  addAuth: () => {
    calls.push("auth");
    return Promise.resolve(answers.auth);
  },
  addDatabase: () => {
    calls.push("database");
    return Promise.resolve(answers.database);
  },
  addElectron: () => {
    calls.push("electron");
    return Promise.resolve(answers.electron);
  },
  addPayments: () => {
    calls.push("payments");
    return Promise.resolve(answers.payments);
  },
  projectName: () => {
    calls.push("name");
    return Promise.resolve(answers.name);
  },
  selectApps: () => {
    calls.push("apps");
    return Promise.resolve(answers.apps);
  },
  selectFramework: () => {
    calls.push("framework");
    return Promise.resolve(answers.framework);
  },
});

const defaultAnswers = {
  apps: ["app"],
  auth: false,
  database: false,
  electron: false,
  framework: "next",
  name: "Acme Books",
  payments: false,
} satisfies PromptAnswers;

describe("project names", () => {
  test("derives a package-safe slug", () => {
    expect(projectSlug("  Ácme & Sons  ")).toBe("acme-sons");
    expect(projectSlug("Hello___World")).toBe("hello-world");
  });

  test("returns actionable validation messages", () => {
    expect(validateProjectName(" ")).toBe("Enter a project name.");
    expect(validateProjectName("---")).toBe(
      "Use at least one letter or number."
    );
    expect(validateProjectName("Acme Books")).toBeUndefined();
  });
});

describe("prompt flow", () => {
  test("stops after apps for a marketing-only project", async () => {
    const calls: string[] = [];
    const request = await collectProjectRequest(
      promptClient({ ...defaultAnswers, apps: ["marketing"] }, calls)
    );

    expect(request).toEqual({
      displayName: "Acme Books",
      selection: { kind: "marketing-only" },
      slug: "acme-books",
    });
    expect(calls).toEqual(["name", "apps"]);
  });

  test("auth adds Convex and skips the database question", async () => {
    const calls: string[] = [];
    const request = await collectProjectRequest(
      promptClient(
        {
          ...defaultAnswers,
          apps: ["marketing", "app"],
          auth: true,
          electron: true,
          framework: "tanstack",
          payments: true,
        },
        calls
      )
    );

    expect(request.selection).toEqual({
      capability: "stripe",
      electron: true,
      framework: "tanstack",
      kind: "product",
      marketing: true,
    });
    expect(calls).toEqual([
      "name",
      "apps",
      "framework",
      "auth",
      "payments",
      "electron",
    ]);
  });

  test("Stripe is never asked for without auth", async () => {
    const calls: string[] = [];
    const request = await collectProjectRequest(
      promptClient({ ...defaultAnswers, database: true }, calls)
    );

    expect(request.selection).toEqual({
      capability: "convex",
      electron: false,
      framework: "next",
      kind: "product",
      marketing: false,
    });
    expect(calls).toEqual([
      "name",
      "apps",
      "framework",
      "auth",
      "database",
      "electron",
    ]);
  });
});

describe("composer mapping", () => {
  test("maps selections to template IDs", () => {
    expect(selectionId({ kind: "marketing-only" })).toBe("marketing-only");
    expect(
      selectionId({
        capability: "stripe",
        electron: true,
        framework: "tanstack",
        kind: "product",
        marketing: true,
      })
    ).toBe("tanstack-stripe-marketing-electron");
  });

  test("reports only providers required by the selection", () => {
    expect(requiredProviders({ kind: "marketing-only" })).toEqual([]);
    expect(
      requiredProviders({
        capability: "convex",
        electron: false,
        framework: "next",
        kind: "product",
        marketing: false,
      })
    ).toEqual(["Convex"]);
    expect(
      requiredProviders({
        capability: "stripe",
        electron: false,
        framework: "next",
        kind: "product",
        marketing: false,
      })
    ).toEqual(["Convex", "WorkOS", "Resend", "Stripe"]);
  });
});
