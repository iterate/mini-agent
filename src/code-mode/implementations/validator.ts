/**
 * Security Validator
 *
 * Static analysis to detect forbidden constructs in JavaScript.
 * Uses regex for fast screening, then AST for precise validation.
 */
import * as acorn from "acorn"
import * as walk from "acorn-walk"
import { Effect, Layer } from "effect"

import type { ValidationWarning } from "../errors.ts"
import { ValidationError } from "../errors.ts"
import { Validator } from "../services.ts"
import type { CodeModeConfig, ValidationResult } from "../types.ts"

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

export const ValidatorLive = Layer.succeed(
  Validator,
  Validator.of({
    validate: (code: string, config: CodeModeConfig): Effect.Effect<ValidationResult, never> =>
      Effect.sync(() => {
        const errors: Array<ValidationError> = []
        const warnings: Array<ValidationWarning> = []

        // Phase 1: Fast regex check
        for (const pattern of config.forbiddenPatterns) {
          const match = code.match(pattern)
          if (match && match.index !== undefined) {
            const loc = getLineColumn(code, match.index)
            errors.push(
              new ValidationError({
                type: "forbidden_construct",
                message: `Forbidden pattern: ${pattern.source}`,
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
          const err = e as Error & { loc?: { line: number; column: number } }
          errors.push(
            new ValidationError({
              type: "syntax",
              message: err.message,
              location: err.loc,
              cause: err
            })
          )
          return { valid: false, errors, warnings }
        }

        // Phase 3: Collect declared identifiers
        const declaredIdentifiers = new Set<string>(["ctx", "module", "exports", "undefined"])

        const collectIds = (node: AnyNode): void => {
          if (!node) return
          if (node.type === "Identifier" && node.name) {
            declaredIdentifiers.add(node.name)
          } else if (node.type === "ObjectPattern" && node.properties) {
            for (const prop of node.properties) {
              if (prop.value) collectIds(prop.value)
              if (prop.type === "RestElement" && prop.argument) collectIds(prop.argument)
            }
          } else if (node.type === "ArrayPattern" && node.elements) {
            for (const el of node.elements) if (el) collectIds(el)
          } else if (node.type === "AssignmentPattern" && node.left) {
            collectIds(node.left)
          } else if (node.type === "RestElement" && node.argument) {
            collectIds(node.argument)
          }
        }

        walk.simple(ast, {
          VariableDeclarator(node: AnyNode) {
            if (node.id) collectIds(node.id)
          },
          FunctionDeclaration(node: AnyNode) {
            if (node.id?.name) declaredIdentifiers.add(node.id.name)
            if (node.params) { for (const p of node.params) collectIds(p) }
          },
          FunctionExpression(node: AnyNode) {
            if (node.params) { for (const p of node.params) collectIds(p) }
          },
          ArrowFunctionExpression(node: AnyNode) {
            if (node.params) { for (const p of node.params) collectIds(p) }
          },
          ClassDeclaration(node: AnyNode) {
            if (node.id?.name) declaredIdentifiers.add(node.id.name)
          },
          CatchClause(node: AnyNode) {
            if (node.param) collectIds(node.param)
          }
        } as walk.SimpleVisitors<unknown>)

        // Phase 4: Check forbidden constructs
        const dangerousProps = ["constructor", "__proto__", "__defineGetter__", "__defineSetter__"]

        walk.simple(ast, {
          MemberExpression(node: AnyNode) {
            const propName = node.property?.type === "Identifier"
              ? node.property.name
              : (node.property?.type === "Literal" ? node.property.value : null)
            if (propName && dangerousProps.includes(propName)) {
              errors.push(
                new ValidationError({
                  type: "forbidden_construct",
                  message: `Accessing .${propName} is forbidden`,
                  location: node.loc?.start
                })
              )
            }
          },
          ImportDeclaration(node: AnyNode) {
            errors.push(
              new ValidationError({
                type: "import",
                message: `Static imports forbidden: "${node.source?.value}"`,
                location: node.loc?.start
              })
            )
          },
          ImportExpression(node: AnyNode) {
            errors.push(
              new ValidationError({
                type: "import",
                message: "Dynamic import() forbidden",
                location: node.loc?.start
              })
            )
          },
          ExportAllDeclaration(node: AnyNode) {
            errors.push(
              new ValidationError({
                type: "import",
                message: `Export * forbidden: "${node.source?.value}"`,
                location: node.loc?.start
              })
            )
          },
          CallExpression(node: AnyNode) {
            if (node.callee?.type === "Identifier") {
              if (node.callee.name === "require") {
                errors.push(
                  new ValidationError({
                    type: "import",
                    message: "require() forbidden",
                    location: node.loc?.start
                  })
                )
              }
              if (node.callee.name === "eval") {
                errors.push(
                  new ValidationError({
                    type: "forbidden_construct",
                    message: "eval() forbidden",
                    location: node.loc?.start
                  })
                )
              }
            }
            // Block .constructor() calls
            if (
              node.callee?.type === "MemberExpression" &&
              node.callee.property?.type === "Identifier" &&
              node.callee.property.name === "constructor"
            ) {
              errors.push(
                new ValidationError({
                  type: "forbidden_construct",
                  message: "Calling .constructor() forbidden",
                  location: node.loc?.start
                })
              )
            }
          },
          NewExpression(node: AnyNode) {
            if (node.callee?.type === "Identifier" && node.callee.name === "Function") {
              errors.push(
                new ValidationError({
                  type: "forbidden_construct",
                  message: "new Function() forbidden",
                  location: node.loc?.start
                })
              )
            }
          }
        } as walk.SimpleVisitors<unknown>)

        // Phase 5: Check undeclared global access
        walk.ancestor(ast, {
          Identifier(node: AnyNode, _state: unknown, ancestors: Array<AnyNode>) {
            const parent = ancestors[ancestors.length - 2]
            if (!parent) return

            // Skip property access, object keys, labels, export/import specifiers
            if (
              (parent.type === "MemberExpression" && parent.property === node && !parent.computed) ||
              (parent.type === "Property" && parent.key === node && !parent.computed) ||
              parent.type === "LabeledStatement" || parent.type === "BreakStatement" ||
              parent.type === "ContinueStatement" || parent.type === "ExportSpecifier" ||
              parent.type === "ImportSpecifier" || parent.type === "ImportDefaultSpecifier" ||
              (parent.type === "MethodDefinition" && parent.key === node)
            ) {
              return
            }

            const name = node.name
            if (name && !declaredIdentifiers.has(name) && !config.allowedGlobals.includes(name)) {
              errors.push(
                new ValidationError({
                  type: "global",
                  message: `Access to global "${name}" forbidden`,
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
