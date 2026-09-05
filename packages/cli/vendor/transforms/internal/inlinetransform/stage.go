// Package inlinetransform's stage.go wires the resolved entries into a per-file
// FileTransform: it collects the workspace's publish-list entries, resolves each
// against the consumer program, and at every matching call site substitutes the
// sugar body, registering the synthetic primitive calls a downstream primitive
// stage lowers. It runs FIRST in ttsc-std's canonical order.
package inlinetransform

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/fnioc/std/transforms/internal/plugin"
	"github.com/fnioc/std/transforms/internal/valueimport"
)

// matchTarget is a declaration node's inline plan: the sugar body plus the
// resolved entry it came from.
type matchTarget struct {
	resolved *Resolved
	body     *ResolvedBody
}

// Build constructs the inline FileTransform from the project scan's pre-collected
// body entries. The host runs ONE dependency scan for stages AND bodies (§100)
// and threads `owned` here, so the walk never runs twice. It resolves every entry,
// populates artifacts, and returns a transform that inlines matched calls. A
// zero-entry / all-inert program yields a no-op transform and leaves artifacts
// inactive. Any resolution error is reported through emit and aborts (returns a
// no-op transform) — the host treats an error-category diagnostic as a hard
// failure.
func Build(prog *driver.Program, owned []OwnedEntry, artifacts *Artifacts, emit func(plugin.Diagnostic)) plugin.FileTransform {
	noop := func(_ *shimprinter.EmitContext, sf *shimast.SourceFile) *shimast.SourceFile { return sf }

	checker := prog.Checker
	ex := newBodyExtractor()

	inlineByDecl := map[*shimast.Node]*matchTarget{}
	var resolvedList []*Resolved
	// A member whose sugar declarations are absent still publishes its shape to the
	// sweep, but must never displace an entry that can actually inline the name.
	unmatchedShapes := map[string]MemberShape{}
	for _, oe := range owned {
		resolved, outcome, rerr := Resolve(prog, checker, ex, oe)
		if rerr != nil {
			emit(plugin.Diagnostic{Code: "INLINE_RESOLVE", Message: rerr.Error()})
			return noop
		}
		if outcome == OutcomeAbsent {
			continue
		}
		// The marker's surface is in this program, so a call naming its member is
		// this stage's business whether or not a declaration matched — the sweep
		// reports one it could not lower rather than letting it through.
		artifacts.Active = true
		if outcome == OutcomeUnmatched {
			unmatchedShapes[resolved.Member] = resolved.Shape()
			continue
		}
		resolvedList = append(resolvedList, resolved)
		if resolved.Kind == KindFloater {
			for decl, body := range resolved.DeclMap {
				inlineByDecl[decl] = &matchTarget{resolved: resolved, body: body}
			}
			artifacts.FunctionSugars = append(artifacts.FunctionSugars, resolved)
		} else {
			artifacts.SugarMembers[resolved.Member] = append(artifacts.SugarMembers[resolved.Member], resolved.Shape())
		}
	}
	for member, shape := range unmatchedShapes {
		if len(artifacts.SugarMembers[member]) == 0 {
			artifacts.SugarMembers[member] = []MemberShape{shape}
		}
	}
	if !assignBodies(inlineByDecl, resolvedList, checker, ex, emit) {
		return noop
	}

	if len(inlineByDecl) == 0 {
		return noop
	}

	memberNames := map[string]bool{}
	functionNames := map[string]bool{}
	for _, r := range resolvedList {
		if r.Kind == KindFloater {
			functionNames[r.Member] = true
		} else {
			memberNames[r.Member] = true
		}
	}

	implFiles := programFilesByPath(prog)

	return func(ec *shimprinter.EmitContext, sf *shimast.SourceFile) *shimast.SourceFile {
		st := &fileState{
			ec:            ec,
			checker:       checker,
			parseAnchor:   plugin.NewCheckerAnchor(ec, sf),
			artifacts:     artifacts,
			inlineByDecl:  inlineByDecl,
			resolvedList:  resolvedList,
			memberNames:   memberNames,
			functionNames: functionNames,
			emit:          emit,
			implFiles:     implFiles,
		}
		return st.run(sf)
	}
}

