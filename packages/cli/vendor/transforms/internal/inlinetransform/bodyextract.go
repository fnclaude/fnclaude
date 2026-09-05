package inlinetransform

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"

	"github.com/fnioc/std/transforms/internal/valueimport"
)

// knownPrimitives maps each compile-time primitive an inlineable body may call to
// its HOME module — the module an inline body is allowed to import it from. Both
// home in the authoring package `@rhombus-std/primitives.extras` (constraint 11:
// pure transformables, moved out of the runtime `@rhombus-std/primitives` leaf —
// every call is elided from the shipped output after lowering, so nothing ships a
// reference and a consumer deps the authoring package build-time only).
// `typefor<T>()` / `typefor(value)` bind a TYPE or VALUE argument and lower to a
// structured runtime `Type` value (the `Type.*` factory tree the argument
// spells); a VALUE argument also carries a constructor's or factory's
// dependency-signature derivation.
// `schemaof<T>()` binds a TYPE argument and lowers to the config family's runtime
// schema object literal — the engine half of the `.withType<T>()` sugar body
// `this.withSchema(schemaof<T>())`. It is authoring-time-only and homes beside
// `typefor` in `@rhombus-std/primitives.extras`.
var knownPrimitives = map[string]string{
	"schemaof": "@rhombus-std/primitives.extras",
	"typefor":  "@rhombus-std/primitives.extras",
}

// knownAuthoringMarkers maps each MODULE-LEVEL authoring marker an impl file may
// import to its HOME module. A marker is the one import category that never
// appears INSIDE a body: it is a no-op call placed BESIDE a body set
// (`registerInlineBodies(ManifestChainInline)`) stating in code that the set is
// published in its package's package.json "rhombus-std" marker "inline" list — the one
// relationship a reader would otherwise have to open the manifest to discover.
//
// It is named here for one reason: a marker is a VALUE import, so without this
// exclusion valueImports would record it as a phantom body reference. A marker
// call is a top-level statement, invisible to the declaration lookup, and a body
// that references one is rejected by checkFreeIdentifiers like any other unknown
// identifier.
var knownAuthoringMarkers = map[string]string{
	"registerInlineBodies": "@rhombus-std/primitives.extras",
}

// Discriminator is the structural overload key: (type-parameter count, value
// parameter count + encodings). A `this` parameter is excluded from both count
// and list; a binding-pattern parameter encodes as "<pattern>"; a rest
// parameter is prefixed "...". No type text is ever read — the encoding is a
// pure structural fingerprint used to separate a member's sugar overload from
// its runtime overloads.
type Discriminator struct {
	TypeParamCount int
	Params         []string
}

// consumedPositions returns a mask over rb.TypeParams marking which positions
// rb.ConsumedTypeParams names, and whether any position is consumed at all —
// the shape RecoverTypeArguments' required parameter takes.
func (rb *ResolvedBody) consumedPositions() ([]bool, bool) {
	mask := make([]bool, len(rb.TypeParams))
	any := false
	for i, tp := range rb.TypeParams {
		if rb.ConsumedTypeParams[tp] {
			mask[i] = true
			any = true
		}
	}
	return mask, any
}

// Equal reports structural equality of two discriminators.
func (d Discriminator) Equal(o Discriminator) bool {
	if d.TypeParamCount != o.TypeParamCount || len(d.Params) != len(o.Params) {
		return false
	}
	for i := range d.Params {
		if d.Params[i] != o.Params[i] {
			return false
		}
	}
	return true
}

// ResolvedBody is the side-parsed impl body plus the metadata substitution and
// classification need: the single return expression, the impl's type-parameter
// and value-parameter names in order, its structural discriminator, and the impl
// file's primitive-import map (local name -> canonical primitive name).
type ResolvedBody struct {
	Body       *shimast.Node
	TypeParams []string
	Params     []string
	// RequiredParams counts the leading value parameters a call must supply an
	// argument for; the rest of Params are the optional tail it may stop short of.
	RequiredParams int
	Discriminator  Discriminator
	// ConsumedTypeParams is the subset of TypeParams the body's own primitive
	// calls bind by name — `typefor<T>()` consumes T, `typefor(value)` consumes
	// nothing. Only a consumed type parameter needs a type argument at the call
	// site; the rest are free to go unwritten and are never recovered.
	ConsumedTypeParams map[string]bool
	PrimitiveImports   map[string]string
	// ValueImports maps each body-local name of a RUNTIME value the body references
	// to the (module, export) its import materializes to. These survive lowering as
	// ordinary references, and the inline stage injects the same imports into the
	// consumer file so each one resolves there as it does here.
	ValueImports map[string]valueimport.Ref
	File         string
}

