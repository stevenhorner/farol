/** One route of the table. Module paths are repo-relative; packages appear as `package:<specifier>`. */
export interface RouteEntry {
  /** Stable key: ancestor segments (path when present, `(layout:<module>)` otherwise, `(index)` for index routes). */
  key: string
  /** Full URL path, ancestors' paths concatenated. */
  path: string
  index: boolean
  /** Module rendered by the route (element, Component or lazy import), or null when it renders nothing. */
  entry: string | null
  /** Every module the route definition references (entry, wrappers, error elements), sorted. */
  modules: string[]
  /** Entry modules of the ancestor routes that have a component, from the root down. */
  layouts: string[]
  /**
   * Where each part of a path computed at run time is written (backends: the route's registration, a router prefix):
   * the key holds the expression in braces, so farol cannot tell which URL it takes. New, or with a part in a changed
   * file, it makes the PR `unknown` (see classify).
   */
  computed?: DynamicRoute[]
}

/** A construct the adapter does not understand: it makes the PR `unknown`. */
export interface DynamicRoute {
  file: string
  line: number
  detail: string
}

export interface RouteTable {
  routes: RouteEntry[]
  dynamic: DynamicRoute[]
  /** Repo-relative files the table was read from: the routes file and the modules it pulls route data from. */
  sources: string[]
}

export type ModuleResolution = { kind: 'module'; file: string } | { kind: 'external'; specifier: string } | { kind: 'unresolved' }

export interface RouteAdapterInput {
  /** Repo-relative path of the routes file, or of the routes directory for file-system routers. */
  file: string
  /** Code of the routes file; empty for file-system routers. */
  code: string
  /** File-system routers: repo-relative files under the routes directory, sorted. Empty for a routes file. */
  files: readonly string[]
  /** Resolves an import specifier written in `fromFile` (repo-relative). */
  resolve: (specifier: string, fromFile: string) => ModuleResolution
  /** Code of another repo-relative module, for route trees split across files; undefined when it does not exist. */
  read: (file: string) => string | undefined
}

/** The only extension point of farol: turns the code of a routes file (or a routes directory) into a route table. */
export interface RouteAdapter {
  name: string
  /** Where routes are declared: one routes file (with modules it pulls routes from), or the files of a directory. */
  source: 'file' | 'directory'
  extract: (input: RouteAdapterInput) => RouteTable
}