// programFilesByPath indexes the program's source files by cleaned path, so a
// side-parsed impl file can be paired with the program's own copy of it.
func programFilesByPath(prog *driver.Program) map[string]*shimast.SourceFile {
	files := map[string]*shimast.SourceFile{}
	for _, sf := range prog.SourceFiles() {
		files[filepath.ToSlash(filepath.Clean(sf.FileName()))] = sf
	}
	return files
}

// assignBodies pairs every publisher-owned face with the body serving it and
// writes the pairs into inlineByDecl. A body with its own declared signature
// serves the face spelling it exactly; a rest-shaped body blankets every owned
// face no exact body claims. The pairing is complete in both directions, and a
// gap is a hard error rather than a silent skip: a face with no body would
// typecheck and then die at runtime, and a body no face declares is
// unreachable. Two bodies claiming one face — one package publishing two
// same-named bodies for one receiver — is a hard error too.
func assignBodies(inlineByDecl map[*shimast.Node]*matchTarget, resolvedList []*Resolved, checker *shimchecker.Checker, ex *bodyExtractor, emit func(plugin.Diagnostic)) bool {
	type claim struct {
		exact []*Resolved
		rest  []*Resolved
	}
	claims := map[*shimast.Node]*claim{}
	var declOrder []*shimast.Node
	for _, r := range resolvedList {
		if r.Kind == KindFloater {
			continue
		}
		for _, d := range r.OwnedDecls {
			c := claims[d]
			if c == nil {
				c = &claim{}
				claims[d] = c
				declOrder = append(declOrder, d)
			}
			if r.Body.Discriminator.Matches(declarationDiscriminator(checker, d)) {
				c.exact = append(c.exact, r)
			} else if r.RestBody {
				c.rest = append(c.rest, r)
			}
		}
	}

	ok := true
	claimed := map[*Resolved]bool{}
	for _, d := range declOrder {
		c := claims[d]
		var chosen *Resolved
		switch {
		case len(c.exact) == 1:
			chosen = c.exact[0]
		case len(c.exact) > 1:
			emit(plugin.Diagnostic{
				Code: "INLINE_BODY_COLLISION", File: nodeFile(d), Start: d.Pos(),
				Message: fmt.Sprintf("member %q at %s: %d bodies spell this face's own signature — one package publishes at most one body per face",
					c.exact[0].Member, nodePosition(d), len(c.exact)),
			})
			ok = false
			continue
		case len(c.rest) == 1:
			chosen = c.rest[0]
		case len(c.rest) > 1:
			emit(plugin.Diagnostic{
				Code: "INLINE_BODY_COLLISION", File: nodeFile(d), Start: d.Pos(),
				Message: fmt.Sprintf("member %q at %s: %d rest-shaped bodies blanket this face — one package publishes at most one blanket per member",
					c.rest[0].Member, nodePosition(d), len(c.rest)),
			})
			ok = false
			continue
		default:
			var member string
			for _, r := range resolvedList {
				if r.Kind != KindFloater && r.MemberSet[d] {
					member = r.Member
					break
				}
			}
			emit(plugin.Diagnostic{
				Code: "INLINE_FACE_WITHOUT_BODY", File: nodeFile(d), Start: d.Pos(),
				Message: fmt.Sprintf("member %q at %s: the publisher declares this face but registers no body for its signature — "+
					"the call typechecks, nothing inlines it, and it dies at runtime", member, nodePosition(d)),
			})
			ok = false
			continue
		}
		inlineByDecl[d] = &matchTarget{resolved: chosen, body: chosen.Body}
		claimed[chosen] = true
	}

	for _, r := range resolvedList {
		if r.Kind == KindFloater || claimed[r] {
			continue
		}
		emit(plugin.Diagnostic{
			Code: "INLINE_BODY_WITHOUT_FACE",
			Message: fmt.Sprintf("%s: body %q member %q claims no face the publisher declares — no consumer can name it",
				r.Body.File, r.Owned.Entry.Impl, r.Member),
		})
		ok = false
	}

	if !uncoveredFacesDiagnosed(resolvedList, checker, ex, emit) {
		ok = false
	}
	return ok
}

