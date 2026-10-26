package main

import (
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"path"
	"sort"
	"strings"
)

// Entry is an entry point: an HTTP route (chi, gin, echo, net/http), a gRPC method, or a binary (a main package that
// registers no route).
type Entry struct {
	Key  string `json:"key"`
	File string `json:"file"`
	Line int    `json:"line"`
	Kind string `json:"kind"`
	// Declarations whose code runs for this entry point: handler, middlewares, or the whole main package.
	Anchors []int `json:"anchors"`
	// Hash of inline function literals of the handler and middlewares (their code lives in the function that
	// registers the routes, which is not an anchor): a different hash means the route runs different code.
	Inline string `json:"inline"`
	// What the endpoint receives and returns, when the handler decodes and encodes typed values (or a gRPC method).
	Contract *Contract `json:"contract,omitempty"`
	// The path (or a prefix of it) is computed at run time: the key holds the expression in braces, and these are
	// the places that compute it.
	Computed []Origin `json:"computed,omitempty"`
}

// Origin is where a computed part of a route path is written.
type Origin struct {
	File string `json:"file"`
	Line int    `json:"line"`
}

// Problem is something the helper could not read: type errors, route paths it cannot compute.
type Problem struct {
	File   string `json:"file"`
	Line   int    `json:"line"`
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

var chiVerbs = map[string]string{"Get": "GET", "Post": "POST", "Put": "PUT", "Patch": "PATCH", "Delete": "DELETE", "Head": "HEAD", "Options": "OPTIONS", "Connect": "CONNECT", "Trace": "TRACE"}

type scope struct {
	prefix string
	mws    []int
	inline []string // hashes of inline middlewares added with Use
}

type routeFinder struct {
	g        *graph
	pkgs     []*pkg
	entries  []Entry
	problems []Problem
	walked   map[string]bool
	byFunc   map[*types.Func]*pkg
	// Inline literal hashes collected for the entry being registered (handler and middlewares).
	inline []string
	// Source ranges of registration calls (routes, groups, middlewares), left out of the core hash.
	registrations [][2]token.Pos
	// gin/echo group variables (and router parameters while their function is walked) -> prefix and middlewares.
	vars map[types.Object]*scope
	// Parameters each project function decodes or encodes (see ioParams), cached.
	ioCache map[*types.Func]map[int]string
}

func isRouter(t types.Type) bool {
	if t == nil {
		return false
	}
	s := types.TypeString(deref(t), nil)
	return (strings.HasPrefix(s, "github.com/go-chi/chi") && (strings.HasSuffix(s, ".Router") || strings.HasSuffix(s, ".Mux"))) || isFrameworkRouter(t)
}

func isChiMethod(p *pkg, sel *ast.SelectorExpr) (string, bool) {
	s, ok := p.info.Selections[sel]
	if !ok || s.Kind() != types.MethodVal {
		return "", false
	}
	fn := s.Obj()
	if fn.Pkg() == nil || !strings.HasPrefix(fn.Pkg().Path(), "github.com/go-chi/chi") {
		return "", false
	}
	return fn.Name(), true
}

// netHTTP: http.Handle / http.HandleFunc and (*http.ServeMux).Handle / HandleFunc.
func isNetHTTP(p *pkg, call *ast.CallExpr) bool {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || (sel.Sel.Name != "Handle" && sel.Sel.Name != "HandleFunc") {
		return false
	}
	var fn types.Object
	if s, ok := p.info.Selections[sel]; ok {
		fn = s.Obj()
	} else {
		fn = p.info.Uses[sel.Sel]
	}
	return fn != nil && fn.Pkg() != nil && fn.Pkg().Path() == "net/http"
}

func (f *routeFinder) str(p *pkg, e ast.Expr) (string, bool) {
	tv, ok := p.info.Types[e]
	if !ok || tv.Value == nil || tv.Value.Kind() != constant.String {
		return "", false
	}
	return constant.StringVal(tv.Value), true
}

// anchorsOf: declarations a handler or middleware expression runs. Inline function literals are recorded by hash.
func (f *routeFinder) anchorsOf(p *pkg, e ast.Expr, _ int) []int {
	ast.Inspect(e, func(n ast.Node) bool {
		if lit, ok := n.(*ast.FuncLit); ok {
			file := f.g.fset.Position(lit.Pos()).Filename
			f.inline = append(f.inline, f.g.hashNode(file, lit.Pos(), lit.End()))
			return false
		}
		return true
	})
	return f.g.usesIn(p, e, nil)
}

func (f *routeFinder) add(p *pkg, call *ast.CallExpr, sc *scope, key, kind string, anchors []int) {
	pos := f.g.fset.Position(call.Pos())
	inline := append(append([]string{}, sc.inline...), f.inline...)
	clean, computed := computedOrigins(key)
	entry := Entry{Key: clean, File: f.g.rel(pos.Filename), Line: pos.Line, Kind: kind, Anchors: uniqueInts(anchors), Inline: strings.Join(inline, ","), Computed: computed}
	if kind == "http" {
		mws := map[int]bool{}
		for _, m := range sc.mws {
			mws[m] = true
		}
		var handlers []int
		for _, a := range anchors {
			if !mws[a] {
				handlers = append(handlers, a)
			}
		}
		entry.Contract = f.httpContract(p, call, handlers)
	}
	f.entries = append(f.entries, entry)
	f.inline = nil
}

func (f *routeFinder) dynamic(call *ast.CallExpr, detail string) {
	pos := f.g.fset.Position(call.Pos())
	f.problems = append(f.problems, Problem{File: f.g.rel(pos.Filename), Line: pos.Line, Kind: "dynamic-route", Detail: detail})
}

// receiverMiddlewares follows `r.With(a, b).Get(…)` chains back to the router, collecting the middlewares.
func (f *routeFinder) receiverMiddlewares(p *pkg, e ast.Expr, enclosing int) []int {
	var out []int
	for {
		call, ok := e.(*ast.CallExpr)
		if !ok {
			return out
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return out
		}
		if name, ok := isChiMethod(p, sel); ok && name == "With" {
			for _, a := range call.Args {
				out = append(out, f.anchorsOf(p, a, enclosing)...)
			}
		}
		e = sel.X
	}
}

// walk visits code in registration order, keeping the route prefix and the middlewares of the current scope.
func (f *routeFinder) walk(p *pkg, node ast.Node, sc *scope, enclosing int) {
	ast.Inspect(node, func(n ast.Node) bool {
		if as, ok := n.(*ast.AssignStmt); ok {
			f.groupAssign(p, as, sc, enclosing)
			return true
		}
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if f.grpcRegister(p, call) || f.ginEcho(p, call, sc, enclosing) {
			return false
		}
		if isNetHTTP(p, call) && len(call.Args) == 2 {
			f.registrations = append(f.registrations, [2]token.Pos{call.Pos(), call.End()})
			pattern := f.pattern(p, call.Args[0])
			key := pattern
			if !strings.Contains(pattern, " ") {
				key = "ANY " + pattern
			}
			f.add(p, call, sc, key, "http", append(f.anchorsOf(p, call.Args[1], enclosing), sc.mws...))
			return false
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			f.followRouterArgs(p, call, sc)
			return true
		}
		name, ok := isChiMethod(p, sel)
		if !ok {
			f.followRouterArgs(p, call, sc)
			return true
		}
		if name != "With" {
			f.registrations = append(f.registrations, [2]token.Pos{call.Pos(), call.End()})
		}
		mws := append(append([]int{}, sc.mws...), f.receiverMiddlewares(p, sel.X, enclosing)...)
		switch {
		case chiVerbs[name] != "" || name == "Handle" || name == "HandleFunc" || name == "Mount":
			if len(call.Args) != 2 {
				return true
			}
			pattern := f.pattern(p, call.Args[0])
			method := chiVerbs[name]
			full := joinPath(sc.prefix, pattern)
			if method == "" {
				method = "ANY"
			}
			if name == "Mount" {
				full = strings.TrimSuffix(full, "/") + "/*"
			}
			f.add(p, call, sc, method+" "+full, "http", append(f.anchorsOf(p, call.Args[1], enclosing), mws...))
			return false
		case name == "Method" || name == "MethodFunc":
			if len(call.Args) != 3 {
				return true
			}
			method, ok := f.str(p, call.Args[0])
			pattern := f.pattern(p, call.Args[1])
			if !ok {
				f.dynamic(call, "route method is not a constant")
				return false
			}
			f.add(p, call, sc, strings.ToUpper(method)+" "+joinPath(sc.prefix, pattern), "http", append(f.anchorsOf(p, call.Args[2], enclosing), mws...))
			return false
		case name == "Route" || name == "Group":
			fnArg := call.Args[len(call.Args)-1]
			prefix := sc.prefix
			if name == "Route" {
				pattern := f.pattern(p, call.Args[0])
				prefix = joinPath(sc.prefix, pattern)
			}
			inner := &scope{prefix: prefix, mws: mws, inline: append(append([]string{}, sc.inline...), f.inline...)}
			f.inline = nil
			f.walkFunc(p, fnArg, inner, enclosing)
			return false
		case name == "Use":
			for _, a := range call.Args {
				sc.mws = append(sc.mws, f.anchorsOf(p, a, enclosing)...)
			}
			sc.inline = append(sc.inline, f.inline...)
			f.inline = nil
			return false
		}
		return true
	})
}

// walkFunc walks a function given as an argument: a literal in place, a project function by its declaration.
func (f *routeFinder) walkFunc(p *pkg, e ast.Expr, sc *scope, enclosing int) {
	if lit, ok := e.(*ast.FuncLit); ok {
		f.walk(p, lit.Body, sc, enclosing)
		return
	}
	var id *ast.Ident
	switch x := e.(type) {
	case *ast.Ident:
		id = x
	case *ast.SelectorExpr:
		id = x.Sel
	}
	if id == nil {
		return
	}
	fn, ok := p.info.Uses[id].(*types.Func)
	if !ok {
		return
	}
	f.walkDecl(fn, sc, "")
}

func (f *routeFinder) walkDecl(fn *types.Func, sc *scope, bound string) {
	decl := f.g.funcs[fn]
	owner := f.byFunc[fn]
	if decl == nil || owner == nil || decl.Body == nil {
		return
	}
	key := fn.FullName() + "\x00" + sc.prefix + bound
	if f.walked[key] {
		return
	}
	f.walked[key] = true
	enclosing := -1
	if ids := f.g.declOf(fn); len(ids) == 1 {
		enclosing = ids[0]
	}
	f.walk(owner, decl.Body, &scope{prefix: sc.prefix, mws: append([]int{}, sc.mws...), inline: append([]string{}, sc.inline...)}, enclosing)
}

// followRouterArgs: a project function receiving a router registers routes under the current prefix.
func (f *routeFinder) followRouterArgs(p *pkg, call *ast.CallExpr, sc *scope) {
	routerArg := false
	for _, a := range call.Args {
		if isRouter(p.info.Types[a].Type) {
			routerArg = true
		}
	}
	if !routerArg {
		return
	}
	var id *ast.Ident
	switch x := call.Fun.(type) {
	case *ast.Ident:
		id = x
	case *ast.SelectorExpr:
		id = x.Sel
	}
	if id == nil {
		return
	}
	if fn, ok := p.info.Uses[id].(*types.Func); ok {
		f.walkDecl(fn, sc, f.bindRouterParams(p, call, fn, sc))
	}
}

func takesRouter(p *pkg, fd *ast.FuncDecl) bool {
	for _, field := range fd.Type.Params.List {
		if isRouter(p.info.Types[field.Type].Type) {
			return true
		}
	}
	return false
}

// findEntries: routes registered anywhere in the project, then binaries that register none.
func findEntries(g *graph, pkgs []*pkg) ([]Entry, []Problem) {
	f := &routeFinder{g: g, pkgs: pkgs, walked: map[string]bool{}, byFunc: map[*types.Func]*pkg{}, vars: map[types.Object]*scope{}}
	for _, p := range pkgs {
		if !p.project {
			continue
		}
		for _, file := range p.files {
			for _, d := range file.Decls {
				if fd, ok := d.(*ast.FuncDecl); ok {
					if fn, ok := p.info.Defs[fd.Name].(*types.Func); ok {
						f.byFunc[fn] = p
					}
				}
			}
		}
	}
	// Functions that receive a router are walked from their callers, with the callers' prefix.
	for _, p := range pkgs {
		if !p.project {
			continue
		}
		for _, file := range p.files {
			for _, d := range file.Decls {
				fd, ok := d.(*ast.FuncDecl)
				if !ok || fd.Body == nil || takesRouter(p, fd) {
					continue
				}
				if fn, ok := p.info.Defs[fd.Name].(*types.Func); ok {
					f.walkDecl(fn, &scope{}, "")
				}
			}
		}
	}
	withRoutes := map[string]bool{}
	for _, e := range f.entries {
		withRoutes[path.Dir(e.File)] = true
	}
	for _, p := range pkgs {
		if !p.project || p.list.Name != "main" || len(p.names) == 0 {
			continue
		}
		dir := path.Dir(g.rel(p.names[0]))
		if withRoutes[dir] {
			continue
		}
		var anchors []int
		for i, d := range g.decls {
			if path.Dir(d.File) == dir {
				anchors = append(anchors, i)
			}
		}
		f.entries = append(f.entries, Entry{Key: "RUN " + dir, File: g.rel(p.names[0]), Line: 1, Kind: "main", Anchors: anchors})
	}
	sort.SliceStable(f.entries, func(i, j int) bool { return f.entries[i].Key < f.entries[j].Key })
	g.setCore(f.registrations)
	return f.entries, f.problems
}
