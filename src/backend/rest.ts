import ts from 'typescript'

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'options', 'head', 'all'])

/** Receivers that register routes; with any other receiver (`http.post(url, body)`) only an inline function is a handler. */
const SERVERS = new Set(['app', 'fastify', 'server', 'router', 'instance', 'api', 'routes', 'express', 'srv'])

function receiverName(call: ts.CallExpression): string | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined
  let target: ts.Expression = call.expression.expression
  while (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)) target = target.expression.expression
  return ts.isIdentifier(target) ? target.text : ts.isPropertyAccessExpression(target) ? target.name.text : undefined
}

function isHandler(node: ts.Node | undefined, call: ts.CallExpression): node is ts.Expression {
  if (node === undefined || call.typeArguments) return false
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true
  return (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && SERVERS.has(receiverName(call) ?? '')
}

function literal(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined
}

function objectProp(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return p.initializer
    if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name) && p.name.text === name) return p as unknown as ts.Expression
  }
  return undefined
}

/**
 * REST endpoints registered in a file (Fastify and Express styles): `app.get('/path', handler)`,
 * `router.route('/path').post(handler)` and `fastify.route({ method, url, handler })`. Prefixes added by
 * `register(…, { prefix })` or `app.use('/api', router)` are not applied: paths are as written. A path that is not a
 * string (`app.get(path('x'), handler)`) is kept with the expression in braces and marked as computed.
 */
export function restNodes(sf: ts.SourceFile): { key: string; node: ts.Node; value: ts.Node; computed?: true }[] {
  const out: { key: string; node: ts.Node; value: ts.Node; computed?: true }[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const args = node.arguments
      const last = args[args.length - 1]
      if (METHODS.has(method) && args.length >= 2 && isHandler(last, node)) {
        const path = literal(args[0])
        const verb = method === 'del' ? 'DELETE' : method.toUpperCase()
        if (path !== undefined && (path.startsWith('/') || path === '*')) out.push({ key: `${verb} ${path}`, node, value: last })
        // router.route('/path').get(handler)
        const target = node.expression.expression
        const chained = ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression) && target.expression.name.text === 'route'
        if (path === undefined && chained) {
          const spec = target.arguments[0]
          const routePath = literal(spec)
          if (routePath !== undefined) out.push({ key: `${method.toUpperCase()} ${routePath}`, node, value: last })
          else if (spec !== undefined && SERVERS.has(receiverName(node) ?? '')) out.push({ key: `${method.toUpperCase()} {${spec.getText(sf)}}`, node, value: last, computed: true })
        }
        const first = args[0]
        if (path === undefined && !chained && first !== undefined && !ts.isStringLiteralLike(first) && SERVERS.has(receiverName(node) ?? '')) out.push({ key: `${verb} {${first.getText(sf)}}`, node, value: last, computed: true })
      } else if (METHODS.has(method) && args.length === 1 && isHandler(args[0], node)) {
        const target = node.expression.expression
        if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression) && target.expression.name.text === 'route') {
          const spec = target.arguments[0]
          const routePath = literal(spec)
          if (routePath !== undefined) out.push({ key: `${method.toUpperCase()} ${routePath}`, node, value: args[0] })
          else if (spec !== undefined && SERVERS.has(receiverName(node) ?? '')) out.push({ key: `${method.toUpperCase()} {${spec.getText(sf)}}`, node, value: args[0], computed: true })
        }
      } else if (method === 'route' && args.length === 1 && args[0] && ts.isObjectLiteralExpression(args[0])) {
        const methods = objectProp(args[0], 'method')
        const url = literal(objectProp(args[0], 'url')) ?? literal(objectProp(args[0], 'path'))
        const handler = objectProp(args[0], 'handler')
        const names = methods && ts.isArrayLiteralExpression(methods) ? methods.elements.map((e) => literal(e)) : [literal(methods)]
        if (url !== undefined && handler) for (const m of names) if (m !== undefined) out.push({ key: `${m.toUpperCase()} ${url}`, node, value: handler })
        const given = objectProp(args[0], 'url') ?? objectProp(args[0], 'path')
        if (url === undefined && given !== undefined && handler && SERVERS.has(receiverName(node) ?? '')) for (const m of names) if (m !== undefined) out.push({ key: `${m.toUpperCase()} {${given.getText(sf)}}`, node, value: handler, computed: true })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}