// uncoveredFacesDiagnosed sweeps each active publisher's whole receiver surface
// for a member the publisher declares but registers NO body for at all — the
// gap the per-entry pairing cannot see, since a member with no body has no
// entry. Returns false when it diagnosed anything.
func uncoveredFacesDiagnosed(resolvedList []*Resolved, checker *shimchecker.Checker, ex *bodyExtractor, emit func(plugin.Diagnostic)) bool {
	type group struct {
		typeSym *shimast.Symbol
		implPkg string
		members map[string]bool
	}
	groups := map[string]*group{}
	var order []string
	for _, r := range resolvedList {
		if r.Kind == KindFloater || len(r.OwnedDecls) == 0 {
			continue
		}
		key := r.Owned.Entry.Type + "\x00" + r.ImplPackage
		g := groups[key]
		if g == nil {
			g = &group{typeSym: r.TypeSymbol, implPkg: r.ImplPackage, members: map[string]bool{}}
			groups[key] = g
			order = append(order, key)
		}
		g.members[r.Member] = true
	}

	ok := true
	for _, key := range order {
		g := groups[key]
		for _, surface := range surfaceTypes(checker, g.typeSym) {
			for _, prop := range checker.GetPropertiesOfType(surface) {
				if g.members[prop.Name] {
					continue
				}
				for _, d := range prop.Declarations {
					if ex.declarationPackage(d) != g.implPkg {
						continue
					}
					emit(plugin.Diagnostic{
						Code: "INLINE_FACE_WITHOUT_BODY", File: nodeFile(d), Start: d.Pos(),
						Message: fmt.Sprintf("member %q at %s: the publisher declares this face but registers no body under the name at all — "+
							"the call typechecks, nothing inlines it, and it dies at runtime", prop.Name, nodePosition(d)),
					})
					ok = false
					break
				}
			}
		}
	}
	return ok
}

// fileState carries the per-file inline pass state.
type fileState struct {
	ec      *shimprinter.EmitContext
	checker *shimchecker.Checker
	// parseAnchor maps a node in the current (already-rewritten) tree back to the
	// pristine parse node, and is the ONLY node this stage hands the checker. Which
	// overload a sugar call binds to, and which type arguments it was invoked with,
	// are facts about the SOURCE-WRITTEN call, so they are resolved against the node
	// the binder saw; the receiver and arguments spliced into the body still come
	// from the CURRENT tree, since those must carry whatever earlier passes lowered.
	// See plugin.CheckerAnchor for what re-querying a rewritten tree costs.
	parseAnchor   plugin.CheckerAnchor
	artifacts     *Artifacts
	inlineByDecl  map[*shimast.Node]*matchTarget
	resolvedList  []*Resolved
	memberNames   map[string]bool
	functionNames map[string]bool
	emit          func(plugin.Diagnostic)
	temps         []*shimast.Node // temps needing a hoisted `var` declaration
	elideFns      map[string]bool // free-function local names now unreferenced
	// valueBindings holds, per (module, export) a substituted body referenced, how
	// THIS file names that export — an existing import's local name, or the one the
	// injected import will introduce. Resolved once per ref, so every call site in
	// the file agrees and a single import materializes after the pass.
	valueBindings map[valueimport.Ref]*valueimport.Binding
	// file is the source file the current pass is rewriting, which value bindings
	// resolve against.
	file *shimast.SourceFile
	// implFiles is the consumer program's own copy of each source file, by path.
	// A body reaches this stage side-parsed — outside the program, and so beyond
	// the checker — but a COMPOSED type argument (`typefor<Func<Args, T>>()`) has
	// to be read as a type before its type parameters can be substituted, and the
	// program's copy of the same file is the node the checker will answer about.
	implFiles map[string]*shimast.SourceFile
}

func (st *fileState) run(sf *shimast.SourceFile) *shimast.SourceFile {
	st.elideFns = map[string]bool{}
	st.valueBindings = map[valueimport.Ref]*valueimport.Binding{}
	st.file = sf
	var visitor *shimast.NodeVisitor
	visit := func(node *shimast.Node) *shimast.Node {
		if node == nil {
			return nil
		}
		if node.Kind == shimast.KindCallExpression {
			if replaced, ok := st.tryInline(node); ok {
				return replaced
			}
		}
		return visitor.VisitEachChild(node)
	}
	visitor = st.ec.NewNodeVisitor(visit)
	out := visitor.VisitNode(sf.AsNode())
	if out == nil {
		return sf
	}
	result := out.AsSourceFile()
	result = st.hoistTemps(result)
	result = st.elideFunctionImports(result)
	result = st.materializeValueImports(result)
	return result
}

