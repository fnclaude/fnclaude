// Package typefortransform is the Go port of the typefor primitive: it lowers
// each `typefor<T>()` / `typefor(value)` call to a tree of `Type.*` factory calls
// over the ttsc-shipped typescript-go checker, then elides the now-unreferenced
// `typefor` import. It is a TYPE/VALUE-argument primitive that derives the
// STRUCTURED runtime `Type` value a checker type spells, narrowed to
// `Type.func` / `Type.ctor` for a function / constructor type, `Type.tag` for a
// `Keyed<T, K>` brand, `Type.object` / `Type.intersection` for an anonymous
// record or intersection, and `Type.global` / `Type.imported` / `Type.typeLiteral`
// / `Type.union` / `Type.tuple` / `Type.generic` for everything else
// (tokens.DeriveNode; see derive.go).
//
// A value argument derives from the value's OWN type, never unwrapped: a class
// arrives as the constructor it is (a ConstructorType), not the instance it
// builds — the `.instance` accessor reads that, matching typefor.ts's
// documented contract.
//
// An immediate `.instance` / `.return` / `.args` / `.value` / `.tag` /
// `.type` / `.kind` property access on a matched call folds through to the
// surviving sub-tree instead of building the whole wrapper only to read one field
// back off it at runtime (tryFoldAccessor). A property access on anything else —
// an unfoldable use, such as a call result stored in a variable and accessed
// later — is left alone; the bare call still lowers, and the runtime field read
// on its result is correct, just not the tidiest output.
//
// The single owner host (cmd/ttsc-std) composes it as the `rhombusstd_typefor`
// stage.
package typefortransform

import (
	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/fnioc/std/transforms/internal/inlinetransform"
	"github.com/fnioc/std/transforms/internal/plugin"
	"github.com/fnioc/std/transforms/internal/tokens"
	"github.com/fnioc/std/transforms/internal/typeemit"
	"github.com/fnioc/std/transforms/internal/valueimport"
)

// typeforName is the exported identifier the transformer recognizes as typefor —
// matched on the resolved symbol so an aliased import (`import { typefor as t }`)
// still lowers.
const typeforName = "typefor"

// typeArgUnderivableCode is the diagnostic a TYPE-argument derivation raises when
// the type argument yields no derivable `Type` — an anonymous / structural type
// with no stable shape.
const typeArgUnderivableCode = "TYPE_ARG_TYPE_UNDERIVABLE"

// valueArgUnderivableCode is the diagnostic a VALUE-argument derivation raises
// when the value's own type yields no derivable `Type`.
const valueArgUnderivableCode = "VALUE_ARG_TYPE_UNDERIVABLE"

// accessorMismatchCode is the diagnostic the accessor peephole raises when a
// matched property name is a real TypeBase member but the call's derived kind
// does not carry it (`.return` on a named type) — distinct from the base type
// itself being underivable.
const accessorMismatchCode = "TYPEFOR_ACCESSOR_MISMATCH"

// accessorNames are the TypeBase member names the peephole folds through: every
// property Type.ts's kind-specific interfaces expose, plus the `kind`
// discriminant every one of them shares.
var accessorNames = map[string]bool{
	"instance":   true,
	"return":     true,
	"signatures": true,
	"value":      true,
	"tag":        true,
	"type":       true,
	"kind":       true,
}

