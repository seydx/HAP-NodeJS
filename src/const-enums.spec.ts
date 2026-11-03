import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Run with tsx rather than tsc, so a const enum here is a normal enum and the lookups work
const IGNORED_FILES = ['src/lib/definitions/generate-definitions.ts']

/**
 * A `const enum` has no object at runtime unless the file using it can reach one. tsc inlines
 * `HAPStatus.SUCCESS` as a number, so that is always fine, but `HAPStatus[status]` or
 * `Object.values(HAPStatus)` need the real object. `preserveConstEnums` still emits it in the
 * declaring file, but tsc drops a const enum from every `import` line in an ES module build, so in
 * any other file the name is undefined and the code throws a ReferenceError.
 *
 * Vitest compiles with esbuild, which treats a const enum like a normal enum and keeps the import,
 * so no other test can see this. This walks the real TypeScript program instead.
 */
function findConstEnumValueUses(): string[] {
  const root = path.resolve(import.meta.dirname, '..')
  const configPath = path.join(root, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const checker = program.getTypeChecker()
  const problems: string[] = []

  for (const sourceFile of program.getSourceFiles()) {
    const fileName = path.relative(root, sourceFile.fileName).split(path.sep).join('/')
    if (!fileName.startsWith('src/') || fileName.endsWith('.spec.ts') || IGNORED_FILES.includes(fileName)) {
      continue
    }

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && isValueUse(node)) {
        let symbol = checker.getSymbolAtLocation(node)
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
          symbol = checker.getAliasedSymbol(symbol)
        }
        const declaration = symbol?.declarations?.[0]
        if (symbol && symbol.flags & ts.SymbolFlags.ConstEnum && declaration && declaration.getSourceFile() !== sourceFile) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
          problems.push(`${fileName}:${line + 1} uses the const enum ${node.text} as a value`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  return problems
}

/**
 * True when the identifier is read as a runtime value - anything except `Enum.Member`, which tsc
 * inlines, and the places that are only types or names.
 */
function isValueUse(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return false
  }
  if (ts.isQualifiedName(parent) || ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent)) {
    return false
  }
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isEnumDeclaration(parent)) {
    return false
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false
  }
  return true
}

describe('const enums', () => {
  it('are never used as a runtime value outside the file that declares them', () => {
    expect(findConstEnumValueUses()).toEqual([])
  }, 60000)
})