// materializeValueImports injects an import for every RUNTIME value a substituted
// body referenced in this file, reusing an existing binding when present — the
// body's own import declaration, carried across to the call site. It returns sf
// unchanged when nothing was recorded (or every value was already imported),
// preserving the loop's pointer identity. Refs are ordered deterministically so the
// injected import order is stable.
func (st *fileState) materializeValueImports(sf *shimast.SourceFile) *shimast.SourceFile {
	if len(st.valueBindings) == 0 {
		return sf
	}
	refs := make([]valueimport.Ref, 0, len(st.valueBindings))
	for ref := range st.valueBindings {
		refs = append(refs, ref)
	}
	sort.Slice(refs, func(i, j int) bool {
		if refs[i].Module != refs[j].Module {
			return refs[i].Module < refs[j].Module
		}
		return refs[i].Export < refs[j].Export
	})
	bindings := make([]*valueimport.Binding, 0, len(refs))
	for _, ref := range refs {
		bindings = append(bindings, st.valueBindings[ref])
	}
	return valueimport.Ensure(st.ec.Factory.AsNodeFactory(), sf, bindings...)
}

// importedValueBindings maps each value the body reaches through its own file's
// import to the way THIS file names that same export. The two spellings differ
// whenever the body aliases the import — the shape a sugar body takes when it
// forwards to a runtime function of the same name — so the substituted expression
// must carry the consumer's name, not the body's. Marking each binding used is what
// makes materializeValueImports inject the import backing it.
func (st *fileState) importedValueBindings(body *ResolvedBody) map[string]*shimast.Node {
	if len(body.ValueImports) == 0 {
		return nil
	}
	factory := st.ec.Factory.AsNodeFactory()
	out := make(map[string]*shimast.Node, len(body.ValueImports))
	for local, ref := range body.ValueImports {
		binding := st.valueBinding(ref)
		binding.Used = true
		out[local] = binding.Expr(factory)
	}
	return out
}

// valueBinding resolves how this file names ref's export, once per ref.
func (st *fileState) valueBinding(ref valueimport.Ref) *valueimport.Binding {
	if binding, ok := st.valueBindings[ref]; ok {
		return binding
	}
	binding := valueimport.Resolve(st.file, ref)
	st.valueBindings[ref] = binding
	return binding
}

// tryInline attempts to inline one call. It returns (replacement, true) when the
// call matched a sugar declaration; (nil, false) otherwise (a passthrough or
// stranger — the caller keeps visiting children).
func (st *fileState) tryInline(node *shimast.Node) (*shimast.Node, bool) {
	call := node.AsCallExpression()
	callee := call.Expression

	// Name pre-filter: a property-access callee whose name is a member-sugar name,
	// or an identifier callee whose text is a free-function name.
	memberCandidate := false
	var calleeName string
	switch callee.Kind {
	case shimast.KindPropertyAccessExpression:
		calleeName = callee.AsPropertyAccessExpression().Name().Text()
		memberCandidate = st.memberNames[calleeName]
	case shimast.KindIdentifier:
		calleeName = callee.Text()
		memberCandidate = st.functionNames[calleeName]
	}
	if !memberCandidate {
		return nil, false
	}

	// Resolve the call back to the PARSE node before asking the checker anything.
	// This is the stage's highest-exposure checker query: GetResolvedSignature runs
	// on every pass, over every call whose callee NAME matches a sugar member — and
	// resolving a signature means resolving the whole receiver chain, so on a
	// rewritten registration it walks straight into the minted, symbol-less literals
	// downstream stages produced and nil-derefs (plugin.CheckerAnchor).
	//
	// Anchoring also subsumes the clean-skip the old `Pos() < 0` guard provided, on
	// the same two shapes and for a stated reason rather than an accident:
	//
	//   - A call a PRIOR pass produced by lowering a sugar chain is not a
	//     source-written inline candidate — its sugar was already substituted. A
	//     chain-append sugar whose body can lower to a zero-argument call is the
	//     sharp case: a later pass re-binds that call to the zero-value-arg sugar
	//     overload, and RecoverTypeArguments fails with no type argument to recover
	//     — a spurious INLINE_INFERRED_TYPE_ARGUMENT on a byte-correct emit. That
	//     call is minted through `factory.New*`, so it has no Original link and no
	//     anchor.
	//   - A substituted sugar BODY calls `this.addClass(...)`, whose callee name
	//     passes the pre-filter above. Its nodes are deep clones of the side-parsed
	//     body, so they anchor into the DECLARING package's file, not this one, and
	//     NewCheckerAnchor's same-file half rejects them.
	//
	// A source-written call that an earlier pass merely REBUILT (its receiver
	// lowered) still anchors, and must: it is the next chain link waiting to inline.
	anchored := st.parseAnchor(node)
	if anchored == nil {
		return nil, false
	}

	// The checker's resolution IS the selection: the overload it resolved the
	// call to — the one the author's editor displayed — names the body, and the
	// engine performs no overload resolution of its own. A resolved face outside
	// the assigned set is a stranger's (or a rogue duplicate); resolution-time
	// assignment already guaranteed every publisher-owned face a body, so nothing
	// here falls back to shape matching.
	decl := resolvedDeclaration(st.checker, anchored)
	target := st.inlineByDecl[decl]
	if target == nil {
		// Neither the binding nor the marker claimed the call. If the bound
		// declaration is provably the same logical member on a duplicate copy,
		// that is the rogue-duplicate tripwire; otherwise a stranger — skip.
		if decl != nil && st.isRogueDuplicate(decl, calleeName) {
			st.emit(plugin.Diagnostic{
				Code:    "INLINE_ROGUE_DUPLICATE",
				File:    nodeFile(node),
				Start:   node.Pos(),
				Message: fmt.Sprintf("call to %q resolved to a declaration outside the merged symbol for the inline entry — the program contains a duplicate copy of this interface (dist skew / two physical package copies)", calleeName),
			})
		}
		return nil, false
	}

	replacement, ok := st.inlineCall(node, anchored, target)
	if !ok {
		return nil, false
	}
	return replacement, true
}