// New builds the per-file transform: it visits every call expression, replacing
// each `typefor<T>()` / `typefor(value)` with the `Type.*` tree its argument
// derives, folds an immediate known-accessor property access through to the
// surviving sub-tree, and elides the now-unreferenced `typefor` import.
//
// artifacts is the inline stage's per-run state (nil when the inline stage did
// not run — behavior is then bit-for-bit the source-written-only path). A
// substituted call carries no checker symbol (its callee is a side-parsed
// clone), so it is anchored via inlinetransform.Artifacts; a source-written call
// is anchored by resolving its callee to the typefor symbol.
func New(
	prog *driver.Program,
	ctx *tokens.Context,
	artifacts *inlinetransform.Artifacts,
	hoist *Hoist,
	emit func(plugin.Diagnostic),
) plugin.FileTransform {
	checker := prog.Checker
	return func(ec *shimprinter.EmitContext, sf *shimast.SourceFile) *shimast.SourceFile {
		factory := ec.Factory.AsNodeFactory()
		// The `Type` binding is only ever USED by inline emission; a hoisted file
		// names no factory of its own, so the binding stays unreferenced and Ensure
		// injects nothing for it.
		binding := valueimport.Resolve(sf, typeemit.Ref)
		var hoisted *hoistEmitter
		var e emitter = &inlineEmitter{factory: factory, binding: binding}
		if hoist != nil {
			hoisted = newHoistEmitter(factory, hoist, sf, emit)
			e = hoisted
		}
		// Which primitive a callee is, and what its argument means, are facts about
		// SOURCE-WRITTEN syntax: gathered off the parse node, never re-asked of a
		// tree the loop has rewritten (plugin.CheckerAnchor).
		parseAnchor := plugin.NewCheckerAnchor(ec, sf)
		var visitor *shimast.NodeVisitor
		visit := func(node *shimast.Node) *shimast.Node {
			if node == nil {
				return nil
			}
			// A known-accessor property access is handled at the PARENT, before the
			// generic call-expression handling below ever sees the inner call: on a
			// fold it replaces the WHOLE property access, so the inner call is never
			// independently visited on this pass.
			if node.Kind == shimast.KindPropertyAccessExpression {
				if lowered, ok := tryFoldAccessor(checker, parseAnchor, artifacts, ctx, factory, e, emit, node); ok {
					return lowered
				}
			}
			if node.Kind == shimast.KindCallExpression {
				// TYPE-argument typefor<T>() — source-written.
				if t, ok := typeArgCall(checker, parseAnchor, node); ok {
					return lowerTyped(checker, ctx, e, emit, node, t, true)
				}
				// TYPE-argument typefor<T>() — synthetic (inline-substituted).
				if use, ok := registeredTypefor(artifacts, node); ok {
					return lowerTyped(checker, ctx, e, emit, node, use.TypeArgs[0], false)
				}
				// VALUE-argument typefor(value) — source-written.
				if arg, ok := valueArgCall(checker, parseAnchor, node); ok {
					return lowerValueArg(checker, ctx, e, emit, node, arg)
				}
				// VALUE-argument typefor(value) — synthetic (inline-substituted).
				if arg, ok := registeredValueArg(artifacts, node); ok {
					return lowerValueArg(checker, ctx, e, emit, node, arg)
				}
			}
			return visitor.VisitEachChild(node)
		}
		visitor = ec.NewNodeVisitor(visit)
		output := visitor.VisitNode(sf.AsNode())
		if output == nil {
			return sf
		}
		result := elideTypeforImports(factory, output.AsSourceFile())
		if hoisted != nil {
			return valueimport.Ensure(factory, result, hoisted.imports()...)
		}
		return valueimport.Ensure(factory, result, binding)
	}
}

// lowerTyped derives the `Type.*` tree for a TYPE-argument typefor call and
// returns its replacement, or leaves the ORIGINAL node un-lowered when
// derivation fails — never a malformed partial tree. A source-written failure
// reports the targeted diagnostic; a synthetic one stays silent — a mid-loop
// diagnostic would tie failure reporting to stage order within a pass, and the
// emit sweep already flags every surviving primitive exactly once after the loop
// settles.
func lowerTyped(
	checker *shimchecker.Checker,
	ctx *tokens.Context,
	e emitter,
	emit func(plugin.Diagnostic),
	node *shimast.Node,
	t *shimchecker.Type,
	sourceWritten bool,
) *shimast.Node {
	d, ok := tokens.DeriveNode(ctx, checker, t, nil)
	if !ok {
		if sourceWritten {
			emit(plugin.Diagnostic{
				Code:    typeArgUnderivableCode,
				File:    anchorFile(node),
				Start:   node.Pos(),
				Message: "cannot derive a Type for this type — name the type (an anonymous / structural type has no stable shape)",
			})
		}
		return node
	}
	if replacement := e.node(d); replacement != nil {
		return replacement
	}
	return node
}

// lowerValueArg derives the `Type.*` tree for a VALUE-argument typefor call from
// the argument's OWN type (never unwrapped) and returns its replacement, or
// reports a targeted diagnostic and leaves the ORIGINAL call un-lowered when
// derivation fails. arg is the program-bound value argument (a real position even
// when call itself is synthetic), so the diagnostic always points at real
// source.
func lowerValueArg(
	checker *shimchecker.Checker,
	ctx *tokens.Context,
	e emitter,
	emit func(plugin.Diagnostic),
	call, arg *shimast.Node,
) *shimast.Node {
	d, ok := tokens.DeriveNode(ctx, checker, checker.GetTypeAtLocation(arg), nil)
	if !ok {
		emit(plugin.Diagnostic{
			Code:    valueArgUnderivableCode,
			File:    anchorFile(arg),
			Start:   arg.Pos(),
			Message: "cannot derive a Type for this value's type — name the type (annotate the value with a named type)",
		})
		return call
	}
	if replacement := e.node(d); replacement != nil {
		return replacement
	}
	return call
}

