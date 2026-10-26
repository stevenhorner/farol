import ts from 'typescript'

/** Key prefix of a command-line command as an entry point: `CLI analyze`. */
export const CLI_PREFIX = 'CLI'

function literal(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined
}

/** The command name of a commander/yargs/cac spec: its first word (`'clone <src> [dest]'` → `clone`), `$0` → default. */
function commandName(spec: string): string | undefined {
  const name = spec.trim().split(' ').find((w) => w !== '') ?? ''
  if (name === '$0' || name === '*') return '(default)'
  return name === '' || name.startsWith('<') || name.startsWith('[') ? undefined : name
}

function isFunctionLike(node: ts.Node | undefined): node is ts.Expression {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isIdentifier(node) || ts.isPropertyAccessExpression(node))
}

/** A yargs description: a string, or `false` for a hidden command. */
function isDescription(node: ts.Node | undefined): boolean {
  return node !== undefined && (literal(node) !== undefined || node.kind === ts.SyntaxKind.FalseKeyword)
}

/** The `.command('<spec>')` call below an `.action(…)` in a builder chain (`.command('x').option(…).action(fn)`). */
function commandBelow(expr: ts.Expression): ts.CallExpression | undefined {
  let target = expr
  while (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)) {
    if (target.expression.name.text === 'command') return target
    target = target.expression.expression
  }
  return undefined
}

/**
 * Commands of a command-line program defined in a file, each an entry point whose code is its handler:
 * commander and cac (`program.command('analyze').option(…).action(handler)`) and yargs
 * (`yargs.command('serve [port]', 'describe', builder, handler)`). The name is the spec's first word; a computed spec
 * is kept with the expression in braces and marked as computed, like a computed route path.
 */
export function cliNodes(sf: ts.SourceFile): { key: string; node: ts.Node; value: ts.Node; computed?: true }[] {
  const out: { key: string; node: ts.Node; value: ts.Node; computed?: true }[] = []
  const push = (spec: ts.Expression | undefined, node: ts.Node, value: ts.Node): void => {
    if (spec === undefined) return
    const text = literal(spec)
    if (text === undefined) {
      out.push({ key: `${CLI_PREFIX} {${spec.getText(sf)}}`, node, value, computed: true })
      return
    }
    const name = commandName(text)
    if (name !== undefined) out.push({ key: `${CLI_PREFIX} ${name}`, node, value })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const args = node.arguments
      if (method === 'action' && args.length === 1 && isFunctionLike(args[0])) {
        const command = commandBelow(node.expression.expression)
        if (command !== undefined) push(command.arguments[0], node, args[0])
      } else if (method === 'command' && args.length >= 3 && isDescription(args[1]) && isFunctionLike(args[args.length - 1])) {
        // yargs: command(spec, description, builder, handler); a command with an .action() is commander's, above.
        const handler = args[args.length - 1]
        if (handler !== undefined) push(args[0], node, handler)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}