// inlineCall performs the substitution for a matched call. node is the CURRENT
// tree's call — what the substitution splices from — and anchored is its parse
// node, the only one the checker is asked about (see fileState.parseAnchor).
func (st *fileState) inlineCall(node, anchored *shimast.Node, target *matchTarget) (*shimast.Node, bool) {
	call := node.AsCallExpression()
	body := target.body

	// Bind impl type params to the checker types at THIS call site (explicit or
	// inferred), for the primitive-call registration. Read off the ANCHOR: an
	// explicit type argument is source-written, and an inferred one is recovered
	// from the resolved signature — both are properties of the pass-0 call, and
	// asking the rewritten one would drag the checker back through the chain.
	//
	// Only a CONSUMED type parameter needs a binding — one the body's own
	// primitive calls actually spell as a type argument (typefor<T>()). A type
	// parameter the body carries only to feed a value argument (typefor(value))
	// is free to go unwritten at the call site: it is never recovered and never
	// raises the error below.
	var env map[string]*shimchecker.Type
	if required, any := body.consumedPositions(); any {
		types, ok := RecoverTypeArguments(st.checker, anchored, required)
		bound := ok
		if bound {
			env = map[string]*shimchecker.Type{}
			for i, tp := range body.TypeParams {
				if !required[i] {
					continue
				}
				if i >= len(types) || types[i] == nil {
					bound = false
					break
				}
				env[tp] = types[i]
			}
		}
		if !bound {
			st.emit(plugin.Diagnostic{
				Code:    "INLINE_INFERRED_TYPE_ARGUMENT",
				File:    nodeFile(node),
				Start:   node.Pos(),
				Message: "cannot bind the sugar's type argument — write the type argument explicitly",
			})
			return nil, false
		}
	}

	// Parameters bind positionally: the leading named parameters take the
	// call's arguments one for one, a trailing rest holds whatever follows as a
	// group, and `arguments` always names the whole set. A call that stops short
	// of the named list has omitted the optional tail; those names are handed
	// over as unbound and their argument-position references drop out of the
	// emitted call.
	names := body.Params
	args := callArguments(call)
	groups := map[string][]*shimast.Node{"arguments": args}
	if bodyHasRestParam(names) {
		restName := strings.TrimPrefix(names[len(names)-1], "...")
		names = names[:len(names)-1]
		if len(args) > len(names) {
			groups[restName] = args[len(names):]
		} else {
			groups[restName] = nil
		}
	}
	var unboundNames []string
	if len(args) < len(names) {
		unboundNames = names[len(args):]
	}

	in := Inlining{
		Body:     body.Body,
		Params:   names,
		Args:     args,
		Unbound:  unboundNames,
		Bindings: st.importedValueBindings(body),
		Groups:   groups,
	}
	// The arguments SPLICED into the body come from the CURRENT tree (above), so
	// they carry whatever earlier passes lowered. The arguments the checker is
	// later asked about must not: pair each spliced argument with the pass-0 node
	// at the same position so registerPrimitives can record the parse node instead.
	// See anchorValueArg for why the pairing is positional rather than a walk back
	// up the Original chain.
	argAnchors := positionalArgAnchors(in.Args, callArguments(anchored.AsCallExpression()))
	if target.resolved.Kind != KindFloater {
		in.Receiver = call.Expression.AsPropertyAccessExpression().Expression
	} else {
		st.elideFns[target.resolved.Member] = true
	}

	res := Substitute(st.ec, in)
	if name := danglingParam(res.Expr, in.unbound()); name != "" {
		st.emit(plugin.Diagnostic{
			Code:  "INLINE_UNBOUND_PARAMETER",
			File:  nodeFile(node),
			Start: node.Pos(),
			Message: fmt.Sprintf("the call supplies no argument for %q, and the implementation body uses it "+
				"somewhere the omission cannot be honored — pass it explicitly, or move it to the end of the "+
				"parameter list", name),
		})
		return nil, false
	}
	if res.NeedsTempHoist && res.Temp != nil {
		st.temps = append(st.temps, res.Temp)
	}

	// Instantiation-expression VALUE parity: an open-template impl argument
	// (`addClass<IRepo<$<1>>>(ThingRepo<$<1>>)`) is an ExpressionWithTypeArguments the
	// body splices into the value slot verbatim. The di direct stage registers the
	// BARE constructor expression (`ThingRepo`) — an instantiation expression's type
	// arguments are type-level and carry no runtime value — so strip them here too,
	// keeping the lowered call byte-identical to the oracle at the TS level (not only
	// after a downstream TS->JS type-strip).
	res.Expr = st.normalizeInstantiationArgs(res.Expr)

	st.registerPrimitives(res.Expr, body, env, st.composedTypeArgs(body, env), argAnchors)
	return wrapForPrecedence(st.ec, res.Expr), true
}

