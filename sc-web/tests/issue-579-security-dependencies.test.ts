import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(webRoot, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(webRoot, "package.json"), "utf8"),
);
const workspacePackageJson = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
);
const schemaToolsPackageJson = JSON.parse(
  fs.readFileSync(
    path.join(repositoryRoot, "docker/sc-web/schema-tools/package.json"),
    "utf8",
  ),
);
const homeSource = fs.readFileSync(path.join(webRoot, "app/page.tsx"), "utf8");
const ciWorkflow = fs.readFileSync(
  path.join(repositoryRoot, ".github/workflows/ci.yml"),
  "utf8",
);

describe("issue #579 security dependency baseline", () => {
  it("pins patched Next.js and Auth.js releases", () => {
    expect(packageJson.dependencies.next).toBe("15.5.21");
    expect(packageJson.dependencies["next-auth"]).toBe("5.0.0-beta.32");
  });

  it("forces patched Sharp and PostCSS transitive releases", () => {
    expect(workspacePackageJson.pnpm.overrides.sharp).toBe("0.35.3");
    expect(workspacePackageJson.pnpm.overrides.postcss).toBe("8.5.23");
  });

  it("forces patched build-tool transitive releases", () => {
    expect(workspacePackageJson.pnpm.overrides["brace-expansion"]).toBe("5.0.8");
    expect(workspacePackageJson.pnpm.overrides.esbuild).toBe("0.25.12");
  });

  it("keeps runtime schema tooling self-contained", () => {
    expect(schemaToolsPackageJson.dependencies["drizzle-kit"]).toBe("0.31.10");
    expect(schemaToolsPackageJson.dependencies["drizzle-orm"]).toBe("0.45.2");
    expect(schemaToolsPackageJson.dependencies.postgres).toBe("3.4.9");
  });

  it("pins CI to the lockfile generation pnpm release", () => {
    expect(ciWorkflow).toMatch(/name: Setup pnpm[\s\S]*?version: 10\.4\.1/);
  });

  it("does not treat an Auth.js error object as an authenticated home session", () => {
    expect(homeSource).toContain("if (!session?.user?.id)");
    expect(homeSource).not.toContain("if (!session) {");
  });
});
