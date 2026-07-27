/**
 * Verify that every CSS variable referenced in the codebase is defined
 * in globals.css, and that the design token source matches.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Collect all source files recursively (no glob dependency needed)
function collectFiles(dir: string, exts: string[]): string[] {
  const results: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          stack.push(full);
        }
      } else if (exts.some((ext) => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }
  return results;
}

// Parse all defined custom properties from globals.css
function parseDefinedTokens(): Set<string> {
  const css = readFileSync("app/globals.css", "utf8");
  const defined = new Set<string>();
  const re = /--([\w-]+)\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    defined.add(match[1]);
  }
  return defined;
}

// Find all var(--token) references in source files
function findReferencedTokens(): Map<string, string[]> {
  const cwd = process.cwd();
  const files = collectFiles(join(cwd, "components"), [".tsx", ".ts", ".css"])
    .concat(collectFiles(join(cwd, "app"), [".tsx", ".ts", ".css"]))
    .concat(collectFiles(join(cwd, "lib"), [".tsx", ".ts"]));

  const references = new Map<string, string[]>();
  const re = /var\(--([\w-]+)/g;

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const token = match[1];
      if (!references.has(token)) references.set(token, []);
      references.get(token)!.push(relative(cwd, file));
    }
  }
  return references;
}

describe("design tokens", () => {
  const defined = parseDefinedTokens();
  const referenced = findReferencedTokens();

  it("has no undefined CSS variable references", () => {
    const undefinedTokens: string[] = [];
    for (const [token, files] of referenced) {
      if (!defined.has(token)) {
        undefinedTokens.push(`${token} (${files.join(", ")})`);
      }
    }
    expect(
      undefinedTokens,
      `undefined CSS variables found. Add them to app/globals.css:\n${undefinedTokens.join("\n")}`,
    ).toEqual([]);
  });

  it("defines all required semantic variables", () => {
    const required = [
      "color-sky-deep", "color-sky-mid", "color-sky-high",
      "color-cloud", "color-cloud-dim",
      "color-accent", "color-accent-glow",
      "color-success", "color-warning", "color-error", "color-info",
      "color-successBg", "color-warningBg", "color-errorBg", "color-infoBg",
      "color-text-primary", "color-text-secondary", "color-text-dim",
      "color-surface-default", "color-surface-raised",
      "color-border-default",
      "space-0", "space-4", "space-6",
      "font-size-xs", "font-size-base", "font-size-h1",
      "font-mono", "font-sans",
    ];
    const missing = required.filter((t) => !defined.has(t));
    expect(missing).toEqual([]);
  });

  it("key token values match expected Metro theme", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const check = (name: string, expected: string) => {
      const re = new RegExp(`--${name.replace(/-/g, "\\-")}\\s*:\\s*([^;]+)`);
      const m = re.exec(css);
      expect(m, `--${name} should be defined`).not.toBeNull();
      expect(m![1].trim()).toBe(expected);
    };
    check("color-sky-deep", "#060b14");
    check("color-sky-mid", "#111827");
    check("color-sky-high", "#1a2236");
    check("color-cloud", "#e5e7eb");
    check("color-cloud-dim", "#9ca3b8");
    check("color-accent", "#38bdf8");
    check("color-success", "#4ade80");
    check("color-warning", "#facc15");
    check("color-error", "#f87171");
    check("space-6", "16px");
  });
});