// positionalArgAnchors pairs each CURRENT-tree argument with the pass-0 argument
// at the same index on the anchored call. A rewrite never changes a call's
// argument COUNT — the visitor rebuilds a call through factory.Update*, which
// replaces arguments one for one — so index equality is the pairing; a length
// mismatch (nothing produces one today) yields an empty map, which degrades every
// lookup to the Original-chain fallback rather than mispairing.
func positionalArgAnchors(current, anchored []*shimast.Node) map[*shimast.Node]*shimast.Node {
	if len(current) == 0 || len(current) != len(anchored) {
		return nil
	}
	pairs := make(map[*shimast.Node]*shimast.Node, len(current))
	for i, arg := range current {
		pairs[arg] = anchored[i]
	}
	return pairs
}

// normalizeInstantiationArgs strips the type arguments from an
// ExpressionWithTypeArguments argument of a substituted registration call
// (`ThingRepo<$<1>>` → `ThingRepo`), matching the di direct stage which registers
// the BARE constructor expression via `arg.AsExpressionWithTypeArguments().Expression`.
// An instantiation expression used as a value carries no runtime type arguments, so
// this is a domain-free TS→value normalization, applied only to the OUTER call's
// arguments — the value slot is the only place a registration body splices a
// user-authored expression; the derived token / signature arguments are literals a
// body never spells as an instantiation expression. A substituted resolve body is a
// conditional (not a call) and is left untouched.
func (st *fileState) normalizeInstantiationArgs(expr *shimast.Node) *shimast.Node {
	if expr.Kind != shimast.KindCallExpression {
		return expr
	}
	call := expr.AsCallExpression()
	if call.Arguments == nil {
		return expr
	}
	args := call.Arguments.Nodes
	changed := false
	kept := make([]*shimast.Node, len(args))
	for i, arg := range args {
		if arg.Kind == shimast.KindExpressionWithTypeArguments {
			kept[i] = arg.AsExpressionWithTypeArguments().Expression
			changed = true
			continue
		}
		kept[i] = arg
	}
	if !changed {
		return expr
	}
	factory := st.ec.Factory.AsNodeFactory()
	return factory.NewCallExpression(call.Expression, nil, nil, factory.NewNodeList(kept), 0)
}

