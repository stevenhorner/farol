"""Entry points: FastAPI and Flask routes (apps, routers and blueprints with prefixes), scripts run as __main__, and
the other kinds of more_entries (MCP tools, Celery tasks, Temporal workflows and activities, Django URLs)."""

from __future__ import annotations

import ast
import hashlib
from dataclasses import dataclass, field

from .decls import MODULE_CODE, Graph, attribute_chain, is_main_guard
from .contracts import Contracts
from .modules import Module
from .more_entries import find_more_entries

VERBS = {"get", "post", "put", "patch", "delete", "head", "options", "trace"}
APP_TYPES = {
    "fastapi.FastAPI": "app", "fastapi.applications.FastAPI": "app", "fastapi.APIRouter": "router", "fastapi.routing.APIRouter": "router",
    "flask.Flask": "app", "flask.app.Flask": "app", "flask.Blueprint": "router", "flask.blueprints.Blueprint": "router",
}


@dataclass
class RouterObj:
    key: str  # "module.NAME"
    kind: str  # app | router
    module: Module
    prefix: str
    decl: list[int]
    framework: str = ""  # fastapi | flask
    # method, path, anchors, inline, line, contract (FastAPI only)
    routes: list[tuple[str, str, list[int], str, int, dict | None]] = field(default_factory=list)
    # (router key, prefix, replaces the router's own prefix: Flask's register_blueprint(url_prefix=…))
    includes: list[tuple[str, str, bool]] = field(default_factory=list)


def dump_hash(node: ast.AST) -> str:
    return hashlib.sha1(ast.dump(node, include_attributes=False).encode()).hexdigest()[:16]