// tryFoldAccessor handles a property access whose name is a known TypeBase
// member and whose object expression is a typefor call: it derives the call's
// full tree, applies the accessor structurally, and returns the surviving
// sub-tree in place of the whole property access. ok=false means "not a fold" —
// either the property name isn't a known accessor, the object expression isn't a
// typefor call, or the base type itself is underivable (left for the plain call
// handling below to report). When the accessor name IS known and the object IS a
// typefor call but the derived KIND doesn't carry that member, it reports
// accessorMismatchCode and returns the property access unchanged (ok=true: this
// pass leaves it exactly as written, matching a hard-error diagnostic elsewhere
// in this engine).
func tryFoldAccessor(
	checker *shimchecker.Checker,
	parseAnchor plugin.CheckerAnchor,
	artifacts *inlinetransform.Artifacts,
	ctx *tokens.Context,
	factory *shimast.NodeFactory,
	e emitter,
	emit func(plugin.Diagnostic),
	node *shimast.Node,
) (*shimast.Node, bool) {
	access := node.AsPropertyAccessExpression()
	accessorName := access.Name().Text()
	if !accessorNames[accessorName] {
		return nil, false
	}
	callNode := access.Expression

	var base *shimchecker.Type
	if t, ok := typeArgCall(checker, parseAnchor, callNode); ok {
		base = t
	} else if use, ok := registeredTypefor(artifacts, callNode); ok {
		base = use.TypeArgs[0]
	} else if arg, ok := valueArgCall(checker, parseAnchor, callNode); ok {
		base = checker.GetTypeAtLocation(arg)
	} else if arg, ok := registeredValueArg(artifacts, callNode); ok {
		base = checker.GetTypeAtLocation(arg)
	} else {
		return nil, false
	}

	d, ok := tokens.DeriveNode(ctx, checker, base, nil)
	if !ok {
		// The base type itself is underivable — leave the whole expression for the
		// bare call's own visit to report the targeted diagnostic.
		return nil, false
	}
	result, applies := emitAccessor(factory, e, d, accessorName)
	if !applies {
		emit(plugin.Diagnostic{
			Code:    accessorMismatchCode,
			File:    anchorFile(node),
			Start:   node.Pos(),
			Message: "`." + accessorName + "` does not apply to this typefor<T>() derivation — its kind is `" + tokens.KindName(d) + "`",
		})
		return node, true
	}
	if result == nil {
		return node, true
	}
	return result, true
}

// registeredTypefor reports whether node is a synthetic `typefor` call the
// inline stage registered with a resolved TYPE argument (`typefor<T>()`).
func registeredTypefor(artifacts *inlinetransform.Artifacts, node *shimast.Node) (inlinetransform.PrimitiveUse, bool) {
	if artifacts == nil {
		return inlinetransform.PrimitiveUse{}, false
	}
	use, ok := artifacts.PrimitiveCalls[node]
	if !ok || use.Name != typeforName || len(use.TypeArgs) == 0 {
		return inlinetransform.PrimitiveUse{}, false
	}
	return use, true
}

// registeredValueArg reports whether node is a synthetic VALUE-argument
// `typefor(value)` call the inline stage registered, carrying the ORIGINAL,
// program-bound call-site argument.
func registeredValueArg(artifacts *inlinetransform.Artifacts, node *shimast.Node) (*shimast.Node, bool) {
	if artifacts == nil {
		return nil, false
	}
	use, ok := artifacts.PrimitiveCalls[node]
	if !ok || use.Name != typeforName || use.ValueArg == nil || len(use.TypeArgs) != 0 {
		return nil, false
	}
	return use.ValueArg, true
}

// typeArgCall reports whether node is a source-written single-TYPE-argument call
// to typefor and returns the type argument's checker type. EVERYTHING IT HANDS
// THE CHECKER COMES OFF THE PARSE NODE (plugin.CheckerAnchor): a rewritten
// callee looks source-written but dragging the checker into a rebuilt chain is
// how it reaches a minted, symbol-less literal and nil-derefs.
func typeArgCall(checker *shimchecker.Checker, parseAnchor plugin.CheckerAnchor, node *shimast.Node) (*shimchecker.Type, bool) {
	call := parseAnchor.AnchoredCall(node)
	if call == nil {
		return nil, false
	}
	if call.TypeArguments == nil || len(call.TypeArguments.Nodes) != 1 {
		return nil, false
	}
	if !calleeIs(checker, call.Expression, typeforName) {
		return nil, false
	}
	return checker.GetTypeFromTypeNode(call.TypeArguments.Nodes[0]), true
}