// registerPrimitives walks a substituted expression and records every primitive
// call (a call whose identifier callee is one of the body's primitive imports)
// in artifacts, binding its type arguments to the checker types captured at the
// original call. A downstream primitive stage reads these to lower a call it
// cannot anchor.
//
// argAnchors pairs each spliced argument with its pass-0 counterpart, so a
// VALUE-argument primitive records a node the checker may safely be asked about
// (anchorValueArg). composed carries the body's COMPOSED type arguments, already
// substituted, keyed by shape.
func (st *fileState) registerPrimitives(
	expr *shimast.Node,
	body *ResolvedBody,
	env map[string]*shimchecker.Type,
	composed map[string]*shimchecker.Type,
	argAnchors map[*shimast.Node]*shimast.Node,
) {
	walk(expr, func(n *shimast.Node) bool {
		if n.Kind != shimast.KindCallExpression {
			return false
		}
		callee := n.AsCallExpression().Expression
		if callee.Kind != shimast.KindIdentifier {
			return false
		}
		prim, ok := body.PrimitiveImports[callee.Text()]
		if !ok {
			return false
		}
		typeArgs := n.AsCallExpression().TypeArguments
		bound := []*shimchecker.Type{}
		if typeArgs != nil {
			for _, ta := range typeArgs.Nodes {
				if t, has := env[bareTypeParamName(ta)]; has {
					// A bare type-parameter reference (`typefor<T>()`): the env
					// binding IS the token source.
					bound = append(bound, t)
					continue
				}
				if t, has := composed[typeArgShape(ta)]; has {
					// A composed one (`typefor<Func<Args, T>>()`): the written type
					// with its type parameters already substituted.
					bound = append(bound, t)
				}
			}
		}
		use := PrimitiveUse{Name: prim, TypeArgs: bound}
		// A VALUE-argument primitive (typefor(ctor)) records the PARSE node
		// behind its spliced argument, because the consuming stage's only
		// use for it is a checker query. A TYPE-argument primitive (typefor<T>()) has
		// no value argument and leaves this nil.
		if args := n.AsCallExpression().Arguments; args != nil && len(args.Nodes) == 1 {
			use.ValueArg = st.anchorValueArg(argAnchors, args.Nodes[0])
		}
		st.artifacts.PrimitiveCalls[n] = use
		return false
	})
}

// anchorValueArg resolves a spliced value argument to the PARSE node the checker
// may be asked about, or nil when there is none.
//
// WHY THIS IS NOT JUST `args.Nodes[0]`. A sugar call is substituted on whatever
// pass the visitor first REACHES it, and that is not always pass 0: the visitor
// does not descend past a match, so a registration sitting in receiver or argument
// position under another sugar call waits a pass — and while it waits, the
// primitive stages lower whatever is inside its arguments. By the time it
// substitutes, `callArguments(call)` can hand back an argument earlier passes
// rebuilt or replaced. Recording that node made `ValueArg` a rewritten node, and
// its consumer — the typefor stage's artifacts branch — feeds it straight to the
// checker. Typing it resolves the enclosing call's overloads, which contextually
// types the minted, symbol-less literals downstream stages produced, and the
// checker nil-derefs (plugin.CheckerAnchor). Concretely:
//
//	services.addValue({ tok: typefor<IClock>(), retries: 3 }).addClass<IWidget>(W)
//
// pass 0 inlines the OUTER addClass and leaves the receiver alone, typefor
// rebuilds that object literal to lower the typefor call inside it, and pass 1
// inlines `addValue` over the REBUILT literal.
//
// WHY POSITIONAL FIRST, PARSE-ANCHOR SECOND. The positional pairing is exact and
// total: it answers even when an earlier pass replaced the whole argument with a
// MINTED node (`addValue(typefor<IClock>())` lowers its argument to a fresh
// `Type.*` tree), which has no Original link and so no parse anchor at all. The
// Original-chain anchor then covers the residue the pairing cannot see — an
// argument a body nested inside another expression rather than passing straight
// through, whose enclosing node is not itself one of the call's arguments.
//
// A miss records nil. The consuming stages treat that as "not a registered value
// argument", so the primitive call stays in the tree and the emit sweep reports it
// as unlowered — a named diagnostic instead of a process-killing panic.
func (st *fileState) anchorValueArg(argAnchors map[*shimast.Node]*shimast.Node, arg *shimast.Node) *shimast.Node {
	if anchored, ok := argAnchors[arg]; ok {
		return anchored
	}
	return st.parseAnchor(arg)
}

