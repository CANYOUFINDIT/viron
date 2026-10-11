import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { serverRuntimePackageRoots, stageServerRuntimeDependencies } from "../scripts/server-runtime-dependencies.mjs";

const temps: string[] = [];
afterEach(() => { for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "viron-server-deps-"));
  temps.push(projectRoot);
  const outputDirectory = join(projectRoot, "runtime");
  const install = (path: string, manifest: object, files: Record<string, string> = {}) => {
    const directory = join(projectRoot, "node_modules", path);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(directory, name, ".."), { recursive: true });
      writeFileSync(join(directory, name), content);
    }
  };
  return { projectRoot, outputDirectory, install };
}

describe("server runtime dependency selection", () => {
  it("keeps nested versions, scoped dependencies, peers and native assets while excluding unrelated packages", () => {
    const { install, ...options } = fixture();
    install("server", { dependencies: { shared: "1", "@scope/plugin": "1" }, optionalDependencies: { "missing-platform-binary": "1", optional: "1" }, peerDependencies: { peer: "1", "missing-optional-peer": "1" }, peerDependenciesMeta: { "missing-optional-peer": { optional: true } } }, { "build/Release/addon.node": "native", "assets/font.ttf": "font" });
    install("shared", { version: "1", dependencies: { server: "1" } });
    install("@scope/plugin", { dependencies: { shared: "2" } });
    install("@scope/plugin/node_modules/shared", { version: "2" });
    install("server/node_modules/unused", {});
    for (const name of ["peer", "optional", "frontend"]) install(name, {});
    const packages = stageServerRuntimeDependencies({ ...options, packageRoots: ["server"] });
    expect(packages.map((path: string) => path.split(sep).join("/"))).toEqual(["@scope/plugin", "@scope/plugin/node_modules/shared", "optional", "peer", "server", "shared"]);
    expect(readFileSync(join(options.outputDirectory, "server/build/Release/addon.node"), "utf8")).toBe("native");
    expect(readFileSync(join(options.outputDirectory, "server/assets/font.ttf"), "utf8")).toBe("font");
    expect(JSON.parse(readFileSync(join(options.outputDirectory, "@scope/plugin/node_modules/shared/package.json"), "utf8")).version).toBe("2");
    expect(existsSync(join(options.outputDirectory, "frontend"))).toBe(false);
    expect(existsSync(join(options.outputDirectory, "server/node_modules/unused"))).toBe(false);
    install("server", {});
    stageServerRuntimeDependencies({ ...options, packageRoots: ["server"] });
    expect(existsSync(join(options.outputDirectory, "shared"))).toBe(false);
    expect(existsSync(join(options.projectRoot, "node_modules/frontend/package.json"))).toBe(true);
  });

  it.each(["dependencies", "peerDependencies"])("fails before changing output when a required %s package is absent", (field) => {
    const { install, ...options } = fixture();
    install("server", { [field]: { missing: "1" } });
    mkdirSync(options.outputDirectory);
    writeFileSync(join(options.outputDirectory, "sentinel"), "keep");
    expect(() => stageServerRuntimeDependencies({ ...options, packageRoots: ["server"] })).toThrow("missing");
    expect(readFileSync(join(options.outputDirectory, "sentinel"), "utf8")).toBe("keep");
  });

  it("rejects output directories that would destroy the source dependencies", () => {
    const { projectRoot } = fixture();
    for (const outputDirectory of [projectRoot, join(projectRoot, "node_modules"), join(projectRoot, "node_modules/runtime")]) {
      expect(() => stageServerRuntimeDependencies({ projectRoot, outputDirectory, packageRoots: [] })).toThrow("不能覆盖");
    }
  });

  it("covers every runtime package imported by server and shared source files", () => {
    const imported = new Set<string>();
    const add = (specifier: string) => {
      if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return;
      imported.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);
    };
    const scan = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { scan(path); continue; }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
        const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node) => {
          if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const clause = node.importClause;
            const typeOnly = clause?.isTypeOnly || (!clause?.name && clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly));
            if (!typeOnly) add(node.moduleSpecifier.text);
          } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            add(node.moduleSpecifier.text);
          } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
            add(node.arguments[0].text);
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    };
    scan(fileURLToPath(new URL("../src/server", import.meta.url)));
    scan(fileURLToPath(new URL("../src/shared", import.meta.url)));
    expect([...imported].filter((name) => !serverRuntimePackageRoots.includes(name))).toEqual([]);
    expect(imported.size).toBeGreaterThan(20);
  });
});
