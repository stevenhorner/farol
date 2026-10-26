package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
)

// listPackage is the part of `go list -json` the helper reads.
type listPackage struct {
	ImportPath string
	Name       string
	Dir        string
	GoFiles    []string
	Imports    []string
	ImportMap  map[string]string
	Standard   bool
	Module     *struct {
		Path      string
		Main      bool
		GoVersion string
	}
	Error      *struct{ Err string }
	DepsErrors []*struct{ Err string }
}

// pkg is a type-checked package; project packages keep their syntax and type information.
type pkg struct {
	list    listPackage
	project bool
	files   []*ast.File
	names   []string // absolute file names, same order as files
	types   *types.Package
	info    *types.Info
	errors  []types.Error
}

// goEnv is the environment of every go command: no network, no toolchain download, no cgo, no workspace.
func goEnv() []string {
	env := os.Environ()
	return append(env, "GOPROXY=off", "GOTOOLCHAIN=local", "GOFLAGS=", "CGO_ENABLED=0", "GOWORK=off")
}

// listPackages runs `go list -deps` in dir: dependencies come before the packages that import them.
func listPackages(dir string) ([]listPackage, error) {
	cmd := exec.Command("go", "list", "-e", "-json=ImportPath,Name,Dir,GoFiles,Imports,ImportMap,Standard,Module,Error,DepsErrors", "-deps", "./...")
	cmd.Dir = dir
	cmd.Env = goEnv()
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("go list failed in %s: %v: %s", dir, err, strings.TrimSpace(stderr.String()))
	}
	var out []listPackage
	dec := json.NewDecoder(&stdout)
	for {
		var p listPackage
		if err := dec.Decode(&p); err == io.EOF {
			break
		} else if err != nil {
			return nil, fmt.Errorf("cannot read go list output: %v", err)
		}
		out = append(out, p)
	}
	return out, nil
}

// load type-checks every package, project packages with full information and dependencies without function bodies.
// Packages are parsed and checked in parallel: each one starts once the packages it imports are checked (go list
// -deps gives them all), with at most GOMAXPROCS at a time. The result does not depend on the order of the work.
func load(dir string, fset *token.FileSet) ([]*pkg, error) {
	listed, err := listPackages(dir)
	if err != nil {
		return nil, err
	}
	byPath := map[string]*pkg{}
	var all []*pkg
	for _, lp := range listed {
		p := &pkg{list: lp, project: lp.Module != nil && lp.Module.Main}
		if lp.ImportPath == "unsafe" {
			p.types = types.Unsafe
			byPath[lp.ImportPath] = p
			continue
		}
		if p.project && lp.Error != nil {
			return nil, fmt.Errorf("package %s: %s", lp.ImportPath, lp.Error.Err)
		}
		byPath[lp.ImportPath] = p
		all = append(all, p)
	}
	done := make(map[*pkg]chan struct{}, len(all))
	for _, p := range all {
		done[p] = make(chan struct{})
	}
	sizes := types.SizesFor("gc", runtime.GOARCH)
	slots := make(chan struct{}, runtime.GOMAXPROCS(0))
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	for _, p := range all {
		wg.Add(1)
		go func(p *pkg) {
			defer wg.Done()
			defer close(done[p])
			lp := p.list
			// Wait for the imports (already-loaded "unsafe" and packages go list could not list have no channel).
			for _, imp := range lp.Imports {
				if mapped, ok := lp.ImportMap[imp]; ok {
					imp = mapped
				}
				if dep, ok := byPath[imp]; ok {
					if ch, ok := done[dep]; ok {
						<-ch
					}
				}
			}
			slots <- struct{}{}
			defer func() { <-slots }()
			if err := check(p, fset, byPath, sizes); err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				mu.Unlock()
			}
		}(p)
	}
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].list.ImportPath < all[j].list.ImportPath })
	return all, nil
}

// check parses and type-checks one package whose imports are checked.
func check(p *pkg, fset *token.FileSet, byPath map[string]*pkg, sizes types.Sizes) error {
	lp := p.list
	mode := parser.SkipObjectResolution
	if p.project {
		mode |= parser.ParseComments
	}
	for _, name := range lp.GoFiles {
		abs := filepath.Join(lp.Dir, name)
		f, err := parser.ParseFile(fset, abs, nil, mode)
		if f == nil {
			return fmt.Errorf("cannot parse %s: %v", abs, err)
		}
		p.files = append(p.files, f)
		p.names = append(p.names, abs)
	}
	conf := types.Config{
		Importer: importerFunc(func(path string) (*types.Package, error) {
			if mapped, ok := lp.ImportMap[path]; ok {
				path = mapped
			}
			dep, ok := byPath[path]
			if !ok || dep.types == nil {
				return nil, fmt.Errorf("package %s not loaded (missing from the module cache? run go mod download)", path)
			}
			return dep.types, nil
		}),
		IgnoreFuncBodies: !p.project,
		FakeImportC:      true,
		Sizes:            sizes,
		Error: func(err error) {
			if te, ok := err.(types.Error); ok && p.project && !te.Soft {
				p.errors = append(p.errors, te)
			}
		},
	}
	if p.project {
		p.info = &types.Info{
			Types:      map[ast.Expr]types.TypeAndValue{},
			Defs:       map[*ast.Ident]types.Object{},
			Uses:       map[*ast.Ident]types.Object{},
			Selections: map[*ast.SelectorExpr]*types.Selection{},
		}
	}
	// Errors are collected above; a package with errors still yields usable (partial) type information.
	p.types, _ = conf.Check(lp.ImportPath, fset, p.files, p.info)
	return nil
}

type importerFunc func(path string) (*types.Package, error)

func (f importerFunc) Import(path string) (*types.Package, error) { return f(path) }
