import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const desktopRoot = resolve(import.meta.dirname, "../src/desktop");

function desktopSourceFiles(directory = desktopRoot): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return desktopSourceFiles(path);
    return /\.(?:ts|cts)$/.test(name) ? [normalize(path)] : [];
  });
}

function relativeImports(source: string): string[] {
  const staticPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^"';()]+?\s+from\s+)?["'](\.[^"']+)["']/g;
  const dynamicPattern = /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g;
  return [...source.matchAll(staticPattern), ...source.matchAll(dynamicPattern)].map((match) => match[1]);
}

function resolveDesktopImport(importer: string, specifier: string, files: Set<string>): string | null {
  const base = normalize(resolve(dirname(importer), specifier));
  const candidates = specifier.endsWith(".js")
    ? [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".cts")]
    : [base, `${base}.ts`, `${base}.cts`, join(base, "index.ts")];
  return candidates.find((candidate) => files.has(normalize(candidate))) ?? null;
}

function desktopImportGraph(): Map<string, string[]> {
  const sources = desktopSourceFiles();
  const files = new Set(sources);
  return new Map(sources.map((source) => [
    source,
    relativeImports(readFileSync(source, "utf8"))
      .map((specifier) => resolveDesktopImport(source, specifier, files))
      .filter((dependency): dependency is string => dependency !== null),
  ]));
}

function importPathExists(graph: Map<string, string[]>, from: string, target: string): boolean {
  const pending = [from];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const dependency of graph.get(current) ?? []) {
      if (dependency === target) return true;
      pending.push(dependency);
    }
  }
  return false;
}

describe("desktop module dependency contracts", () => {
  const graph = desktopImportGraph();
  const main = normalize(resolve(desktopRoot, "main.ts"));
  const webView = normalize(resolve(desktopRoot, "web-view-runtime.ts"));
  const immersiveNavigation = normalize(resolve(desktopRoot, "overlays/immersive-navigation-window.ts"));

  it("keeps extracted desktop modules independent from main.ts", () => {
    const offenders = [...graph.entries()]
      .filter(([source, dependencies]) => source !== main && dependencies.includes(main))
      .map(([source]) => relative(desktopRoot, source));
    expect(offenders).toEqual([]);
  });

  it("keeps native WebView Escape handling as a one-way immersive-navigation edge", () => {
    expect(graph.get(webView)).toContain(immersiveNavigation);
    expect(importPathExists(graph, immersiveNavigation, webView)).toBe(false);
  });
});