class RouteFinder:
    def __init__(self, graph: Graph):
        self.g = graph
        self.objects: dict[str, RouterObj] = {}
        self.problems: list[dict] = []
        # Paths read as an expression in braces (see path): an entry whose key holds one is computed.
        self.computed: set[str] = set()
        self.contracts = Contracts(graph, self)

    def qualified(self, module: Module, expr: ast.expr) -> str | None:
        """Dotted name an expression refers to through the module's imports (`FastAPI` -> fastapi.FastAPI)."""
        chain = attribute_chain(expr)
        if chain is None:
            return None
        head = module.imports.get(chain[0])
        if head is None:
            return ".".join([module.name, *chain])
        return ".".join([head, *chain[1:]])

    def object_of(self, module: Module, expr: ast.expr, depth: int = 0) -> RouterObj | None:
        name = self.qualified(module, expr)
        while name is not None and depth < 6:
            if name in self.objects:
                return self.objects[name]
            owner, _, attr = name.rpartition(".")
            mod = self.g.modules.get(owner)
            if mod is None or attr not in mod.imports:
                return None
            name = mod.imports[attr]
            depth += 1
        return None

    def string(self, module: Module, expr: ast.expr | None) -> str | None:
        if expr is None:
            return ""
        if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
            return expr.value
        if isinstance(expr, ast.Name):
            ids = self.g.resolve_name(module, expr.id)
            for i in ids:
                node = self.g.decls[i].node
                if isinstance(node, (ast.Assign, ast.AnnAssign)) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                    return node.value.value
        return None

    def setting(self, module: Module, expr: ast.expr) -> str | None:
        """`settings.API_V1_STR`: the string default of that attribute in the class of a module-level instance of a
        project class (`settings = Settings()`, pydantic-settings style)."""
        if not isinstance(expr, ast.Attribute) or not isinstance(expr.value, ast.Name):
            return None
        for i in self.g.resolve_name(module, expr.value.id):
            node = self.g.decls[i].node
            if not isinstance(node, (ast.Assign, ast.AnnAssign)) or not isinstance(node.value, ast.Call):
                continue
            for c in self.g.resolve_expr(self.g.decls[i].module, node.value.func):
                cls = self.g.decls[c].node
                if not isinstance(cls, ast.ClassDef):
                    continue
                for stmt in cls.body:
                    target = stmt.target if isinstance(stmt, ast.AnnAssign) else stmt.targets[0] if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 else None
                    value = stmt.value if isinstance(stmt, (ast.Assign, ast.AnnAssign)) else None
                    if isinstance(target, ast.Name) and target.id == expr.attr and isinstance(value, ast.Constant) and isinstance(value.value, str):
                        return value.value
        return None

    def path(self, module: Module, expr: ast.expr | None) -> str:
        """A route path or prefix: a constant, a settings default, or else the expression in braces (`{API_PREFIX}`):
        the routes are still read, since their handlers are known; only their URL is not, and they are marked as
        computed."""
        value = self.string(module, expr)
        if value is None and expr is not None:
            value = self.setting(module, expr)
        if value is not None:
            return value
        braced = "{" + ast.unparse(expr) + "}"  # type: ignore[arg-type]
        self.computed.add(braced)
        return braced

    def problem(self, module: Module, node: ast.AST, detail: str) -> None:
        self.problems.append({"file": module.file, "line": getattr(node, "lineno", 1), "kind": "dynamic-route", "detail": detail})

    @staticmethod
    def kwarg(call: ast.Call, name: str) -> ast.expr | None:
        return next((k.value for k in call.keywords if k.arg == name), None)

    def find_objects(self) -> None:
        for module in self.g.modules.values():
            if module.tree is None:
                continue
            for stmt in module.tree.body:
                if isinstance(stmt, (ast.Assign, ast.AnnAssign)) and isinstance(stmt.value, ast.Call):
                    constructor = self.qualified(module, stmt.value.func) or ""
                    kind = APP_TYPES.get(constructor)
                    targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
                    if kind is None or len(targets) != 1 or not isinstance(targets[0], ast.Name):
                        continue
                    key = f"{module.name}.{targets[0].id}"
                    prefix = self.path(module, self.kwarg(stmt.value, "prefix") or self.kwarg(stmt.value, "url_prefix"))
                    self.objects[key] = RouterObj(key, kind, module, prefix, self.g.lookup(key), constructor.split(".")[0])

    def find_routes(self) -> None:
        for i, decl in enumerate(self.g.decls):
            node = decl.node
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for dec in node.decorator_list:
                    if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute):
                        self.decorator(decl.module, dec, i)
        for module in self.g.modules.values():
            if module.tree is None:
                continue
            for node in ast.walk(module.tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("include_router", "add_api_route", "register_blueprint"):
                    self.call(module, node)

    def decorator(self, module: Module, dec: ast.Call, handler: int) -> None:
        attr = dec.func.attr  # type: ignore[attr-defined]
        if attr not in VERBS and attr not in ("api_route", "websocket", "route"):
            return
        obj = self.object_of(module, dec.func.value)  # type: ignore[attr-defined]
        if obj is None:
            return
        path = self.path(module, dec.args[0] if dec.args else self.kwarg(dec, "path"))
        if attr in VERBS:
            methods = [attr.upper()]
        elif attr == "websocket":
            methods = ["WS"]
        else:
            listed = self.kwarg(dec, "methods")
            methods = [e.value.upper() for e in listed.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)] if isinstance(listed, (ast.List, ast.Tuple)) else ["GET"]
        node = self.g.decls[handler].node
        contract = self.contracts.endpoint(module, node, dec, path) if obj.framework == "fastapi" and attr != "websocket" else None
        for m in methods:
            obj.routes.append((m, path, [handler], dump_hash(dec), dec.lineno, contract))

    def call(self, module: Module, call: ast.Call) -> None:
        obj = self.object_of(module, call.func.value)  # type: ignore[attr-defined]
        if obj is None:
            return
        if call.func.attr in ("include_router", "register_blueprint"):  # type: ignore[attr-defined]
            target = self.object_of(module, call.args[0]) if call.args else None
            given = self.kwarg(call, "prefix") or self.kwarg(call, "url_prefix")
            prefix = self.path(module, given)
            if target is None:
                self.problem(module, call, f"{call.func.attr} with a router farol cannot read")  # type: ignore[attr-defined]
                return
            obj.includes.append((target.key, prefix, call.func.attr == "register_blueprint" and given is not None))  # type: ignore[attr-defined]
        else:
            path = self.path(module, call.args[0] if call.args else self.kwarg(call, "path"))
            endpoint = call.args[1] if len(call.args) > 1 else self.kwarg(call, "endpoint")
            anchors = self.g.resolve_expr(module, endpoint) if endpoint is not None else []
            if not anchors:
                self.problem(module, call, "add_api_route with an endpoint farol cannot read")
                return
            listed = self.kwarg(call, "methods")
            methods = [e.value.upper() for e in listed.elts if isinstance(e, ast.Constant)] if isinstance(listed, (ast.List, ast.Tuple)) else ["GET"]
            target = next((self.g.decls[a] for a in anchors if isinstance(self.g.decls[a].node, (ast.FunctionDef, ast.AsyncFunctionDef))), None)
            contract = self.contracts.endpoint(target.module, target.node, call, path) if obj.framework == "fastapi" and target is not None else None
            for m in methods:
                obj.routes.append((m, path, anchors, dump_hash(call), call.lineno, contract))

    def expand(self, obj: RouterObj, prefix: str, anchors: list[int], seen: tuple[str, ...], own_prefix: bool = True) -> list[tuple[str, str, list[int], str, Module, int, dict | None]]:
        if obj.key in seen:
            return []
        prefix = prefix + (obj.prefix if own_prefix else "")
        anchors = anchors + obj.decl
        out = [(m, prefix + p, anchors + a, inline, obj.module, line, contract) for m, p, a, inline, line, contract in obj.routes]
        for key, include_prefix, replaces in obj.includes:
            out += self.expand(self.objects[key], prefix + include_prefix, anchors, (*seen, obj.key), not replaces)
        return out


