/**
 * Acorn-based Code Validator
 *
 * Performs static analysis on JavaScript/TypeScript to detect forbidden constructs.
 * Uses regex patterns for fast initial screening, then AST for precise validation.
 */
import * as acorn from "acorn"
import * as walk from "acorn-walk"
import { Effect, Layer } from "effect"

import type { ValidationWarning } from "../errors.ts"
import { ValidationError } from "../errors.ts"
import { CodeValidator } from "../services.ts"
import type { SandboxConfig, ValidationResult } from "../types.ts"

interface AcornLocation {
  line: number
  column: number
}

// Use a permissive type for AST nodes since acorn-walk has strict types

type AnyNode = any

function getLineColumn(code: string, index: number): { line: number; column: number } {
  const beforeMatch = code.slice(0, index)
  const lines = beforeMatch.split("\n")
  const lastLine = lines[lines.length - 1]
  return {
    line: lines.length,
    column: lastLine ? lastLine.length : 0
  }
}

export const AcornValidatorLive = Layer.succeed(
  CodeValidator,
  CodeValidator.of({
    validate: (code: string, config: SandboxConfig): Effect.Effect<ValidationResult, never> =>
      Effect.sync(() => {
        const errors: Array<ValidationError> = []
        const warnings: Array<ValidationWarning> = []

        // Phase 1: Fast regex check for forbidden patterns
        for (const pattern of config.forbiddenPatterns) {
          const match = code.match(pattern)
          if (match && match.index !== undefined) {
            const loc = getLineColumn(code, match.index)
            errors.push(
              new ValidationError({
                type: "forbidden_construct",
                _message: `Forbidden pattern detected: ${pattern.source}`,
                location: loc
              })
            )
          }
        }

        // Phase 2: Parse AST
        let ast: acorn.Node
        try {
          ast = acorn.parse(code, {
            ecmaVersion: 2022,
            sourceType: "module",
            locations: true,
            allowAwaitOutsideFunction: true
          })
        } catch (e) {
          const err = e as Error & { loc?: AcornLocation }
          errors.push(
            new ValidationError({
              type: "syntax",
              _message: err.message,
              location: err.loc ? { line: err.loc.line, column: err.loc.column } : undefined,
              cause: err
            })
          )
          return { valid: false, errors, warnings }
        }

        // Phase 3: Collect all declared identifiers
        const declaredIdentifiers = new Set<string>()

        const addIdentifier = (name: string): void => {
          declaredIdentifiers.add(name)
        }

        const collectDestructuredIds = (node: AnyNode): void => {
          if (!node) return
          if (node.type === "Identifier" && node.name) {
            addIdentifier(node.name)
          } else if (node.type === "ObjectPattern" && node.properties) {
            for (const prop of node.properties) {
              if (prop.value?.type === "Identifier" && prop.value.name) {
                addIdentifier(prop.value.name)
              } else if (prop.key?.type === "Identifier" && prop.shorthand && prop.key.name) {
                addIdentifier(prop.key.name)
              } else if (prop.value) {
                collectDestructuredIds(prop.value)
              }
              // Handle rest element in object pattern
              if (prop.type === "RestElement" && prop.argument?.type === "Identifier") {
                addIdentifier(prop.argument.name)
              }
            }
          } else if (node.type === "ArrayPattern" && node.elements) {
            for (const el of node.elements) {
              if (el) {
                collectDestructuredIds(el)
              }
            }
          } else if (node.type === "AssignmentPattern" && node.left) {
            collectDestructuredIds(node.left)
          } else if (node.type === "RestElement") {
            if (node.argument) {
              collectDestructuredIds(node.argument)
            }
          }
        }

        // First pass: collect declarations using type-safe walker with any casts
        walk.simple(ast, {
          VariableDeclarator(node: AnyNode) {
            if (node.id) {
              collectDestructuredIds(node.id)
            }
          },
          FunctionDeclaration(node: AnyNode) {
            if (node.id?.name) addIdentifier(node.id.name)
            if (node.params) {
              for (const p of node.params) {
                collectDestructuredIds(p)
              }
            }
          },
          FunctionExpression(node: AnyNode) {
            if (node.params) {
              for (const p of node.params) {
                collectDestructuredIds(p)
              }
            }
          },
          ArrowFunctionExpression(node: AnyNode) {
            if (node.params) {
              for (const p of node.params) {
                collectDestructuredIds(p)
              }
            }
          },
          ClassDeclaration(node: AnyNode) {
            if (node.id?.name) addIdentifier(node.id.name)
          },
          CatchClause(node: AnyNode) {
            if (node.param) {
              collectDestructuredIds(node.param)
            }
          }
        } as walk.SimpleVisitors<unknown>)

        // Always allow 'ctx' - it's our injected context
        declaredIdentifiers.add("ctx")
        // Allow module/exports for CommonJS output
        declaredIdentifiers.add("module")
        declaredIdentifiers.add("exports")
        // Allow 'undefined'
        declaredIdentifiers.add("undefined")

        // Phase 4: Check for forbidden constructs
        walk.simple(ast, {
          MemberExpression(node: AnyNode) {
            const dangerousProps = [
              "constructor",
              "__proto__",
              "__defineGetter__",
              "__defineSetter__",
              "__lookupGetter__",
              "__lookupSetter__"
            ]
            const propName = node.property?.type === "Identifier"
              ? node.property.name
              : (node.property?.type === "Literal" ? node.property.value : null)

            // Block access to dangerous prototype-related properties
            if (propName && dangerousProps.includes(propName)) {
              errors.push(
                new ValidationError({
                  type: "forbidden_construct",
                  _message: `Accessing .${propName} is forbidden (potential prototype manipulation)`,
                  location: node.loc?.start
                })
              )
            }
          },
          ImportDeclaration(node: AnyNode) {
            errors.push(
              new ValidationError({
                type: "import",
                _message: `Static imports are forbidden: "${node.source?.value}"`,
                location: node.loc?.start
              })
            )
          },
          ImportExpression(node: AnyNode) {
            errors.push(
              new ValidationError({
                type: "import",
                _message: "Dynamic import() is forbidden",
                location: node.loc?.start
              })
            )
          },
          ExportNamedDeclaration(node: AnyNode) {
            // Allow exports, but check the source (re-exports)
            if (node.source) {
              errors.push(
                new ValidationError({
                  type: "import",
                  _message: `Re-exports are forbidden: "${node.source.value}"`,
                  location: node.loc?.start
                })
              )
            }
          },
          ExportAllDeclaration(node: AnyNode) {
            errors.push(
              new ValidationError({
                type: "import",
                _message: `Export * is forbidden: "${node.source?.value}"`,
                location: node.loc?.start
              })
            )
          },
          CallExpression(node: AnyNode) {
            // Check for require()
            if (node.callee?.type === "Identifier" && node.callee.name === "require") {
              errors.push(
                new ValidationError({
                  type: "import",
                  _message: "require() is forbidden",
                  location: node.loc?.start
                })
              )
            }
            // Check for eval()
            if (node.callee?.type === "Identifier" && node.callee.name === "eval") {
              errors.push(
                new ValidationError({
                  type: "forbidden_construct",
                  _message: "eval() is forbidden",
                  location: node.loc?.start
                })
              )
            }
            // Block x.constructor() calls - constructor chain attacks
            if (
              node.callee?.type === "MemberExpression" &&
              node.callee.property?.type === "Identifier" &&
              node.callee.property.name === "constructor"
            ) {
              errors.push(
                new ValidationError({
                  type: "forbidden_construct",
                  _message: "Calling .constructor() is forbidden (potential Function constructor bypass)",
                  location: node.loc?.start
                })
              )
            }
          },
          NewExpression(node: AnyNode) {
            // Check for new Function()
            if (node.callee?.type === "Identifier" && node.callee.name === "Function") {
              errors.push(
                new ValidationError({
                  type: "forbidden_construct",
                  _message: "new Function() is forbidden",
                  location: node.loc?.start
                })
              )
            }
            // Block new X.constructor() - constructor chain attacks
            if (
              node.callee?.type === "MemberExpression" &&
              node.callee.property?.type === "Identifier" &&
              node.callee.property.name === "constructor"
            ) {
              errors.push(
                new ValidationError({
                  type: "forbidden_construct",
                  _message: "Accessing .constructor is forbidden (potential Function constructor bypass)",
                  location: node.loc?.start
                })
              )
            }
          }
        } as walk.SimpleVisitors<unknown>)

        // Phase 5: Check for forbidden global access
        walk.ancestor(ast, {
          Identifier(node: AnyNode, _state: unknown, ancestors: Array<AnyNode>) {
            const parent = ancestors[ancestors.length - 2]
            if (!parent) return

            // Skip property access on objects (x.foo - 'foo' is fine)
            if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) {
              return
            }
            // Skip object literal keys
            if (parent.type === "Property" && parent.key === node && !parent.computed) {
              return
            }
            // Skip labels
            if (
              parent.type === "LabeledStatement" || parent.type === "BreakStatement" ||
              parent.type === "ContinueStatement"
            ) {
              return
            }
            // Skip export specifiers
            if (parent.type === "ExportSpecifier") {
              return
            }
            // Skip import specifiers (already caught by ImportDeclaration)
            if (parent.type === "ImportSpecifier" || parent.type === "ImportDefaultSpecifier") {
              return
            }
            // Skip method definitions (class method names)
            if (parent.type === "MethodDefinition" && parent.key === node) {
              return
            }

            const name = node.name
            if (!name) return

            // Check if it's declared or an allowed global
            if (!declaredIdentifiers.has(name) && !config.allowedGlobals.includes(name)) {
              errors.push(
                new ValidationError({
                  type: "global",
                  _message: `Access to global "${name}" is forbidden`,
                  location: node.loc?.start
                })
              )
            }
          }
        } as walk.AncestorVisitors<unknown>)

        return { valid: errors.length === 0, errors, warnings }
      })
  })
)