// isRogueDuplicate reports whether decl is provably the same logical member as an
// entry (same TypeName inside a declare-module block for the entry's package, or
// in a file under a package of that name) but outside the merged symbol — the
// dist-skew tripwire. Reading names here is diagnostic-only; matching never
// depends on it.
func (st *fileState) isRogueDuplicate(decl *shimast.Node, calleeName string) bool {
	// A declaration that belongs to a resolved entry's merged member symbol is a
	// legitimate sibling, never a duplicate copy: this repo's standard
	// OPEN-receiver pattern declares a member's non-sugar overload in a
	// `declare module` augmentation, which TS merges into the same member symbol.
	// Such an overload lives in a declare-module block for the entry's package and
	// shares its TypeName, so it would otherwise trip the provenance heuristic
	// below. Only a declaration OUTSIDE every merged set can be a dist-skew rogue,
	// so clear the merged declarations first.
	for _, r := range st.resolvedList {
		if r.MemberSet[decl] {
			return false
		}
	}
	for _, r := range st.resolvedList {
		if r.Member != calleeName {
			continue
		}
		if enclosingInterfaceName(decl) != r.TypeName {
			continue
		}
		if inDeclareModuleFor(decl, r.Module) {
			return true
		}
	}
	return false
}

// hoistTemps prepends a `var <temp>;` declaration for every single-eval temp the
// pass minted. Spec §6d wants enclosing-function scope; this pass hoists to file
// scope (a module-level `var` — correct for the non-reentrant expression-temp
// case), a documented simplification flagged for follow-up.
func (st *fileState) hoistTemps(sf *shimast.SourceFile) *shimast.SourceFile {
	if len(st.temps) == 0 {
		return sf
	}
	factory := st.ec.Factory.AsNodeFactory()
	decls := make([]*shimast.Node, 0, len(st.temps))
	for _, temp := range st.temps {
		vd := factory.NewVariableDeclaration(temp, nil, nil, nil)
		list := factory.NewVariableDeclarationList(factory.NewNodeList([]*shimast.Node{vd}), shimast.NodeFlagsNone)
		decls = append(decls, factory.NewVariableStatement(nil, list))
	}
	merged := append(decls, sf.Statements.Nodes...)
	return factory.UpdateSourceFile(sf, factory.NewNodeList(merged), sf.EndOfFileToken).AsSourceFile()
}

// elideFunctionImports drops now-unreferenced imports of inlined free functions.
func (st *fileState) elideFunctionImports(sf *shimast.SourceFile) *shimast.SourceFile {
	if len(st.elideFns) == 0 {
		return sf
	}
	factory := st.ec.Factory.AsNodeFactory()
	kept := make([]*shimast.Node, 0, len(sf.Statements.Nodes))
	changed := false
	for _, stmt := range sf.Statements.Nodes {
		next := elideNamedImport(factory, stmt, st.elideFns)
		if next == nil {
			changed = true
			continue
		}
		if next != stmt {
			changed = true
		}
		kept = append(kept, next)
	}
	if !changed {
		return sf
	}
	return factory.UpdateSourceFile(sf, factory.NewNodeList(kept), sf.EndOfFileToken).AsSourceFile()
}

// callArguments returns a call's argument expression nodes.
func callArguments(call *shimast.CallExpression) []*shimast.Node {
	if call.Arguments == nil {
		return nil
	}
	return call.Arguments.Nodes
}

// wrapForPrecedence parenthesizes a substituted root when it is not already a
// self-delimiting expression form, so it splices safely into any context.
func wrapForPrecedence(ec *shimprinter.EmitContext, expr *shimast.Node) *shimast.Node {
	switch expr.Kind {
	case shimast.KindCallExpression, shimast.KindPropertyAccessExpression,
		shimast.KindElementAccessExpression, shimast.KindIdentifier,
		shimast.KindParenthesizedExpression, shimast.KindStringLiteral,
		shimast.KindNumericLiteral, shimast.KindTrueKeyword, shimast.KindFalseKeyword,
		shimast.KindNullKeyword, shimast.KindThisKeyword:
		return expr
	}
	return ec.Factory.AsNodeFactory().NewParenthesizedExpression(expr)
}
