export type AppChoice = "app" | "marketing";
export type Framework = "next" | "tanstack";
export type Capability = "plain" | "convex" | "auth" | "stripe";

export type ProjectSelection =
  | {
      kind: "marketing-only";
    }
  | {
      capability: Capability;
      electron: boolean;
      framework: Framework;
      kind: "product";
      marketing: boolean;
    };

export interface ProjectRequest {
  displayName: string;
  selection: ProjectSelection;
  slug: string;
}

export interface PromptClient {
  addAuth: () => Promise<boolean>;
  addDatabase: () => Promise<boolean>;
  addElectron: () => Promise<boolean>;
  addPayments: () => Promise<boolean>;
  projectName: () => Promise<string>;
  selectApps: () => Promise<AppChoice[]>;
  selectFramework: () => Promise<Framework>;
}

const SLUG_SEPARATOR_PATTERN = /[^a-z0-9]+/g;
const SLUG_EDGE_PATTERN = /^-+|-+$/g;

export const projectSlug = (displayName: string): string =>
  displayName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(SLUG_SEPARATOR_PATTERN, "-")
    .replace(SLUG_EDGE_PATTERN, "");

export const validateProjectName = (
  value: string | undefined
): string | undefined => {
  const displayName = value?.trim() ?? "";
  if (displayName.length === 0) {
    return "Enter a project name.";
  }
  if (projectSlug(displayName).length === 0) {
    return "Use at least one letter or number.";
  }
  return undefined;
};

const capabilityFromAnswers = ({
  auth,
  database,
  payments,
}: {
  auth: boolean;
  database: boolean;
  payments: boolean;
}): Capability => {
  if (payments) {
    return "stripe";
  }
  if (auth) {
    return "auth";
  }
  if (database) {
    return "convex";
  }
  return "plain";
};

export const collectProjectRequest = async (
  prompts: PromptClient
): Promise<ProjectRequest> => {
  const displayName = (await prompts.projectName()).trim();
  const slug = projectSlug(displayName);
  if (slug.length === 0) {
    throw new Error("Project name did not produce a valid folder name.");
  }

  const apps = await prompts.selectApps();
  const includesProductApp = apps.includes("app");
  const includesMarketing = apps.includes("marketing");

  if (!(includesProductApp || includesMarketing)) {
    throw new Error("Select at least one app.");
  }

  if (!includesProductApp) {
    return {
      displayName,
      selection: { kind: "marketing-only" },
      slug,
    };
  }

  const framework = await prompts.selectFramework();
  const auth = await prompts.addAuth();
  const database = auth ? true : await prompts.addDatabase();
  const payments = auth ? await prompts.addPayments() : false;
  const electron = await prompts.addElectron();

  return {
    displayName,
    selection: {
      capability: capabilityFromAnswers({ auth, database, payments }),
      electron,
      framework,
      kind: "product",
      marketing: includesMarketing,
    },
    slug,
  };
};

export const selectionId = (selection: ProjectSelection): string => {
  if (selection.kind === "marketing-only") {
    return "marketing-only";
  }

  const parts: string[] = [selection.framework, selection.capability];
  if (selection.marketing) {
    parts.push("marketing");
  }
  if (selection.electron) {
    parts.push("electron");
  }
  return parts.join("-");
};

export const requiredProviders = (selection: ProjectSelection): string[] => {
  if (selection.kind === "marketing-only") {
    return [];
  }

  switch (selection.capability) {
    case "plain":
      return [];
    case "convex":
      return ["Convex"];
    case "auth":
      return ["Convex", "WorkOS", "Resend"];
    case "stripe":
      return ["Convex", "WorkOS", "Resend", "Stripe"];
    default: {
      const exhaustive: never = selection.capability;
      return exhaustive;
    }
  }
};