// valueArgCall reports whether node is a source-written VALUE-argument call to
// typefor — a NO-type-argument, single-value-argument call — and returns its
// value argument.
func valueArgCall(checker *shimchecker.Checker, parseAnchor plugin.CheckerAnchor, node *shimast.Node) (*shimast.Node, bool) {
	call := parseAnchor.AnchoredCall(node)
	if call == nil {
		return nil, false
	}
	if call.TypeArguments != nil && len(call.TypeArguments.Nodes) != 0 {
		return nil, false
	}
	if call.Arguments == nil || len(call.Arguments.Nodes) != 1 {
		return nil, false
	}
	if !calleeIs(checker, call.Expression, typeforName) {
		return nil, false
	}
	return call.Arguments.Nodes[0], true
}

// calleeIs reports whether callee resolves (following an import alias) to
// typefor. callee must be a PARSE node — every caller takes it off a
// parse-anchored call.
func calleeIs(checker *shimchecker.Checker, callee *shimast.Node, primName string) bool {
	symbol := checker.GetSymbolAtLocation(callee)
	if symbol == nil {
		return false
	}
	if symbol.Flags&shimast.SymbolFlagsAlias != 0 {
		if aliased := checker.GetAliasedSymbol(symbol); aliased != nil {
			symbol = aliased
		}
	}
	return symbol.Name == primName
}

// anchorFile returns the absolute file path of a node's source file, or "" for a
// synthetic node with no source file. The inline stage captures the ORIGINAL
// program-bound argument for a value-arg registration, so this resolves for the
// synthetic path too.
func anchorFile(node *shimast.Node) string {
	if node == nil {
		return ""
	}
	if sf := shimast.GetSourceFileOfNode(node); sf != nil {
		return sf.FileName()
	}
	return ""
}

// elideTypeforImports drops the now-unreferenced `typefor` binding from the
// file's top-level imports. After the rewrite above there is no runtime
// reference left, but the toolchain's import elision consults the ORIGINAL
// reference marks, so without this pass a dangling `import { typefor } from
// "@rhombus-std/primitives.extras"` survives.
func elideTypeforImports(factory *shimast.NodeFactory, sf *shimast.SourceFile) *shimast.SourceFile {
	statements := sf.Statements.Nodes
	kept := make([]*shimast.Node, 0, len(statements))
	changed := false
	for _, statement := range statements {
		next := elideTypeforImport(factory, statement)
		if next == nil {
			changed = true
			continue
		}
		if next != statement {
			changed = true
		}
		kept = append(kept, next)
	}
	if !changed {
		return sf
	}
	return factory.UpdateSourceFile(sf, factory.NewNodeList(kept), sf.EndOfFileToken).AsSourceFile()
}

// elideTypeforImport returns the import statement with any `typefor` specifier
// removed — the whole declaration dropped (nil) when that was its only binding,
// kept with the remaining bindings otherwise. Matching mirrors typeArgCall's /
// valueArgCall's looseness: any named-import specifier whose EXPORTED name is
// `typefor` elides (so `import { typefor as t }` elides too).
func elideTypeforImport(factory *shimast.NodeFactory, statement *shimast.Node) *shimast.Node {
	if statement.Kind != shimast.KindImportDeclaration {
		return statement
	}
	decl := statement.AsImportDeclaration()
	clauseNode := decl.ImportClause
	if clauseNode == nil {
		return statement
	}
	clause := clauseNode.AsImportClause()
	if clause.PhaseModifier == shimast.KindTypeKeyword {
		return statement
	}
	bindings := clause.NamedBindings
	if bindings == nil || bindings.Kind != shimast.KindNamedImports {
		return statement
	}
	elements := bindings.AsNamedImports().Elements.Nodes
	kept := make([]*shimast.Node, 0, len(elements))
	for _, element := range elements {
		specifier := element.AsImportSpecifier()
		if specifier.IsTypeOnly || exportedName(element) != typeforName {
			kept = append(kept, element)
		}
	}
	if len(kept) == len(elements) {
		return statement
	}
	if len(kept) == 0 && clause.Name() == nil {
		return nil
	}
	var namedBindings *shimast.Node
	if len(kept) != 0 {
		namedBindings = factory.UpdateNamedImports(bindings.AsNamedImports(), factory.NewNodeList(kept))
	}
	newClause := factory.UpdateImportClause(clause, clause.PhaseModifier, clause.Name(), namedBindings)
	return factory.UpdateImportDeclaration(decl, decl.Modifiers(), newClause, decl.ModuleSpecifier, decl.Attributes)
}

// exportedName is a named import specifier's exported name — its property name
// (`typefor` in `typefor as t`) when aliased, else its local name.
func exportedName(element *shimast.Node) string {
	specifier := element.AsImportSpecifier()
	if specifier.PropertyName != nil {
		return specifier.PropertyName.Text()
	}
	return element.Name().Text()
}