def find_entries(graph: Graph) -> tuple[list[dict], list[dict]]:
    finder = RouteFinder(graph)
    finder.find_objects()
    finder.find_routes()
    apps = [o for o in finder.objects.values() if o.kind == "app"]
    # Several apps in one repository (one per service): their routes are labeled with the service.
    labels = {a.key: a.module.name.split(".")[0] for a in apps}
    if len(set(labels.values())) < len(apps):
        labels = {a.key: a.module.name.rsplit(".", 1)[0] or a.module.name for a in apps}
    if len(set(labels.values())) < len(apps):
        labels = {a.key: a.module.name for a in apps}
    entries: list[dict] = []
    for app in apps:
        module_code = graph.lookup(f"{app.module.name}.{MODULE_CODE}")
        for method, path, anchors, inline, module, line, contract in finder.expand(app, "", module_code, ()):
            label = f"{labels[app.key]} " if len(apps) > 1 else ""
            entry = {"key": f"{label}{method} {path or '/'}", "file": module.file, "line": line, "kind": "ws" if method == "WS" else "http", "anchors": sorted(set(anchors)), "inline": inline}
            if contract is not None:
                entry["contract"] = contract
            if any(c in path for c in finder.computed):
                entry["computed"] = True
            entries.append(entry)
    more, more_problems = find_more_entries(graph, finder)
    entries += more
    finder.problems += more_problems
    for module in graph.modules.values():
        if module.tree is not None and any(is_main_guard(s) for s in module.tree.body):
            anchors = [i for i, d in enumerate(graph.decls) if d.module is module]
            entries.append({"key": f"RUN {module.file}", "file": module.file, "line": 1, "kind": "main", "anchors": anchors, "inline": ""})
    entries.sort(key=lambda e: e["key"])
    return entries, finder.problems
