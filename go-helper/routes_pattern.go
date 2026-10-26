package main

import (
	"go/ast"
	"go/token"
	"go/types"
)

// pattern: the path of a route registration. A constant is read as is; a local variable takes the constant last
// assigned to it before the registration (`prefix := "/api/actions"; r.Mount(prefix, …)`). Anything else is the
// expression in braces (`{path + "*"}`): the route is still an entry point, since its handler is known; only its
// path is not. The braces hold computedMark, which marks the entry as computed (see add) and never reaches the key.
func (f *routeFinder) pattern(p *pkg, e ast.Expr) string {
	if s, ok := f.str(p, e); ok {
		return s
	}
	if id, ok := e.(*ast.Ident); ok {
		if s, ok := f.lastConstAssign(p, p.info.Uses[id], id.Pos()); ok {
			return s
		}
	}
	return "{" + computedMark + types.ExprString(e) + "}"
}

// computedMark tags a path read as an expression: a NUL byte, which no route pattern holds.
const computedMark = "\x00"

// lastConstAssign: the constant string of the last assignment (or declaration) of a local variable before pos, in
// the file that holds it, when that assignment is a constant.
func (f *routeFinder) lastConstAssign(p *pkg, obj types.Object, pos token.Pos) (string, bool) {
	v, ok := obj.(*types.Var)
	if !ok || v.IsField() || v.Parent() == nil || v.Parent() == v.Pkg().Scope() {
		return "", false
	}
	var file *ast.File
	for _, fl := range p.files {
		if fl.Pos() <= pos && pos <= fl.End() {
			file = fl
		}
	}
	if file == nil {
		return "", false
	}
	var last token.Pos
	value, found := "", false
	record := func(at token.Pos, rhs ast.Expr) {
		if at >= pos || at < last {
			return
		}
		last = at
		value, found = f.str(p, rhs)
	}
	ast.Inspect(file, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.AssignStmt:
			if len(x.Lhs) != len(x.Rhs) {
				for _, l := range x.Lhs {
					if id, ok := l.(*ast.Ident); ok && (p.info.Defs[id] == obj || p.info.Uses[id] == obj) && x.Pos() < pos && x.Pos() >= last {
						last, value, found = x.Pos(), "", false
					}
				}
				return true
			}
			for i, l := range x.Lhs {
				if id, ok := l.(*ast.Ident); ok && (p.info.Defs[id] == obj || p.info.Uses[id] == obj) {
					record(x.Pos(), x.Rhs[i])
				}
			}
		case *ast.ValueSpec:
			for i, name := range x.Names {
				if p.info.Defs[name] == obj && i < len(x.Values) {
					record(x.Pos(), x.Values[i])
				}
			}
		}
		return true
	})
	return value, found && last != token.NoPos
}