// bodyExtractor side-parses declaring packages, caching each parsed file by its
// absolute path for the life of one build.
type bodyExtractor struct {
	cache map[string]*shimast.SourceFile
	// ownerByDir caches each directory's nearest-enclosing package name, for the
	// declaration-ownership test.
	ownerByDir map[string]string
}

func newBodyExtractor() *bodyExtractor {
	return &bodyExtractor{cache: map[string]*shimast.SourceFile{}, ownerByDir: map[string]string{}}
}

// declarationPackage returns the name of the package that owns d's source file —
// the nearest enclosing package.json's "name" — or "". The walk is package-level
// rather than file-level so it answers identically for a package's src and for
// the rolled dist a consumer resolves through.
func (b *bodyExtractor) declarationPackage(d *shimast.Node) string {
	file := nodeFile(d)
	if file == "" {
		return ""
	}
	dir := filepath.Dir(file)
	if cached, ok := b.ownerByDir[dir]; ok {
		return cached
	}
	name := ""
	for probe := dir; ; {
		if fileExists(filepath.Join(probe, "package.json")) {
			name = packageName(probe)
			break
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			break
		}
		probe = parent
	}
	b.ownerByDir[dir] = name
	return name
}

// parseFile side-parses path once, caching the result.
func (b *bodyExtractor) parseFile(path string) (*shimast.SourceFile, error) {
	if sf, ok := b.cache[path]; ok {
		return sf, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	sf := SideParse(path, string(data))
	b.cache[path] = sf
	return sf, nil
}

// Extract locates the impl body for entry e in packageDir and returns the
// resolved body. e.Impl is a fully-qualified "<package>:<Name>" reference (Kind
// has already certified it self-references packageDir); Name is what the
// impl-file search order (entry file → intra-package re-exports → the
// conventional src/inline.ts fallback) looks for. It then reads the member (or
// floater) signature and the impl file's primitive imports.
func (b *bodyExtractor) Extract(packageDir string, e Entry) (*ResolvedBody, error) {
	kind, _ := e.Kind()

	implRef, err := ParseTypeRef(e.Impl)
	if err != nil {
		return nil, fmt.Errorf("INLINE_ENTRY_SHAPE: %w", err)
	}

	implFile, implNode, err := b.locateImpl(packageDir, implRef.Name)
	if err != nil {
		return nil, err
	}
	implSF := b.cache[implFile]

	var memberNode *shimast.Node
	switch kind {
	case KindFloater:
		memberNode = implNode // the function declaration itself
	default:
		memberNode = findMemberDeclaration(implNode, e.Member)
		if memberNode == nil {
			return nil, fmt.Errorf("INLINE_IMPL_NOT_FOUND: package %s impl %q has no member %q", packageDir, e.Impl, e.Member)
		}
	}

	body := functionLikeBody(memberNode)
	if body == nil {
		return nil, fmt.Errorf("INLINE_BODY_SHAPE: %s impl %q member %q has no block body", implFile, e.Impl, e.Member)
	}
	expr := SingleReturnExpression(body)
	if expr == nil {
		return nil, fmt.Errorf("INLINE_BODY_SHAPE: %s impl %q member %q is not a single return expression", implFile, e.Impl, e.Member)
	}

	typeParams := typeParamNames(memberNode)
	params, disc := valueParamsAndDiscriminator(memberNode, typeParams)
	primImports := primitiveImports(implSF, packageName(packageDir))

	rb := &ResolvedBody{
		Body:               expr,
		TypeParams:         typeParams,
		Params:             params,
		RequiredParams:     requiredParamCount(memberNode),
		Discriminator:      disc,
		ConsumedTypeParams: consumedTypeParams(expr, typeParams, primImports),
		PrimitiveImports:   primImports,
		ValueImports:       map[string]valueimport.Ref{},
		File:               implFile,
	}
	// The impl file's value imports are file-wide (every body in inline.ts shares
	// them), so the walk below records only the ones THIS body references — a body
	// materializes an import for a value it names, never for a sibling body's.
	if err := b.checkFreeIdentifiers(rb, e, valueImports(implSF)); err != nil {
		return nil, err
	}
	return rb, nil
}

// locateImpl finds the file and top-level declaration node introducing implName,
// following the search order in the build spec.
func (b *bodyExtractor) locateImpl(packageDir, implName string) (string, *shimast.Node, error) {
	entryFile, err := resolveEntryFile(packageDir)
	if err != nil {
		return "", nil, err
	}

	searched := []string{}
	seen := map[string]bool{}
	queue := []string{entryFile}
	for len(queue) > 0 {
		file := queue[0]
		queue = queue[1:]
		if seen[file] {
			continue
		}
		seen[file] = true
		sf, perr := b.parseFile(file)
		if perr != nil {
			continue
		}
		searched = append(searched, file)
		if node := findTopLevelDeclaration(sf, implName); node != nil {
			return file, node, nil
		}
		for _, target := range reExportTargets(sf) {
			resolved := resolveRelativeModule(filepath.Dir(file), target)
			if resolved != "" && !seen[resolved] {
				queue = append(queue, resolved)
			}
		}
	}

	// Fallback: the conventional src/inline.ts, kept out of the barrel so its
	// unbound typefor<T>() is never lowered inside the declaring package's own dist.
	fallback := filepath.Join(packageDir, "src", "inline.ts")
	if fileExists(fallback) {
		sf, perr := b.parseFile(fallback)
		if perr == nil {
			searched = append(searched, fallback)
			if node := findTopLevelDeclaration(sf, implName); node != nil {
				return fallback, node, nil
			}
		}
	}

	return "", nil, fmt.Errorf("INLINE_IMPL_NOT_FOUND: package %s export %q not found; searched %v", packageDir, implName, searched)
}

// checkFreeIdentifiers rejects a body whose returned expression references any
// identifier that is not a value param, `this`, an impl type param (in a
// primitive-call type-argument position), a recorded primitive import, or a bare
// reference to a value the impl file imports. This is the defense-in-depth twin of
// the authoring lint's freeIdentifier rule.
//
// fileValueImports is the impl file's whole value-import map; each one the body
// names is recorded into rb.ValueImports as the walk reaches it, so the recorded
// set is exactly the referenced set.
func (b *bodyExtractor) checkFreeIdentifiers(rb *ResolvedBody, e Entry, fileValueImports map[string]valueimport.Ref) error {
	allowed := map[string]bool{}
	for _, p := range rb.Params {
		allowed[strings.TrimPrefix(p, "...")] = true
	}
	// The blind whole-argument-set stand-in: legal in any body, spliced at the
	// call site rather than referenced at runtime.
	allowed["arguments"] = true
	for _, tp := range rb.TypeParams {
		allowed[tp] = true
	}
	for local := range rb.PrimitiveImports {
		allowed[local] = true
	}
	// A dedicated value-position walk. It flags any identifier that is not an
	// allowed value reference, descending into every VALUE child so a free
	// identifier ANYWHERE is reached — including a call argument that follows a
	// property-access callee (`this.isService(n<T>())`), the position a prior
	// short-circuit skipped. Two identifier positions are deliberately NOT value
	// references and are never checked:
	//   - a property access's member NAME (`a.b`: the `b`); and
	//   - a TYPE ARGUMENT (`typefor<Marker>()`: `Marker` — a type the consumer's
	//     checker resolves, not a value). Skipping the whole TypeArguments list of
	//     a call/new covers any type shape inside it (unions, nested refs, …).
	var bad string
	var check func(n *shimast.Node)
	check = func(n *shimast.Node) {
		if n == nil || bad != "" {
			return
		}
		switch n.Kind {
		case shimast.KindIdentifier:
			name := n.Text()
			if allowed[name] {
				return
			}
			// The file's import declares the value: record it so the inline stage
			// materializes the same import into the consumer.
			if ref, imported := fileValueImports[name]; imported {
				rb.ValueImports[name] = ref
				return
			}
			bad = name
			return
		case shimast.KindPropertyAccessExpression:
			base := n.AsPropertyAccessExpression().Expression
			if base.Kind == shimast.KindIdentifier {
				// The head of a property chain is the body's receiver or one of its
				// parameters. An imported value is reachable as a bare identifier only,
				// so it never satisfies this position.
				if !allowed[base.Text()] {
					bad = base.Text()
				}
				return
			}
			check(base)
			return
		case shimast.KindCallExpression:
			call := n.AsCallExpression()
			check(call.Expression)
			if call.Arguments != nil {
				for _, arg := range call.Arguments.Nodes {
					check(arg)
				}
			}
			return
		case shimast.KindNewExpression:
			nw := n.AsNewExpression()
			check(nw.Expression)
			if nw.Arguments != nil {
				for _, arg := range nw.Arguments.Nodes {
					check(arg)
				}
			}
			return
		}
		n.ForEachChild(func(child *shimast.Node) bool {
			check(child)
			return bad != ""
		})
	}
	check(rb.Body)

	if bad != "" {
		return fmt.Errorf("INLINE_BODY_FREE_IDENTIFIER: %s impl %q member %q references %q, which is neither a parameter, type parameter, primitive import, nor a value the file imports", rb.File, e.Impl, e.Member, bad)
	}
	return nil
}

// findMemberDeclaration returns the member declaration node named memberName on
// the impl (object-literal method / property assignment / class method), or nil.
func findMemberDeclaration(impl *shimast.Node, memberName string) *shimast.Node {
	var found *shimast.Node
	walk(impl, func(node *shimast.Node) bool {
		switch node.Kind {
		case shimast.KindMethodDeclaration, shimast.KindPropertyAssignment:
			if name := node.Name(); name != nil && name.Text() == memberName {
				found = node
				return true
			}
		case shimast.KindFunctionDeclaration:
			// An overloaded namespace function declares each shape as a bodiless
			// signature ahead of the one implementation; the implementation is the
			// declaration this reads, so a signature-only node is passed over.
			if name := node.Name(); name != nil && name.Text() == memberName &&
				node.AsFunctionDeclaration().Body != nil {
				found = node
				return true
			}
		}
		return false
	})
	return found
}

// functionLikeNode normalizes a member/function declaration to the node whose
// FunctionLikeData carries type params, parameters, and (where present) a body:
// a property assignment unwraps to its function/arrow initializer; everything
// else (method signature, method declaration, function declaration) is already
// function-like.
func functionLikeNode(node *shimast.Node) *shimast.Node {
	if node.Kind == shimast.KindPropertyAssignment {
		init := node.AsPropertyAssignment().Initializer
		if init != nil && (init.Kind == shimast.KindFunctionExpression || init.Kind == shimast.KindArrowFunction) {
			return init
		}
		return nil
	}
	return node
}

// typeParamNames returns the type-parameter names declared on a member or
// function-like node, in order.
func typeParamNames(node *shimast.Node) []string {
	fn := functionLikeNode(node)
	if fn == nil {
		return nil
	}
	tps := fn.TypeParameters()
	out := make([]string, 0, len(tps))
	for _, tp := range tps {
		if name := tp.Name(); name != nil {
			out = append(out, name.Text())
		}
	}
	return out
}

// valueParamsAndDiscriminator returns the value-parameter names (this excluded)
// and the structural discriminator for a member/function node.
func valueParamsAndDiscriminator(node *shimast.Node, typeParams []string) ([]string, Discriminator) {
	params := functionLikeParams(node)
	names := []string{}
	encoded := []string{}
	for _, p := range params {
		decl := p.AsParameterDeclaration()
		name := decl.Name()
		// Exclude a `this` parameter entirely.
		if name != nil && name.Kind == shimast.KindIdentifier && name.Text() == "this" {
			continue
		}
		var enc string
		switch {
		case name != nil && name.Kind == shimast.KindIdentifier:
			enc = name.Text()
			names = append(names, name.Text())
		default:
			enc = "<pattern>"
			names = append(names, "<pattern>")
		}
		if decl.DotDotDotToken != nil {
			enc = "..." + enc
			names[len(names)-1] = "..." + names[len(names)-1]
		}
		encoded = append(encoded, enc)
	}
	return names, Discriminator{TypeParamCount: len(typeParams), Params: encoded}
}

// bodyHasRestParam reports whether a body's last value parameter is a rest
// parameter, per the "..." encoding valueParamsAndDiscriminator applies.
func bodyHasRestParam(params []string) bool {
	return len(params) > 0 && strings.HasPrefix(params[len(params)-1], "...")
}

// requiredParamCount counts the leading value parameters (a `this` parameter
// excluded) that a call must supply an argument for — those declared before the
// first one carrying `?` or a default.
func requiredParamCount(node *shimast.Node) int {
	required := 0
	for _, p := range functionLikeParams(node) {
		decl := p.AsParameterDeclaration()
		name := decl.Name()
		if name != nil && name.Kind == shimast.KindIdentifier && name.Text() == "this" {
			continue
		}
		if decl.QuestionToken != nil || decl.Initializer != nil || decl.DotDotDotToken != nil {
			break
		}
		required++
	}
	return required
}

// Matches reports whether a body's discriminator names the declaration's own
// signature exactly: same type-parameter count, same value parameters by name
// and order. It is the per-overload pairing within one publisher's owned faces
// — a body with its own declared signature serves the one face spelling it,
// while a rest-shaped body serves as the blanket for every face no
// exact-signature body claims (assignBodies).
func (d Discriminator) Matches(decl Discriminator) bool {
	return d.Equal(decl)
}

// declarationDiscriminator computes the structural discriminator of a merged
// declaration node (a method signature, method, or function declaration). A
// trailing rest parameter is unrolled into the individual elements of its
// fixed tuple shape first, when it has one — see unrollTrailingRestTuple.
func declarationDiscriminator(checker *shimchecker.Checker, node *shimast.Node) Discriminator {
	tps := typeParamNames(node)
	_, disc := valueParamsAndDiscriminator(node, tps)
	return unrollTrailingRestTuple(checker, node, disc)
}

// unrollTrailingRestTuple replaces a trailing rest parameter's single "..."
// entry with the individual named elements of its tuple shape, when its type
// resolves to one fixed, fully-labeled tuple (tupleShapeOf) — the concrete
// case is a rest parameter typed through a conditional alias like
// `LifetimeArgument<Lifetime> = undefined extends Lifetime ? [lifetime?: Lifetime] : [lifetime: Lifetime]`,
// which is a rest parameter at the AST level but names exactly one member in
// every branch, and so pairs with a plain `(implementer, lifetime?)` body the
// same way an ordinary named parameter would. A rest parameter whose type does
// not reduce to one fixed shape (a plain array type, an unlabeled tuple
// element, a conditional whose branches disagree) is left as a plain rest.
func unrollTrailingRestTuple(checker *shimchecker.Checker, node *shimast.Node, disc Discriminator) Discriminator {
	if len(disc.Params) == 0 || !strings.HasPrefix(disc.Params[len(disc.Params)-1], "...") {
		return disc
	}
	rest := lastValueParam(node)
	if rest == nil {
		return disc
	}
	elems, ok := tupleShapeOf(checker, rest.AsParameterDeclaration().Type)
	if !ok {
		return disc
	}
	unrolled := make([]string, 0, len(disc.Params)-1+len(elems))
	unrolled = append(unrolled, disc.Params[:len(disc.Params)-1]...)
	for _, e := range elems {
		if e.rest {
			unrolled = append(unrolled, "..."+e.name)
		} else {
			unrolled = append(unrolled, e.name)
		}
	}
	disc.Params = unrolled
	return disc
}

// lastValueParam returns a function-like node's last value parameter (a
// `this` parameter excluded), or nil for a node with none.
func lastValueParam(node *shimast.Node) *shimast.Node {
	var last *shimast.Node
	for _, p := range functionLikeParams(node) {
		name := p.AsParameterDeclaration().Name()
		if name != nil && name.Kind == shimast.KindIdentifier && name.Text() == "this" {
			continue
		}
		last = p
	}
	return last
}

// tupleElement is one labeled member of a resolved tuple shape.
type tupleElement struct {
	name string
	rest bool
}

// tupleShapeOf resolves typeNode to its fixed, fully-labeled tuple shape:
// unwrapping a parenthesized type, recursing into a type alias reference's own
// written type (never a checker-instantiated one, so an alias generic over the
// reference's own type arguments resolves by shape alone, independent of what
// those arguments are), and unifying a conditional type's two branches when
// they reduce to the identical shape. It reports ok=false for anything that
// does not reduce to one fixed shape this way: an array type, a tuple with an
// unlabeled element (nothing to pair a body parameter's name against), or a
// conditional whose branches disagree.
func tupleShapeOf(checker *shimchecker.Checker, typeNode *shimast.Node) ([]tupleElement, bool) {
	if typeNode == nil {
		return nil, false
	}
	switch typeNode.Kind {
	case shimast.KindParenthesizedType:
		return tupleShapeOf(checker, typeNode.AsParenthesizedTypeNode().Type)
	case shimast.KindTupleType:
		return namedTupleElements(typeNode.AsTupleTypeNode())
	case shimast.KindConditionalType:
		cond := typeNode.AsConditionalTypeNode()
		trueShape, ok1 := tupleShapeOf(checker, cond.TrueType)
		falseShape, ok2 := tupleShapeOf(checker, cond.FalseType)
		if !ok1 || !ok2 || !tupleShapesEqual(trueShape, falseShape) {
			return nil, false
		}
		return trueShape, true
	case shimast.KindTypeReference:
		return tupleShapeOfAlias(checker, typeNode)
	default:
		return nil, false
	}
}

// namedTupleElements extracts a tuple type node's own label/rest shape,
// succeeding only when every element is named — an unlabeled element has
// nothing to pair a body parameter's name against.
func namedTupleElements(tuple *shimast.TupleTypeNode) ([]tupleElement, bool) {
	if tuple.Elements == nil {
		return nil, true
	}
	elems := make([]tupleElement, 0, len(tuple.Elements.Nodes))
	for _, el := range tuple.Elements.Nodes {
		if el.Kind != shimast.KindNamedTupleMember {
			return nil, false
		}
		member := el.AsNamedTupleMember()
		name := member.Name()
		if name == nil || name.Kind != shimast.KindIdentifier {
			return nil, false
		}
		elems = append(elems, tupleElement{name: name.Text(), rest: member.DotDotDotToken != nil})
	}
	return elems, true
}

// tupleShapeOfAlias resolves a type-reference node to the type alias it names
// — following an import alias, since a rest parameter's type is routinely
// spelled through a `import type { X } from '…'` binding rather than a
// locally-declared one — and recurses into the alias's own written type. A
// reference to anything but a type alias (an interface, a class, an ambient
// global) is not a fixed tuple shape.
func tupleShapeOfAlias(checker *shimchecker.Checker, typeNode *shimast.Node) ([]tupleElement, bool) {
	name := typeNode.AsTypeReferenceNode().TypeName
	if name == nil || name.Kind != shimast.KindIdentifier {
		return nil, false
	}
	sym := checker.GetSymbolAtLocation(name)
	if sym == nil {
		return nil, false
	}
	if sym.Flags&shimast.SymbolFlagsAlias != 0 {
		if aliased := checker.GetAliasedSymbol(sym); aliased != nil {
			sym = aliased
		}
	}
	for _, d := range sym.Declarations {
		if d.Kind == shimast.KindTypeAliasDeclaration {
			return tupleShapeOf(checker, d.AsTypeAliasDeclaration().Type)
		}
	}
	return nil, false
}

// tupleShapesEqual reports whether two resolved tuple shapes have the same
// elements in the same order, ignoring nothing — a conditional's two branches
// pair only when they agree exactly.
func tupleShapesEqual(a, b []tupleElement) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// functionLikeParams returns the parameter list of a method-signature / method /
// function / arrow node (unwrapping a property assignment).
func functionLikeParams(node *shimast.Node) []*shimast.Node {
	fn := functionLikeNode(node)
	if fn == nil {
		return nil
	}
	list := fn.ParameterList()
	if list == nil {
		return nil
	}
	return list.Nodes
}

// consumedTypeParams walks body for calls to one of primImports and returns the
// set of typeParams their written type-argument nodes reference, at any depth.
// `typefor<T>()` consumes T and so does `typefor<Func<Args, T>>()`, which spells
// both of its own; `typefor(value)` — a value-argument call with no type-argument
// list at all — consumes nothing; `typefor<Marker>()` over some other, concrete
// type consumes nothing either, since the reference is not to one of the body's
// own type parameters.
func consumedTypeParams(body *shimast.Node, typeParams []string, primImports map[string]string) map[string]bool {
	declared := make(map[string]bool, len(typeParams))
	for _, tp := range typeParams {
		declared[tp] = true
	}
	consumed := map[string]bool{}
	walk(body, func(n *shimast.Node) bool {
		if n.Kind != shimast.KindCallExpression {
			return false
		}
		callee := n.AsCallExpression().Expression
		if callee.Kind != shimast.KindIdentifier {
			return false
		}
		if _, ok := primImports[callee.Text()]; !ok {
			return false
		}
		typeArgs := n.AsCallExpression().TypeArguments
		if typeArgs == nil {
			return false
		}
		for _, ta := range typeArgs.Nodes {
			for _, name := range typeParamsIn(ta, declared) {
				consumed[name] = true
			}
		}
		return false
	})
	return consumed
}

// typeParamsIn returns, in first-appearance order, the declared type parameters a
// type node references anywhere within it — the node itself when it is a bare
// reference, and every reference nested inside a composed one (a generic
// instantiation's own type arguments, a tuple's elements, a union's members, a
// function type's parameters and return).
func typeParamsIn(node *shimast.Node, declared map[string]bool) []string {
	var found []string
	seen := map[string]bool{}
	var visit func(n *shimast.Node)
	visit = func(n *shimast.Node) {
		if n == nil {
			return
		}
		if n.Kind == shimast.KindTypeReference {
			name := n.AsTypeReferenceNode().TypeName
			if name != nil && name.Kind == shimast.KindIdentifier && declared[name.Text()] && !seen[name.Text()] {
				seen[name.Text()] = true
				found = append(found, name.Text())
			}
		}
		n.ForEachChild(func(child *shimast.Node) bool {
			visit(child)
			return false
		})
	}
	visit(node)
	return found
}

// primitiveImports reads sf's top-level named imports and returns a local-name ->
// primitive-name map, keeping only known primitives imported from their HOME
// module and only unaliased bindings (the authoring lint forbids aliasing).
//
// A primitive is accepted from its home module directly (`typefor` from
// `@rhombus-std/primitives.extras`), OR — when the primitive's home IS the declaring
// package — via a package-relative specifier (`schemaof` from `./schemaof`,
// authored inside `@rhombus-std/primitives.extras`), so a same-package authoring
// primitive need not be self-imported by package name. A primitive imported from
// any OTHER module is rejected.
func primitiveImports(sf *shimast.SourceFile, declaringPkg string) map[string]string {
	out := map[string]string{}
	if sf == nil {
		return out
	}
	for _, stmt := range sf.Statements.Nodes {
		if stmt.Kind != shimast.KindImportDeclaration {
			continue
		}
		decl := stmt.AsImportDeclaration()
		spec := decl.ModuleSpecifier
		if spec == nil || spec.Kind != shimast.KindStringLiteral {
			continue
		}
		module := spec.Text()
		clause := decl.ImportClause
		if clause == nil {
			continue
		}
		bindings := clause.AsImportClause().NamedBindings
		if bindings == nil || bindings.Kind != shimast.KindNamedImports {
			continue
		}
		for _, el := range bindings.AsNamedImports().Elements.Nodes {
			exported := importSpecifierExportedName(el)
			local := el.Name().Text()
			home, known := knownPrimitives[exported]
			if !known || exported != local {
				continue
			}
			fromHome := module == home
			fromOwnPackage := isRelativeSpecifier(module) && home == declaringPkg
			if fromHome || fromOwnPackage {
				out[local] = exported
			}
		}
	}
	return out
}

// valueImports reads sf's top-level named imports and returns a local-name ->
// (module, export) map of the RUNTIME values a body authored in sf may reference.
// The import declaration IS the declaration: a free identifier in a body is legal
// exactly when the file imports it, and the inline stage materializes the same
// (module, export) into the consumer file through the valueimport engine, so the
// reference resolves at the call site as it does at the authoring site.
//
// A binding qualifies when it is a NAMED import from a BARE package specifier that
// carries a runtime value. Three kinds are excluded:
//
//   - a type-only clause or specifier — it has no runtime value to reference;
//   - a compile-time primitive (knownPrimitives), recorded separately by
//     primitiveImports and lowered away rather than materialized. Excluding it by
//     NAME, not by module, keeps a primitive imported from the wrong module an
//     authoring error instead of quietly becoming a materialized runtime call;
//   - a module-level authoring marker (knownAuthoringMarkers), which is a no-op
//     placed BESIDE a body set and never inside a body.
//
// A relative specifier is excluded too: it addresses a file inside the declaring
// package, which a consumer's program cannot resolve.
//
// Aliasing is honored — `import { overrideSignatures as merge }` binds the local
// name `merge` to the export `overrideSignatures`, and the consumer's injected
// import names `overrideSignatures`.
func valueImports(sf *shimast.SourceFile) map[string]valueimport.Ref {
	out := map[string]valueimport.Ref{}
	if sf == nil {
		return out
	}
	for _, stmt := range sf.Statements.Nodes {
		if stmt.Kind != shimast.KindImportDeclaration {
			continue
		}
		decl := stmt.AsImportDeclaration()
		spec := decl.ModuleSpecifier
		if spec == nil || spec.Kind != shimast.KindStringLiteral {
			continue
		}
		module := spec.Text()
		if isRelativeSpecifier(module) {
			continue
		}
		clauseNode := decl.ImportClause
		if clauseNode == nil {
			continue
		}
		clause := clauseNode.AsImportClause()
		if clause.PhaseModifier == shimast.KindTypeKeyword {
			continue
		}
		bindings := clause.NamedBindings
		if bindings == nil || bindings.Kind != shimast.KindNamedImports {
			continue
		}
		for _, el := range bindings.AsNamedImports().Elements.Nodes {
			if el.AsImportSpecifier().IsTypeOnly {
				continue
			}
			exported := importSpecifierExportedName(el)
			if _, isPrimitive := knownPrimitives[exported]; isPrimitive {
				continue
			}
			if _, isMarker := knownAuthoringMarkers[exported]; isMarker {
				continue
			}
			out[el.Name().Text()] = valueimport.Ref{Module: module, Export: exported}
		}
	}
	return out
}

// isRelativeSpecifier reports whether an import specifier is package-relative
// (`./x` / `../x`) rather than a bare package name.
func isRelativeSpecifier(module string) bool {
	return strings.HasPrefix(module, ".")
}

// importSpecifierExportedName returns a named import specifier's exported name —
// its property name when aliased (`typefor as t`), else its local name.
func importSpecifierExportedName(element *shimast.Node) string {
	spec := element.AsImportSpecifier()
	if spec.PropertyName != nil {
		return spec.PropertyName.Text()
	}
	return element.Name().Text()
}

// reExportTargets returns the module specifiers of a file's intra-package
// re-exports: `export { X } from './y'` and `export * from './y'`. Only
// relative specifiers matter for the intra-package walk.
func reExportTargets(sf *shimast.SourceFile) []string {
	var out []string
	for _, stmt := range sf.Statements.Nodes {
		if stmt.Kind != shimast.KindExportDeclaration {
			continue
		}
		spec := stmt.AsExportDeclaration().ModuleSpecifier
		if spec != nil && spec.Kind == shimast.KindStringLiteral {
			text := spec.Text()
			if strings.HasPrefix(text, ".") {
				out = append(out, text)
			}
		}
	}
	return out
}

// resolveRelativeModule resolves a relative module specifier against baseDir to
// an on-disk .ts file (./x -> ./x.ts | ./x/index.ts), stripping a .js extension
// the source-lib convention writes.
func resolveRelativeModule(baseDir, specifier string) string {
	stripped := specifier
	for _, ext := range []string{".js", ".mjs", ".cjs"} {
		if strings.HasSuffix(stripped, ext) {
			stripped = strings.TrimSuffix(stripped, ext)
			break
		}
	}
	base := filepath.Clean(filepath.Join(baseDir, filepath.FromSlash(stripped)))
	for _, candidate := range []string{base + ".ts", filepath.Join(base, "index.ts")} {
		if fileExists(candidate) {
			return candidate
		}
	}
	return ""
}

// resolveEntryFile returns the declaring package's src entry file: the "." export
// condition preferring a "*-source" condition, else "source", else ./src/index.ts.
func resolveEntryFile(packageDir string) (string, error) {
	data, err := os.ReadFile(filepath.Join(packageDir, "package.json"))
	if err != nil {
		return "", fmt.Errorf("INLINE_NO_SRC_ENTRY: cannot read package.json in %s: %w", packageDir, err)
	}
	var pkg struct {
		Exports json.RawMessage `json:"exports"`
	}
	_ = json.Unmarshal(data, &pkg)

	if rel := dotExportSource(pkg.Exports); rel != "" {
		abs := filepath.Join(packageDir, filepath.FromSlash(rel))
		if fileExists(abs) {
			return abs, nil
		}
	}
	def := filepath.Join(packageDir, "src", "index.ts")
	if fileExists(def) {
		return def, nil
	}
	return "", fmt.Errorf("INLINE_NO_SRC_ENTRY: package %s has no resolvable src entry file", packageDir)
}

// dotExportSource extracts the src-facing target of the "." export, preferring a
// "<pkg>-source" condition, then "source", then "types"/"bun" pointing at src.
func dotExportSource(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var exports map[string]json.RawMessage
	if err := json.Unmarshal(raw, &exports); err != nil {
		return ""
	}
	dot, ok := exports["."]
	if !ok {
		return ""
	}
	var conds map[string]string
	if err := json.Unmarshal(dot, &conds); err != nil {
		var lit string
		if json.Unmarshal(dot, &lit) == nil {
			return lit
		}
		return ""
	}
	// Prefer any "*-source" condition (the self-typecheck src pointer).
	for key, val := range conds {
		if strings.HasSuffix(key, "-source") {
			return val
		}
	}
	for _, key := range []string{"source"} {
		if val, ok := conds[key]; ok {
			return val
		}
	}
	// Fall back to a condition already pointing into src/.
	for _, key := range []string{"bun", "types", "import", "default"} {
		if val, ok := conds[key]; ok && strings.Contains(val, "/src/") {
			return val
		}
	}
	return ""
}
