// Package mergesynthtransform is the #213 default-merge-strategy synthesizer:
// for every augmentation member reaching `registerAugmentations(token, set)` or
// `applyAugmentations(Class, set)` without a hand-authored strategy for its
// name, it derives a runtime argument-shape guard from the member's own
// parameter types and threads a per-member `MergeStrategies` map as the call's
// third argument. Under this stage a member-name collision NEVER throws at
// install time: a guarded dispatcher routes a call to whichever extension's
// signature the arguments actually match, falling through to whatever held the
// name before.
//
// The guards are typia is-validators, generated IN-PROCESS by typia's native Go
// programmers (an embed, not a second compiler pass): this stage resolves each
// parameter's ORIGINAL type node and hands the resulting type straight to
// typia's is-programmer over the same loaded program, checker, and EmitContext.
// Driving typia per-parameter is the only workable composition — typia's own
// per-file walk anchors on GetResolvedSignature of the callee, which a
// synthesized call (in a program that never imports typia) can never satisfy.
// The producer→consumer ordering problem dissolves for the same reason:
// synthesis and lowering happen in one function call, so nothing typia-shaped
// ever survives into the emitted tree.
//
// typia's fast path is taken only for a type it renders FAITHFULLY, decided by a
// whitelist (typiaFaithful): every reachable position must be one this stage
// positively recognizes typia's output for. Anything else is composed here
// instead (guardForType), over the public surface internal/typesurface
// enumerates.
//
// The whitelist direction is the point. A guard is only worth emitting if its
// clauses can decide something, and the ways typia's enumeration silently stops
// deciding (a `#`-named field keyed on a name no object carries, a symbol-keyed
// member keyed on the checker's internal name, an accessor skipped outright, a
// wholly hidden surface collapsing to a constant `true`) all look like ordinary
// output. Recognizing them one at a time leaves every unexamined position
// defaulting to "emit anyway"; recognizing what typia gets RIGHT leaves every
// unexamined position defaulting to a composed guard or a refusal, both of which
// are honest.
//
// §87 containment: the emitted guards are self-contained plain JS. A guard
// that would need one of typia's runtime helper imports is DROPPED (that
// parameter simply goes unguarded) with a warning diagnostic — the published
// artifacts must never grow a typia runtime import. typia is a build-time-only
// dependency of the single ttsc-std host; the emitted JS carries no typia
// runtime.
//
// Degradation contract: a parameter whose type is un-derivable — no annotation,
// `any`/`unknown`, or a reference to the member's own type parameters —
// contributes no guard. A member whose EVERY parameter is un-derivable that way
// gets the bare always-pass strategy: that extension wins and chain order breaks
// ties.
//
// A position the composer cannot decompose is NOT that case, and does not cost
// the guard around it. It contributes no clause of its own; every clause beside
// it stands, down to the runtime-KIND floor the type still implies
// (`typeof input === "object" && input !== null`, `Array.isArray(input)`), and
// the parameter's arity bounds — derivable from the signature alone — always
// stand. A synthesized guard may be weaker than the type it checks, never
// narrower: it must not reject a value the declared type admits, and it must not
// widen dispatch past what it replaced. Every weakening is reported.
//
// A member whose name the call's own hand-authored merge object already covers is
// left entirely alone (hand-authored WINS — enforced twice: covered names are
// skipped here, and the original merge expression is spread LAST over the
// synthesized map).
package mergesynthtransform

import (
	"fmt"
	"os"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
	shimcore "github.com/microsoft/typescript-go/shim/core"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
	shimscanner "github.com/microsoft/typescript-go/shim/scanner"
	"github.com/samchon/ttsc/packages/ttsc/driver"
	nativecontext "github.com/samchon/typia/packages/typia/native/core/context"
	nativeprogrammers "github.com/samchon/typia/packages/typia/native/core/programmers"

	"github.com/fnioc/std/transforms/internal/plugin"
	"github.com/fnioc/std/transforms/internal/typesurface"
)

// Category mirrors ditransform's advisory-vs-hard split: a Warning is reported
// without failing the emit.
type Category int

const (
	Error Category = iota
	Warning
)

// Diagnostic is one merge-synthesis diagnostic.
type Diagnostic struct {
	File     string
	Category Category
	Code     string
	Message  string
}

// mergesynthVerboseEnv is the escape hatch out of the default silent path:
// unset, MERGESYNTH_PRIVATE_SURFACE reports nothing at all — a cold-cache
// rebuild otherwise floods hundreds of near-identical lines. Set to "1" to get
// the per-member detail, once per member per host process (mergesynthVerboseSeen).
const mergesynthVerboseEnv = "TTSC_MERGESYNTH_VERBOSE"

// mergesynthVerboseSeen is the process-wide set of (file, member) pairs already
// reported under TTSC_MERGESYNTH_VERBOSE=1. The host's file loop can revisit
// the same file more than once within one process — once per entrypoint
// compile, or a cache-warmed envelope replaying a prior file's diagnostics —
// and a member's line is worth reading once, not once per revisit. The host
// runs its whole file loop on one goroutine (see typeforhoist's own note on
// the same shape of state), so a plain map needs no lock.
var mergesynthVerboseSeen = map[string]bool{}

// markPrivateSurfaceSeen reports whether (file, member) already had its
// MERGESYNTH_PRIVATE_SURFACE line reported this process, marking it seen as a
// side effect — so a caller checking it can suppress exactly the repeats.
func markPrivateSurfaceSeen(file, member string) (alreadySeen bool) {
	key := file + "\x00" + member
	if mergesynthVerboseSeen[key] {
		return true
	}
	mergesynthVerboseSeen[key] = true
	return false
}

// The install functions this stage rewrites, matched on the callee's resolved
// symbol name (following import aliases) — unambiguous for these two first-party
// names.
const (
	registerName = "registerAugmentations"
	applyName    = "applyAugmentations"
)

// New builds the per-file transform: every 2-argument (or gap-carrying
// 3-argument) `registerAugmentations` / `applyAugmentations` call whose set
// argument resolves to a statically-known object literal gains a synthesized
// per-member merge-strategy map as its third argument. It runs inside the
// fixed-point loop, so it re-sees a call it already rewrote (fully covered —
// the identical node comes back) and picks up an install call another stage
// minted mid-loop.
func New(prog *driver.Program, addDiagnostic func(Diagnostic)) plugin.FileTransform {
	return func(ec *shimprinter.EmitContext, sf *shimast.SourceFile) *shimast.SourceFile {
		s := &synthesizer{
			prog:          prog,
			checker:       prog.Checker,
			ec:            ec,
			file:          sf,
			anchor:        plugin.NewCheckerAnchor(ec, sf),
			addDiagnostic: addDiagnostic,
			verbose:       os.Getenv(mergesynthVerboseEnv) == "1",
			guardKeys:     map[string]string{},
		}
		var visitor *shimast.NodeVisitor
		visit := func(node *shimast.Node) *shimast.Node {
			if node == nil {
				return nil
			}
			if node.Kind == shimast.KindCallExpression {
				if next := s.maybeRewrite(node.AsCallExpression()); next != nil {
					// No recursion into the rewritten call: its original
					// argument nodes (the typefor token derivation among them)
					// are preserved as-is for the later primitive stages'
					// own full-file visits.
					return next
				}
			}
			return visitor.VisitEachChild(node)
		}
		visitor = ec.NewNodeVisitor(visit)
		output := visitor.VisitNode(sf.AsNode())
		if output == nil {
			return sf
		}
		return output.AsSourceFile()
	}
}

type synthesizer struct {
	prog          *driver.Program
	checker       *shimchecker.Checker
	ec            *shimprinter.EmitContext
	file          *shimast.SourceFile
	anchor        plugin.CheckerAnchor
	addDiagnostic func(Diagnostic)
	// verbose is TTSC_MERGESYNTH_VERBOSE=1, read once when the file's
	// synthesizer is built — the escape hatch back to a MERGESYNTH_PRIVATE_SURFACE
	// diagnostic per weakened guard. Unset, a weakened guard is reported nowhere.
	verbose bool
	// guardKeys tracks the guard parameter signature each member name has been
	// assigned, across registrations in one file. When a later registration
	// assigns a provably identical guard to the same member, the conflict is
	// reported.
	guardKeys map[string]string
}

func (s *synthesizer) factory() *shimast.NodeFactory {
	return s.ec.Factory.AsNodeFactory()
}

// member is one augmentation-set entry: its statically-known name and the
// function-like declaration carrying its parameters and type parameters.
type member struct {
	name string
	fn   *shimast.Node
}

// maybeRewrite returns the rewritten call, or nil when this call is not an
// install call / needs no synthesis.
func (s *synthesizer) maybeRewrite(call *shimast.CallExpression) *shimast.Node {
	if !s.isInstallCall(call) {
		return nil
	}
	args := call.Arguments.Nodes
	if len(args) < 2 || len(args) > 3 {
		return nil
	}
	members := s.setMembers(args[1])
	if len(members) == 0 {
		return nil
	}

	// Hand-authored strategies WIN: a name the existing merge object covers is
	// not synthesized at all. When the merge expression's shape cannot be
	// statically enumerated the skip-set stays empty — the runtime spread below
	// still guarantees the hand-authored entry overrides the synthesized one.
	var handMerge *shimast.Node
	handNames := map[string]bool{}
	if len(args) == 3 {
		handMerge = args[2]
		handNames = s.strategyNames(handMerge)
	}

	f := s.factory()
	props := make([]*shimast.Node, 0, len(members)+1)
	for _, m := range members {
		if handNames[m.name] {
			continue
		}
		props = append(props, f.NewPropertyAssignment(nil, propertyName(f, m.name), nil, nil, s.strategyFor(m)))
	}
	if len(props) == 0 {
		return nil
	}
	if handMerge != nil {
		props = append(props, f.NewSpreadAssignment(handMerge))
	}
	merged := f.NewObjectLiteralExpression(f.NewNodeList(props), true)
	newArgs := []*shimast.Node{args[0], args[1], merged}
	return f.UpdateCallExpression(
		call,
		call.Expression,
		call.QuestionDotToken,
		call.TypeArguments,
		f.NewNodeList(newArgs),
		shimast.NodeFlagsNone,
	)
}

// isInstallCall reports whether call is a receiver-taking install call —
// `registerAugmentations(receiver, set, merge?)` / `applyAugmentations(Class,
// set, merge?)`. This stage runs inside the fixed-point loop, so the checker is
// only ever asked about parse-tree nodes (plugin.CheckerAnchor): a
// source-written call resolves its callee through the anchor; a call with no
// same-file anchor is engine-minted — an inline-substituted install whose
// callee identifier is the value-import binding for the runtime install
// function — and is matched by that identifier's text, the checker having no
// location to resolve a minted node from.
func (s *synthesizer) isInstallCall(call *shimast.CallExpression) bool {
	if anchored := s.anchor.AnchoredCall(call.AsNode()); anchored != nil {
		symbol := s.checker.GetSymbolAtLocation(anchored.Expression)
		if symbol == nil {
			return false
		}
		if symbol.Flags&shimast.SymbolFlagsAlias != 0 {
			if aliased := s.checker.GetAliasedSymbol(symbol); aliased != nil {
				symbol = aliased
			}
		}
		if symbol.Name != registerName && symbol.Name != applyName {
			return false
		}
		return installTakesReceiver(symbol)
	}
	callee := call.Expression
	if callee == nil || callee.Kind != shimast.KindIdentifier {
		return false
	}
	return callee.Text() == registerName || callee.Text() == applyName
}

// installTakesReceiver reports whether the resolved install function's own
// declaration takes the receiver as its first PARAMETER (three parameters:
// receiver, set, merge?). The authoring sugar shares the install's name but
// takes the receiver as a TYPE argument, so its two-parameter call carries the
// set in first position — rewriting that call would guard the merge map's own
// entries as if they were the set. The sugar lowers into the receiver-taking
// form, which this stage matches on a later pass. An unreadable declaration
// counts as receiver-taking, keeping the plain name match for a fixture-local
// declare.
func installTakesReceiver(symbol *shimast.Symbol) bool {
	decl := symbol.ValueDeclaration
	if decl == nil && len(symbol.Declarations) > 0 {
		decl = symbol.Declarations[0]
	}
	if decl == nil {
		return true
	}
	params := functionParameters(decl)
	if params == nil {
		return true
	}
	return len(params) != 2
}

// setMembers enumerates the augmentation set's members in declaration order:
// the set expression (or the const initializer its identifier resolves to,
// through `satisfies`/`as`/parens) must be an object literal, and each entry a
// method or a function-valued property with a static name. Anything else —
// spreads, shorthands, computed names — is skipped: those members simply get
// no synthesized strategy, preserving the no-transformer semantics.
func (s *synthesizer) setMembers(setArg *shimast.Node) []member {
	literal := s.resolveObjectLiteral(setArg)
	if literal == nil {
		return nil
	}
	members := make([]member, 0, len(literal.Properties.Nodes))
	for _, prop := range literal.Properties.Nodes {
		switch prop.Kind {
		case shimast.KindMethodDeclaration:
			if name := staticName(prop.Name()); name != "" {
				members = append(members, member{name: name, fn: prop})
			}
		case shimast.KindPropertyAssignment:
			assignment := prop.AsPropertyAssignment()
			name := staticName(assignment.Name())
			if name == "" {
				continue
			}
			init := skipWrappers(assignment.Initializer)
			if init != nil && (init.Kind == shimast.KindFunctionExpression || init.Kind == shimast.KindArrowFunction) {
				members = append(members, member{name: name, fn: init})
			}
		}
	}
	return members
}

// strategyNames enumerates the statically-known member names of a merge
// expression, recursing through spread assignments whose expression resolves
// to an object literal — the shape this stage's own rewrite emits (synthesized
// entries with the hand-authored merge spread last), so a call already rewritten
// reads as fully covered and the loop settles. Unresolvable shapes yield an
// empty set — synthesis then covers every member and the runtime spread keeps
// the hand-authored entries winning.
func (s *synthesizer) strategyNames(mergeArg *shimast.Node) map[string]bool {
	names := map[string]bool{}
	s.collectStrategyNames(s.resolveObjectLiteral(mergeArg), names)
	return names
}

// collectStrategyNames accumulates literal's statically-known member names into
// names, following resolvable spreads.
func (s *synthesizer) collectStrategyNames(literal *shimast.ObjectLiteralExpression, names map[string]bool) {
	if literal == nil {
		return
	}
	for _, prop := range literal.Properties.Nodes {
		switch prop.Kind {
		case shimast.KindMethodDeclaration:
			if name := staticName(prop.Name()); name != "" {
				names[name] = true
			}
		case shimast.KindPropertyAssignment:
			if name := staticName(prop.AsPropertyAssignment().Name()); name != "" {
				names[name] = true
			}
		case shimast.KindShorthandPropertyAssignment:
			if name := staticName(prop.Name()); name != "" {
				names[name] = true
			}
		case shimast.KindSpreadAssignment:
			s.collectStrategyNames(s.resolveObjectLiteral(prop.AsSpreadAssignment().Expression), names)
		}
	}
}

// resolveObjectLiteral resolves an expression to the object literal it
// statically denotes: the expression itself, or the initializer of the const
// variable its identifier resolves to, in both cases unwrapping
// `satisfies`/`as`/parenthesized wrappers. The checker is only ever asked
// about the identifier's parse anchor — a minted identifier has none and is a
// clean skip.
func (s *synthesizer) resolveObjectLiteral(expr *shimast.Node) *shimast.ObjectLiteralExpression {
	unwrapped := skipWrappers(expr)
	if unwrapped == nil {
		return nil
	}
	if unwrapped.Kind == shimast.KindObjectLiteralExpression {
		return unwrapped.AsObjectLiteralExpression()
	}
	if unwrapped.Kind != shimast.KindIdentifier {
		return nil
	}
	anchored := s.anchor(unwrapped)
	if anchored == nil {
		return nil
	}
	symbol := s.checker.GetSymbolAtLocation(anchored)
	if symbol == nil {
		return nil
	}
	if symbol.Flags&shimast.SymbolFlagsAlias != 0 {
		if aliased := s.checker.GetAliasedSymbol(symbol); aliased != nil {
			symbol = aliased
		}
	}
	decl := symbol.ValueDeclaration
	if decl == nil || decl.Kind != shimast.KindVariableDeclaration {
		return nil
	}
	init := skipWrappers(decl.AsVariableDeclaration().Initializer)
	if init != nil && init.Kind == shimast.KindObjectLiteralExpression {
		return init.AsObjectLiteralExpression()
	}
	return nil
}

// paramKind is a guarded parameter's dispatch arity class.
type paramKind int

const (
	paramRequired paramKind = iota
	paramOptional
	paramRest
)

// guardedParam is one synthesized conjunct: the args index it checks, its
// arity class, and the typia guard function expression.
type guardedParam struct {
	index int
	kind  paramKind
	guard *shimast.Node
}

// privateSurfaceFinding is one parameter position synthesizeGuard could not
// fully cover — its own arg index and declared type spelling, why (reason),
// and what the emitted guard still checks despite it (tail). One member can
// carry several — a multi-parameter member with more than one weakened
// position reports every one of them, not just the first.
type privateSurfaceFinding struct {
	index    int
	typeText string
	reason   string
	tail     string
}

// strategyFor synthesizes one member's merge strategy. The result is always a
// valid strategy expression; the fallback for a fully un-derivable member is
// the bare always-pass form (extension wins, chain order breaks ties).
func (s *synthesizer) strategyFor(m member) *shimast.Node {
	params := functionParameters(m.fn)
	typeParams := typeParameterNames(m.fn)

	// Parameters pair with the call positionally: params[i] guards args[i]. An
	// explicit `this` parameter is type-only and never part of the call, but
	// its declared type — the receiver — is what labels a MERGESYNTH_PRIVATE_SURFACE
	// finding: "Manifest.remove", not just "remove".
	guardable := params
	receiver := ""
	if len(guardable) > 0 {
		if name := guardable[0].AsParameterDeclaration().Name(); name != nil && name.Kind == shimast.KindIdentifier && name.Text() == "this" {
			if t := guardable[0].AsParameterDeclaration().Type; t != nil {
				receiver = typeNameOf(t)
			}
			guardable = guardable[1:]
		}
	}
	guards := make([]guardedParam, 0, len(guardable))
	var findings []privateSurfaceFinding
	minArity := 0
	maxArity := 0
	hasRest := false
	refused := false
	for i, paramNode := range guardable {
		param := paramNode.AsParameterDeclaration()
		kind := paramRequired
		switch {
		case param.DotDotDotToken != nil:
			kind = paramRest
			hasRest = true
		case param.QuestionToken != nil || param.Initializer != nil:
			kind = paramOptional
		default:
			minArity = i + 1
		}
		if !hasRest {
			maxArity = i + 1
		}

		typeNode := param.Type
		if typeNode == nil {
			continue
		}
		if typeNode.Kind == shimast.KindAnyKeyword || typeNode.Kind == shimast.KindUnknownKeyword {
			continue
		}
		if referencesTypeParameter(typeNode, typeParams) {
			continue
		}
		node, ok, finding := s.synthesizeGuard(typeNode, m.name, kind, i)
		if finding != nil {
			findings = append(findings, *finding)
		}
		if !ok {
			// The type was known; nothing about a value of it could be checked.
			// That is a refusal, not an un-derivable parameter.
			refused = true
			continue
		}
		guards = append(guards, guardedParam{index: i, kind: kind, guard: node})
	}
	s.reportPrivateSurface(receiver, m.name, findings)

	guardKey := s.guardKey(guardable, typeParams)
	if prev, exists := s.guardKeys[m.name]; exists && prev == guardKey {
		s.addDiagnostic(Diagnostic{
			File:     s.file.FileName(),
			Category: Error,
			Code:     "MERGESYNTH_INDISTINGUISHABLE_GUARDS",
			Message:  "two registrations for \"" + m.name + "\" produce identical runtime guards — the second can never dispatch",
		})
	}
	s.guardKeys[m.name] = guardKey

	// No parameter type could be derived AND none was refused: nothing at all is
	// known about the call, so the extension silently wins.
	if len(guards) == 0 && !refused {
		return s.alwaysPassStrategy()
	}
	return s.guardedStrategy(guards, minArity, maxArity, hasRest)
}

// guardKey derives a string that identifies the runtime guard a member's
// parameters produce. Two members whose guardKeys are equal produce provably
// identical runtime dispatch — the second can never fire.
func (s *synthesizer) guardKey(params []*shimast.Node, typeParams map[string]bool) string {
	parts := make([]string, 0, len(params))
	for _, p := range params {
		typeNode := p.AsParameterDeclaration().Type
		if typeNode == nil {
			parts = append(parts, "_")
			continue
		}
		if typeNode.Kind == shimast.KindAnyKeyword || typeNode.Kind == shimast.KindUnknownKeyword {
			parts = append(parts, "_")
			continue
		}
		if referencesTypeParameter(typeNode, typeParams) {
			parts = append(parts, "_")
			continue
		}
		t := s.checker.GetTypeFromTypeNode(typeNode)
		if t == nil {
			parts = append(parts, "_")
			continue
		}
		parts = append(parts, s.guardClassification(t))
	}
	return strings.Join(parts, ",")
}

// guardClassification returns a string classifying what runtime guard a type
// produces. Two types with the same classification produce identical guards.
func (s *synthesizer) guardClassification(t *shimchecker.Type) string {
	switch {
	case s.typiaFaithful(t, map[*shimchecker.Type]bool{}):
		return "faithful:" + s.checker.TypeToString(t)
	case t.Flags()&shimchecker.TypeFlagsESSymbolLike != 0:
		return "typeof:symbol"
	case t.Flags()&shimchecker.TypeFlagsUnion != 0:
		return "union:" + s.checker.TypeToString(t)
	case t.Flags()&shimchecker.TypeFlagsIntersection != 0:
		return "intersection:" + s.checker.TypeToString(t)
	case shimchecker.IsTupleType(t):
		return "tuple:" + s.checker.TypeToString(t)
	case s.arrayElementType(t) != nil:
		return "array:" + s.checker.TypeToString(t)
	case s.isCallable(t):
		return "callable"
	case s.nominalGlobalOf(t) != "":
		return "nominal:" + s.nominalGlobalOf(t)
	case s.stringIndexValueType(t) != nil:
		return "record:" + s.checker.TypeToString(t)
	case s.isIterableType(t):
		return "iterable"
	case typesurface.FromLibrary(s.prog, t):
		return "floor:library"
	case t.Flags()&shimchecker.TypeFlagsObject != 0:
		return "object:" + s.checker.TypeToString(t)
	case t.Flags()&shimchecker.TypeFlagsNonPrimitive != 0:
		return "floor:nonprimitive"
	default:
		return "unknown:" + s.checker.TypeToString(t)
	}
}

// reportPrivateSurface emits, under TTSC_MERGESYNTH_VERBOSE=1, ONE
// MERGESYNTH_PRIVATE_SURFACE diagnostic for the whole member naming every
// weakened parameter position findings collected — not just the first, the
// way a single `guard.reason` string would collapse to. Silent by default
// (findings is always collected regardless, so the counting cost is the same
// either way, but nothing is reported unless verbose), and deduped once per
// (file, member) per host process the same as every other verbose line.
func (s *synthesizer) reportPrivateSurface(receiver, member string, findings []privateSurfaceFinding) {
	if len(findings) == 0 || !s.verbose {
		return
	}
	label := member
	if receiver != "" {
		label = receiver + "." + member
	}
	if markPrivateSurfaceSeen(s.file.FileName(), label) {
		return
	}
	parts := make([]string, len(findings))
	for i, f := range findings {
		parts[i] = fmt.Sprintf("arg %d (%s): %s; %s", f.index, f.typeText, f.reason, f.tail)
	}
	s.addDiagnostic(Diagnostic{
		File:     s.file.FileName(),
		Category: Warning,
		Code:     "MERGESYNTH_PRIVATE_SURFACE",
		Message:  fmt.Sprintf("merge guard for %q cannot fully check: %s", label, strings.Join(parts, " | ")),
	})
}

// synthesizeGuard derives one parameter's guard function expression from its
// ORIGINAL type node. A typia TransformerError (unsupported type, unresolved
// shape) surfaces as a panic; it is recovered here and the parameter degrades to
// unguarded — under this stage nothing ever fails the build over a merge guard.
// A guard that requested a typia runtime helper import is likewise dropped (§87:
// the emitted JS must stay typia-free), with a warning naming the member.
//
// Whatever the composer could not cover is returned as finding rather than
// reported here directly, so the caller (strategyFor) can fold every weakened
// parameter of one member into a single diagnostic instead of one per
// parameter: a guard weaker than its type is emitted (it still narrows
// dispatch) but never silently.
func (s *synthesizer) synthesizeGuard(typeNode *shimast.Node, memberName string, kind paramKind, index int) (node *shimast.Node, ok bool, finding *privateSurfaceFinding) {
	importer := nativecontext.NewImportProgrammer(nativecontext.ImportProgrammer_IOptions{
		InternalPrefix: "typia_transform_",
	})
	importer.SetEmitContext(s.ec)
	diagnosed := false
	context := nativecontext.ITypiaContext{
		Program:         s.prog,
		CompilerOptions: compilerOptions(s.prog),
		Checker:         s.checker,
		Options:         nativecontext.ITransformOptions{},
		Emit:            s.ec,
		Importer:        importer,
		Extras: nativecontext.ITypiaContext_Extras{
			AddDiagnostic: func(*nativecontext.ITypiaDiagnostic) int {
				diagnosed = true
				return 0
			},
		},
	}

	defer func() {
		if recovered := recover(); recovered != nil {
			node, ok, finding = nil, false, nil
		}
	}()

	if typeNode.Pos() < 0 {
		return nil, false, nil
	}
	t := s.checker.GetTypeFromTypeNode(typeNode)
	if t == nil {
		return nil, false, nil
	}

	built := s.guardForType(context, t, typeNameOf(typeNode), map[*shimchecker.Type]bool{})
	// A rest parameter's slice is an array by construction, so a guard that only
	// establishes the value's runtime kind can never be false over one. Emitting
	// it would look like a check while deciding nothing.
	if kind == paramRest && built.floor {
		built = guard{reason: built.reason}
	}
	if diagnosed {
		built = guard{reason: built.reason}
	}
	if built.node != nil && len(importer.ToStatements()) != 0 {
		s.addDiagnostic(Diagnostic{
			File:     s.file.FileName(),
			Category: Warning,
			Code:     "MERGESYNTH_RUNTIME_IMPORT",
			Message:  "merge guard for \"" + memberName + "\" needs a typia runtime helper import; dropped (the emitted JS must stay typia-free, §87)",
		})
		return nil, false, nil
	}
	if built.reason != "" {
		// Each tail says what the emit actually contains. Calling a position
		// "unchecked" when a clause was in fact emitted for it sends a reader
		// looking for the wrong thing — and the whole point of the report is
		// that what got emitted is weaker than the declared type, not absent.
		tail := "the guard checks every position it could reach, and the arity bounds stand"
		switch {
		case built.node == nil:
			tail = "dropped (that parameter carries no clause, but its arity bounds stand)"
		case built.floor:
			tail = "the guard checks only that the value's runtime kind is one the type admits, and the arity bounds stand"
		}
		finding = &privateSurfaceFinding{index: index, typeText: typeNameOf(typeNode), reason: built.reason, tail: tail}
	}
	return built.node, built.node != nil, finding
}

// guard is one position's synthesized check.
type guard struct {
	// node is the guard function expression, or nil when NOTHING about a value of
	// the type can be checked. A nil node is the one result a caller must drop
	// rather than emit: a clause that is constantly `true` decides nothing while
	// reading exactly like one that does, which is the shape this stage exists to
	// keep out of the emit. Whenever node is nil, reason says why.
	node *shimast.Node
	// reason names the first position the guard could not cover, and is empty
	// exactly when the guard covers the whole type. A guard with a reason is still
	// emitted — it is weaker than its type but never narrower — and reported.
	reason string
	// floor is set when node establishes only the value's runtime KIND (that it is
	// an object, that it is an array) and nothing about its contents.
	floor bool
}

// guardForType returns the guard validating a value against t.
//
// A type typia renders faithfully is handed straight to its is-programmer.
// Anything else is composed here, position by position, over the PUBLIC surface
// internal/typesurface enumerates: unions disjunctively, intersections
// conjunctively, arrays element-wise, tuples positionally, index-signature
// records over `Object.values`, nominal built-ins by `instanceof`, callables and
// symbols by `typeof`, and objects and class instances clause-per-public-readable
// member.
//
// A position none of that reaches costs its own clause and nothing more: the
// guard around it stands, down to the runtime-kind floor the type still implies.
func (s *synthesizer) guardForType(
	context nativecontext.ITypiaContext,
	t *shimchecker.Type,
	name string,
	seen map[*shimchecker.Type]bool,
) guard {
	if s.typiaFaithful(t, map[*shimchecker.Type]bool{}) {
		return guard{node: nativeprogrammers.IsProgrammer.Write(nativeprogrammers.IsProgrammer_IProps{
			Context: context,
			Type:    t,
			Name:    &name,
			Config:  nativeprogrammers.IsProgrammer_IConfig{},
		})}
	}
	if seen[t] {
		// Reached through itself. The composed guards are nested closures, so a
		// self-reference has no name to call at this depth; the cycle's clause is
		// dropped and every clause around it stands.
		return guard{reason: "the recursion in " + s.checker.TypeToString(t)}
	}
	seen[t] = true
	defer delete(seen, t)

	switch {
	case t.Flags()&shimchecker.TypeFlagsESSymbolLike != 0:
		return guard{node: typeofGuard(s.factory(), "symbol")}
	case t.Flags()&shimchecker.TypeFlagsUnion != 0:
		return s.unionGuard(context, t, seen)
	case t.Flags()&shimchecker.TypeFlagsIntersection != 0:
		return s.intersectionGuard(context, t, seen)
	case shimchecker.IsTupleType(t):
		return s.tupleGuard(context, t, seen)
	case s.arrayElementType(t) != nil:
		return s.arrayGuard(context, t, seen)
	case s.isCallable(t):
		return s.callableGuard(t)
	case s.nominalGlobalOf(t) != "":
		return s.nominalGuard(context, t, seen)
	case s.stringIndexValueType(t) != nil:
		return s.recordGuard(context, t, seen)
	case s.isIterableType(t):
		return s.iterableGuard()
	case typesurface.FromLibrary(s.prog, t):
		// Some other built-in. Its members are an implementation of an identity,
		// not the identity itself, so per-member clauses would say nothing about
		// whether a value really is one.
		return s.objectFloor(s.checker.TypeToString(t) + ", a built-in no structural clause can recognize")
	case t.Flags()&shimchecker.TypeFlagsObject != 0:
		return s.objectGuard(context, t, seen)
	case t.Flags()&shimchecker.TypeFlagsNonPrimitive != 0:
		return s.nonPrimitiveGuard()
	}
	return guard{reason: s.checker.TypeToString(t) + ", which has no runtime form to test"}
}

// objectFloor is the guard for a value known only to be of an object type — the
// weakest honest check, and what every composed object guard is built on top of.
func (s *synthesizer) objectFloor(reason string) guard {
	f := s.factory()
	return guard{node: guardClosure(f, nil, objectKindCondition(f)), reason: reason, floor: true}
}

// nonPrimitiveGuard is the guard for the `object` KEYWORD, whose values are
// everything that is not a primitive.
//
// It carries no weakening reason because none applies: `objectKindCondition` is
// not a floor UNDER this type, it is the whole of it — an object and a function
// inhabit `object`, a string and a number do not, and there is nothing further to
// read off a value to decide it. It is still marked a floor, so a rest slice,
// which is an array and therefore passes it by construction, drops it.
func (s *synthesizer) nonPrimitiveGuard() guard {
	f := s.factory()
	return guard{node: guardClosure(f, nil, objectKindCondition(f)), floor: true}
}

// iterableNames are the library interface names that define the iteration
// protocol — a value of any of these carries `Symbol.iterator`.
var iterableNames = map[string]bool{
	"Iterable": true, "IterableIterator": true, "ReadonlyArray": true,
	"ReadonlySet": true, "ReadonlyMap": true,
}

// isIterableType reports whether t is one of the library iteration-protocol
// interfaces whose defining runtime property is `Symbol.iterator`.
func (s *synthesizer) isIterableType(t *shimchecker.Type) bool {
	if !typesurface.FromLibrary(s.prog, t) {
		return false
	}
	return iterableNames[typeSymbolName(t)]
}

// iterableGuard emits a guard that checks both the object kind and the
// `Symbol.iterator` member:
//
//	(input) => (typeof input === "object" || typeof input === "function")
//	    && input !== null && Symbol.iterator in input
func (s *synthesizer) iterableGuard() guard {
	f := s.factory()
	condition := f.NewBinaryExpression(
		nil,
		objectKindCondition(f),
		nil,
		f.NewToken(shimast.KindAmpersandAmpersandToken),
		f.NewBinaryExpression(
			nil,
			f.NewPropertyAccessExpression(f.NewIdentifier("Symbol"), nil, f.NewIdentifier("iterator"), shimast.NodeFlagsNone),
			nil,
			f.NewToken(shimast.KindInKeyword),
			f.NewIdentifier("input"),
		),
	)
	return guard{node: guardClosure(f, nil, condition)}
}

// firstReason is the first non-empty of two weakening reasons — a guard reports
// the first position it could not cover, not every one.
func firstReason(reasons ...string) string {
	for _, reason := range reasons {
		if reason != "" {
			return reason
		}
	}
	return ""
}

// typeofGuard emits `(input) => typeof input === "<kind>"` — the whole of what a
// value of a callable or symbol type can be checked for.
func typeofGuard(f *shimast.NodeFactory, kind string) *shimast.Node {
	condition := f.NewBinaryExpression(
		nil,
		f.NewTypeOfExpression(f.NewIdentifier("input")),
		nil,
		f.NewToken(shimast.KindEqualsEqualsEqualsToken),
		f.NewStringLiteral(kind, shimast.TokenFlagsNone),
	)
	return guardClosure(f, nil, condition)
}

// intersectionGuard emits `(input) => i0(input) && i1(input)` over the
// constituents — a value is of the intersection exactly when it is of each.
//
// A BRAND is the exception. In `type UserId = string & { readonly __brand:
// "UserId" }` the object constituent is phantom: a value of the type is a plain
// string at runtime and carries no `__brand` member at all, so conjoining a check
// for one yields a guard that rejects EVERY genuine value. Whenever a primitive
// constituent is present it decides the whole intersection, which is also what a
// hand-written check for such a type does. That costs nothing checkable, so it is
// not reported as a weakening.
func (s *synthesizer) intersectionGuard(
	context nativecontext.ITypiaContext,
	t *shimchecker.Type,
	seen map[*shimchecker.Type]bool,
) guard {
	constituents := t.Types()
	if primitives := primitiveConstituents(constituents); len(primitives) > 0 {
		constituents = primitives
	}

	f := s.factory()
	declarations := make([]*shimast.Node, 0, len(constituents))
	var condition *shimast.Node
	reason := ""
	floor := true
	for _, constituent := range constituents {
		part := s.guardForType(context, constituent, s.checker.TypeToString(constituent), seen)
		reason = firstReason(reason, part.reason)
		if part.node == nil {
			// A conjunct nobody can test simply drops out; the rest still narrow.
			continue
		}
		if !part.floor {
			floor = false
		}
		local := "i" + itoa(len(declarations))
		declarations = append(declarations, f.NewVariableDeclaration(f.NewIdentifier(local), nil, nil, part.node))
		call := f.NewCallExpression(
			f.NewIdentifier(local),
			nil,
			nil,
			f.NewNodeList([]*shimast.Node{f.NewIdentifier("input")}),
			shimast.NodeFlagsNone,
		)
		if condition == nil {
			condition = call
			continue
		}
		condition = f.NewBinaryExpression(nil, condition, nil, f.NewToken(shimast.KindAmpersandAmpersandToken), call)
	}
	if condition == nil {
		return guard{reason: firstReason(reason, "any constituent of "+s.checker.TypeToString(t))}
	}
	return guard{node: guardClosure(f, declarations, condition), reason: reason, floor: floor}
}

// primitiveTypeFlags are the types whose values are not objects at runtime, so
// no member of theirs can be read.
const primitiveTypeFlags = shimchecker.TypeFlagsString | shimchecker.TypeFlagsNumber |
	shimchecker.TypeFlagsBoolean | shimchecker.TypeFlagsBigInt | shimchecker.TypeFlagsESSymbolLike |
	shimchecker.TypeFlagsUndefined | shimchecker.TypeFlagsNull | shimchecker.TypeFlagsVoid |
	shimchecker.TypeFlagsLiteral | shimchecker.TypeFlagsEnumLike |
	shimchecker.TypeFlagsTemplateLiteral | shimchecker.TypeFlagsStringMapping

func isPrimitiveType(t *shimchecker.Type) bool {
	return t != nil && t.Flags()&primitiveTypeFlags != 0
}

func primitiveConstituents(types []*shimchecker.Type) []*shimchecker.Type {
	primitives := make([]*shimchecker.Type, 0, len(types))
	for _, t := range types {
		if isPrimitiveType(t) {
			primitives = append(primitives, t)
		}
	}
	return primitives
}

// tupleGuard emits, over a tuple of required-then-optional elements:
//
//	(input) => Array.isArray(input) && input.length >= REQUIRED
//	    && input.length <= TOTAL && t0(input[0])
//	    && (input[1] === undefined || t1(input[1]))
//
// A rest or variadic element leaves the positions themselves unfixed, so no
// per-index clause is meaningful and only the array floor survives.
func (s *synthesizer) tupleGuard(
	context nativecontext.ITypiaContext,
	t *shimchecker.Type,
	seen map[*shimchecker.Type]bool,
) guard {
	elementFlags := t.TargetTupleType().ElementFlags()
	required := 0
	for _, flags := range elementFlags {
		switch flags {
		case shimchecker.ElementFlagsRequired:
			required++
		case shimchecker.ElementFlagsOptional:
		default:
			f := s.factory()
			return guard{
				node:   guardClosure(f, nil, isArrayCall(f, f.NewIdentifier("input"))),
				reason: s.checker.TypeToString(t) + ", a tuple whose rest or variadic element leaves no fixed position",
				floor:  true,
			}
		}
	}
	elements := s.checker.GetTypeArguments(t)
	f := s.factory()
	length := func() *shimast.Node {
		return f.NewPropertyAccessExpression(f.NewIdentifier("input"), nil, f.NewIdentifier("length"), shimast.NodeFlagsNone)
	}
	condition := f.NewBinaryExpression(
		nil,
		isArrayCall(f, f.NewIdentifier("input")),
		nil,
		f.NewToken(shimast.KindAmpersandAmpersandToken),
		f.NewBinaryExpression(nil, length(), nil, f.NewToken(shimast.KindGreaterThanEqualsToken), numericLiteral(f, required)),
	)
	condition = f.NewBinaryExpression(
		nil,
		condition,
		nil,
		f.NewToken(shimast.KindAmpersandAmpersandToken),
		f.NewBinaryExpression(nil, length(), nil, f.NewToken(shimast.KindLessThanEqualsToken), numericLiteral(f, len(elements))),
	)
	declarations := make([]*shimast.Node, 0, len(elements))
	reason := ""
	for i, element := range elements {
		part := s.guardForType(context, element, s.checker.TypeToString(element), seen)
		reason = firstReason(reason, part.reason)
		if part.node == nil {
			continue
		}
		local := "t" + itoa(i)
		declarations = append(declarations, f.NewVariableDeclaration(f.NewIdentifier(local), nil, nil, part.node))
		at := func() *shimast.Node {
			return f.NewElementAccessExpression(f.NewIdentifier("input"), nil, numericLiteral(f, i), shimast.NodeFlagsNone)
		}
		checked := f.NewCallExpression(f.NewIdentifier(local), nil, nil, f.NewNodeList([]*shimast.Node{at()}), shimast.NodeFlagsNone)
		if i < len(elementFlags) && elementFlags[i] == shimchecker.ElementFlagsOptional {
			absent := f.NewBinaryExpression(
				nil,
				at(),
				nil,
				f.NewToken(shimast.KindEqualsEqualsEqualsToken),
				f.NewIdentifier("undefined"),
			)
			checked = f.NewParenthesizedExpression(
				f.NewBinaryExpression(nil, absent, nil, f.NewToken(shimast.KindBarBarToken), checked),
			)
		}
		condition = f.NewBinaryExpression(nil, condition, nil, f.NewToken(shimast.KindAmpersandAmpersandToken), checked)
	}
	// The length bounds pin the tuple's arity whatever its elements turn out to
	// be, so this is never a bare runtime-kind check.
	return guard{node: guardClosure(f, declarations, condition), reason: reason}
}

// recordGuard emits, for a string-index-signature type:
//
//	(() => {
//	    const v0 = <value guard>;
//	    return (input) => (typeof input === "object" || typeof input === "function")
//	        && input !== null && Object.values(input).every((v) => v0(v));
//	})()
//
// Named members declared alongside the index signature contribute their own
// clauses on top.
func (s *synthesizer) recordGuard(
	context nativecontext.ITypiaContext,
	t *shimchecker.Type,
	seen map[*shimchecker.Type]bool,
) guard {
	valueType := s.stringIndexValueType(t)
	value := s.guardForType(context, valueType, s.checker.TypeToString(valueType), seen)

	f := s.factory()
	declarations := []*shimast.Node{}
	condition := objectKindCondition(f)
	if value.node != nil {
		declarations = append(declarations, f.NewVariableDeclaration(f.NewIdentifier("v0"), nil, nil, value.node))
		valueParam := f.NewParameterDeclaration(nil, nil, f.NewIdentifier("v"), nil, nil, nil)
		predicate := f.NewArrowFunction(
			nil, nil,
			f.NewNodeList([]*shimast.Node{valueParam}),
			nil, nil,
			f.NewToken(shimast.KindEqualsGreaterThanToken),
			f.NewCallExpression(f.NewIdentifier("v0"), nil, nil, f.NewNodeList([]*shimast.Node{f.NewIdentifier("v")}), shimast.NodeFlagsNone),
		)
		values := f.NewCallExpression(
			f.NewPropertyAccessExpression(f.NewIdentifier("Object"), nil, f.NewIdentifier("values"), shimast.NodeFlagsNone),
			nil, nil,
			f.NewNodeList([]*shimast.Node{f.NewIdentifier("input")}),
			shimast.NodeFlagsNone,
		)
		every := f.NewCallExpression(
			f.NewPropertyAccessExpression(values, nil, f.NewIdentifier("every"), shimast.NodeFlagsNone),
			nil, nil,
			f.NewNodeList([]*shimast.Node{predicate}),
			shimast.NodeFlagsNone,
		)
		condition = f.NewBinaryExpression(nil, condition, nil, f.NewToken(shimast.KindAmpersandAmpersandToken), every)
	}

	memberDeclarations, memberCondition, clauses, memberReason := s.memberClauses(context, t, condition, seen)
	return guard{
		node:   guardClosure(f, append(declarations, memberDeclarations...), memberCondition),
		reason: firstReason(value.reason, memberReason),
		floor:  value.node == nil && clauses == 0,
	}
}

// unionGuard emits `(input) => u0(input) || u1(input)` over the constituents.
//
// Unlike every other composition, a union cannot drop an arm: a value of an
// unchecked arm IS a value of the union, so a disjunction missing that arm would
// REJECT it. An arm with no guard therefore costs the whole union its guard.
func (s *synthesizer) unionGuard(
	context nativecontext.ITypiaContext,
	t *shimchecker.Type,
	seen map[*shimchecker.Type]bool,
) guard {
	f := s.factory()
	declarations := make([]*shimast.Node, 0, len(t.Types()))
	var condition *shimast.Node
	reason := ""
	floor := true
	for i, constituent := range t.Types() {
		arm := s.guardForType(context, constituent, s.checker.TypeToString(constituent), seen)
		reason = firstReason(reason, arm.reason)
		if arm.node == nil {
			return guard{reason: reason}
		}
		if !arm.floor {
			floor = false
		}
		local := "u" + itoa(i)
		declarations = append(declarations, f.NewVariableDeclaration(f.NewIdentifier(local), nil, nil, arm.node))
		call := f.NewCallExpression(
			f.NewIdentifier(local),
			nil,
			nil,
			f.NewNodeList([]*shimast.Node{f.NewIdentifier("input")}),
			shimast.NodeFlagsNone,
		)
		if condition == nil {
			condition = call
			continue
		}
		condition = f.NewBinaryExpression(nil, condition, nil, f.NewToken(shimast.KindBarBarToken), call)
	}
	if condition == nil {
		return guard{reason: "an empty union"}
	}
	return guard{node: guardClosure(f, declarations, condition), reason: reason, floor: floor}
}

// arrayGuard emits `(input) => Array.isArray(input) && input.every((e) => g(e))`.
func (s *synthesizer) arrayGuard(
	context nativecontext.ITypiaContext,
	t *shimchecker.Type,
	seen map[*shimchecker.Type]bool,
) guard {
	element := s.arrayElementType(t)
	part := s.guardForType(context, element, s.checker.TypeToString(element), seen)
	f := s.factory()
	if part.node == nil {
		return guard{
			node:   guardClosure(f, nil, isArrayCall(f, f.NewIdentifier("input"))),
			reason: part.reason,
			floor:  true,
		}
	}
	declarations := []*shimast.Node{f.NewVariableDeclaration(f.NewIdentifier("e0"), nil, nil, part.node)}

	elementParam := f.NewParameterDeclaration(nil, nil, f.NewIdentifier("e"), nil, nil, nil)
	predicate := f.NewArrowFunction(
		nil, nil,
		f.NewNodeList([]*shimast.Node{elementParam}),
		nil, nil,
		f.NewToken(shimast.KindEqualsGreaterThanToken),
		f.NewCallExpression(f.NewIdentifier("e0"), nil, nil, f.NewNodeList([]*shimast.Node{f.NewIdentifier("e")}), shimast.NodeFlagsNone),
	)
	every := f.NewCallExpression(
		f.NewPropertyAccessExpression(f.NewIdentifier("input"), nil, f.NewIdentifier("every"), shimast.NodeFlagsNone),
		nil, nil,
		f.NewNodeList([]*shimast.Node{predicate}),
		shimast.NodeFlagsNone,
	)
	condition := f.NewBinaryExpression(nil, isArrayCall(f, f.NewIdentifier("input")), nil, f.NewToken(shimast.KindAmpersandAmpersandToken), every)
	return guard{node: guardClosure(f, declarations, condition), reason: part.reason}
}

// nominalGlobals map a built-in to the global constructor to test it against.
//
// THE MEMBERSHIP RULE, which every future entry has to pass: only a type whose
// values cannot exist without its constructor belongs here. Each one below carries
// internal state no object literal can hold — a Map's entry table, a Date's time
// value, a RegExp's pattern, an ArrayBuffer's bytes — so an object merely
// implementing the interface is not a working value of the type, and `instanceof`
// IS the check a hand-written guard writes.
//
// A STRUCTURALLY SATISFIABLE interface does not belong, however built-in it looks,
// because `instanceof` on one REJECTS values the type admits. `Error` is the
// trap: its whole declared surface is `name`, `message` and an optional `stack`,
// all plain strings, so `const e: Error = { name: "a", message: "b" }` is a legal
// value that `instanceof Error` refuses. A readonly view (`ReadonlyMap`,
// `ReadonlySet`, `Iterable`) fails the rule the same way. Those types fall through
// to the composer, which floors them.
var nominalGlobals = map[string]string{
	"Map": "Map", "Set": "Set", "WeakMap": "WeakMap", "WeakSet": "WeakSet",
	"Date": "Date", "RegExp": "RegExp",
	"ArrayBuffer": "ArrayBuffer", "SharedArrayBuffer": "SharedArrayBuffer", "DataView": "DataView",
}

// libraryNominalName is the ONE place this stage turns a type into a built-in's
// name, and it reads the name only AFTER typesurface.FromLibrary has admitted the
// type as a nominal declaration of the default library.
//
// A name is not an identity. A first-party `interface Set { bag: Opts }` is named
// "Set" and is not the global `Set`; anything keying on the name alone hands such
// a type to a check written for the built-in. Every nominal decision in the engine
// — the composer's `instanceof` and the fast path's whitelist alike — asks this
// one function, so the two cannot answer differently.
func (s *synthesizer) libraryNominalName(t *shimchecker.Type) string {
	if !typesurface.FromLibrary(s.prog, t) {
		return ""
	}
	return typeSymbolName(t)
}

// nominalGlobalOf returns the constructor to test t against, or "" when t is not
// one of the directly-testable built-ins.
func (s *synthesizer) nominalGlobalOf(t *shimchecker.Type) string {
	return nominalGlobals[s.libraryNominalName(t)]
}

// nominalGuard emits `input instanceof Map`, plus an entry-wise or element-wise
// clause where the container's contents decompose:
//
//	(() => {
//	    const k0 = <key guard>, v0 = <value guard>;
//	    return (input) => input instanceof Map
//	        && [...input].every((e) => k0(e[0]) && v0(e[1]));
//	})()
func (s *synthesizer) nominalGuard(
	context nativecontext.ITypiaContext,
	t *shimchecker.Type,
	seen map[*shimchecker.Type]bool,
) guard {
	f := s.factory()
	name := s.libraryNominalName(t)
	condition := f.NewBinaryExpression(
		nil,
		f.NewIdentifier("input"),
		nil,
		f.NewToken(shimast.KindInstanceOfKeyword),
		f.NewIdentifier(nominalGlobals[name]),
	)
	if name != "Map" && name != "Set" {
		return guard{node: guardClosure(f, nil, condition)}
	}

	// A Map iterates as `[key, value]` pairs and a Set as its elements, so one
	// `every` over the spread covers either.
	arguments := s.checker.GetTypeArguments(t)
	declarations := make([]*shimast.Node, 0, len(arguments))
	var element *shimast.Node
	reason := ""
	for i, argument := range arguments {
		part := s.guardForType(context, argument, s.checker.TypeToString(argument), seen)
		reason = firstReason(reason, part.reason)
		if part.node == nil {
			continue
		}
		local := "a" + itoa(i)
		declarations = append(declarations, f.NewVariableDeclaration(f.NewIdentifier(local), nil, nil, part.node))
		subject := f.NewIdentifier("e")
		if name == "Map" {
			subject = f.NewElementAccessExpression(f.NewIdentifier("e"), nil, numericLiteral(f, i), shimast.NodeFlagsNone)
		}
		checked := f.NewCallExpression(f.NewIdentifier(local), nil, nil, f.NewNodeList([]*shimast.Node{subject}), shimast.NodeFlagsNone)
		if element == nil {
			element = checked
			continue
		}
		element = f.NewBinaryExpression(nil, element, nil, f.NewToken(shimast.KindAmpersandAmpersandToken), checked)
	}
	if element == nil {
		return guard{node: guardClosure(f, nil, condition), reason: reason}
	}
	predicate := f.NewArrowFunction(
		nil, nil,
		f.NewNodeList([]*shimast.Node{f.NewParameterDeclaration(nil, nil, f.NewIdentifier("e"), nil, nil, nil)}),
		nil, nil,
		f.NewToken(shimast.KindEqualsGreaterThanToken),
		element,
	)
	spread := f.NewArrayLiteralExpression(
		f.NewNodeList([]*shimast.Node{f.NewSpreadElement(f.NewIdentifier("input"))}),
		false,
	)
	every := f.NewCallExpression(
		f.NewPropertyAccessExpression(spread, nil, f.NewIdentifier("every"), shimast.NodeFlagsNone),
		nil, nil,
		f.NewNodeList([]*shimast.Node{predicate}),
		shimast.NodeFlagsNone,
	)
	condition = f.NewBinaryExpression(nil, condition, nil, f.NewToken(shimast.KindAmpersandAmpersandToken), every)
	return guard{node: guardClosure(f, declarations, condition), reason: reason}
}

// objectGuard emits one clause per PUBLIC, READABLE member over an object/class
// type:
//
//	(() => {
//	    const m0 = <member guard>;
//	    return (input) => typeof input === "object" && input !== null
//	        && !Array.isArray(input) && m0(input.name);
//	})()
//
// An `?`-optional member's clause admits an absent value directly.
//
// A type nothing can be read from — every member `#`-named, `private` or a
// set-only accessor — keeps the object floor and nothing else: per-member clauses
// would be keyed on names no value carries. The same holds one member at a time:
// a symbol-keyed member is one a caller CAN supply but no string key reads, so
// the clauses around it stand while its absence is reported. A member whose key
// never exists at runtime is not reported at all — there is no value carrying it
// for a caller to have lost. `internal/schema` refuses the mirror-image shape
// (nothing WRITABLE) on the same predicate.
func (s *synthesizer) objectGuard(
	context nativecontext.ITypiaContext,
	t *shimchecker.Type,
	seen map[*shimchecker.Type]bool,
) guard {
	f := s.factory()
	surface := typesurface.For(s.checker, t, nil)
	if surface.NothingReadable() {
		return s.objectFloor(s.checker.TypeToString(t) + ", none of whose members can be read from outside it")
	}
	declarations, condition, clauses, memberReason := s.memberClauses(context, t, objectKindCondition(f), seen)
	reason := memberReason
	if surface.SymbolKeyed > 0 {
		reason = firstReason(s.checker.TypeToString(t)+", which has a member no string key can name", reason)
	}
	if clauses == 0 {
		return s.objectFloor(firstReason(reason, s.checker.TypeToString(t)+", which exposes no member to check"))
	}
	return guard{node: guardClosure(f, declarations, condition), reason: reason}
}

// objectKindCondition is the shared prefix of every composed object guard, and the
// whole of the floor:
//
//	(typeof input === "object" || typeof input === "function") && input !== null
//
// It is the widest runtime-kind assertion that holds for EVERY value an object
// type admits, and asserting anything beyond it is what a floor may not do. Two
// tighter clauses look obvious and are each false for values their own type
// admits:
//
//   - `typeof input === "object"` on its own rejects a function, and `Function` —
//     along with every interface a function carrying properties satisfies — admits
//     one;
//   - `!Array.isArray(input)` rejects an array, and `ArrayLike<T>`, `Iterable<T>`
//     and `object` all admit one.
//
// A clause that is false for a genuine value does not weaken dispatch, it INVERTS
// it: the call the extension was written for goes to whatever held the name
// before. Giving up the narrowing is the cheaper mistake.
func objectKindCondition(f *shimast.NodeFactory) *shimast.Node {
	typeis := func(kind string) *shimast.Node {
		return f.NewBinaryExpression(
			nil,
			f.NewTypeOfExpression(f.NewIdentifier("input")),
			nil,
			f.NewToken(shimast.KindEqualsEqualsEqualsToken),
			f.NewStringLiteral(kind, shimast.TokenFlagsNone),
		)
	}
	kind := f.NewParenthesizedExpression(
		f.NewBinaryExpression(nil, typeis("object"), nil, f.NewToken(shimast.KindBarBarToken), typeis("function")),
	)
	return f.NewBinaryExpression(
		nil,
		kind,
		nil,
		f.NewToken(shimast.KindAmpersandAmpersandToken),
		f.NewBinaryExpression(
			nil,
			f.NewIdentifier("input"),
			nil,
			f.NewToken(shimast.KindExclamationEqualsEqualsToken),
			f.NewKeywordExpression(shimast.KindNullKeyword),
		),
	)
}

func isArrayCall(f *shimast.NodeFactory, subject *shimast.Node) *shimast.Node {
	return f.NewCallExpression(
		f.NewPropertyAccessExpression(f.NewIdentifier("Array"), nil, f.NewIdentifier("isArray"), shimast.NodeFlagsNone),
		nil, nil,
		f.NewNodeList([]*shimast.Node{subject}),
		shimast.NodeFlagsNone,
	)
}

// memberClauses conjoins one `mN(input.name)` clause onto condition per public,
// readable member of t, returning the sub-guard declarations, the number of
// clauses added, and the first member it could not cover. A set-only accessor is
// skipped: it cannot be read, so a clause on it could never pass on a genuine
// value. A member whose own type yields no guard is skipped the same way — the
// remaining clauses still narrow.
func (s *synthesizer) memberClauses(
	context nativecontext.ITypiaContext,
	t *shimchecker.Type,
	condition *shimast.Node,
	seen map[*shimchecker.Type]bool,
) ([]*shimast.Node, *shimast.Node, int, string) {
	f := s.factory()
	members := typesurface.For(s.checker, t, nil).Readable()
	declarations := make([]*shimast.Node, 0, len(members))
	reason := ""
	for _, m := range members {
		memberType := s.checker.GetTypeOfSymbolAtLocation(m.Symbol, m.Decl)
		if memberType == nil {
			reason = firstReason(reason, "member \""+m.Name+"\" of "+s.checker.TypeToString(t)+", whose type does not resolve")
			continue
		}
		part := s.guardForType(context, memberType, s.checker.TypeToString(memberType), seen)
		reason = firstReason(reason, part.reason)
		if part.node == nil {
			continue
		}
		local := "m" + itoa(len(declarations))
		declarations = append(declarations, f.NewVariableDeclaration(f.NewIdentifier(local), nil, nil, part.node))

		read := func() *shimast.Node {
			if isIdentifierName(m.Name) {
				return f.NewPropertyAccessExpression(f.NewIdentifier("input"), nil, f.NewIdentifier(m.Name), shimast.NodeFlagsNone)
			}
			return f.NewElementAccessExpression(f.NewIdentifier("input"), nil, f.NewStringLiteral(m.Name, shimast.TokenFlagsNone), shimast.NodeFlagsNone)
		}
		checked := f.NewCallExpression(f.NewIdentifier(local), nil, nil, f.NewNodeList([]*shimast.Node{read()}), shimast.NodeFlagsNone)
		if m.Optional {
			absent := f.NewBinaryExpression(
				nil,
				read(),
				nil,
				f.NewToken(shimast.KindEqualsEqualsEqualsToken),
				f.NewIdentifier("undefined"),
			)
			checked = f.NewParenthesizedExpression(
				f.NewBinaryExpression(nil, absent, nil, f.NewToken(shimast.KindBarBarToken), checked),
			)
		}
		condition = f.NewBinaryExpression(nil, condition, nil, f.NewToken(shimast.KindAmpersandAmpersandToken), checked)
	}
	return declarations, condition, len(declarations), reason
}

// guardClosure wraps a condition over `input` as a self-invoking closure binding
// its sub-guards, so their names stay local:
//
//	(() => { const g = …; return (input) => <condition>; })()
func guardClosure(f *shimast.NodeFactory, declarations []*shimast.Node, condition *shimast.Node) *shimast.Node {
	predicate := f.NewArrowFunction(
		nil, nil,
		f.NewNodeList([]*shimast.Node{f.NewParameterDeclaration(nil, nil, f.NewIdentifier("input"), nil, nil, nil)}),
		nil, nil,
		f.NewToken(shimast.KindEqualsGreaterThanToken),
		condition,
	)
	if len(declarations) == 0 {
		return predicate
	}
	body := f.NewBlock(f.NewNodeList([]*shimast.Node{
		f.NewVariableStatement(nil, f.NewVariableDeclarationList(f.NewNodeList(declarations), shimast.NodeFlagsConst)),
		f.NewReturnStatement(predicate),
	}), true)
	closure := f.NewArrowFunction(nil, nil, f.NewNodeList(nil), nil, nil, f.NewToken(shimast.KindEqualsGreaterThanToken), body)
	return f.NewCallExpression(
		f.NewParenthesizedExpression(closure),
		nil, nil,
		f.NewNodeList(nil),
		shimast.NodeFlagsNone,
	)
}

// typiaNativeClasses are the classes typia's is-programmer checks with a plain
// `instanceof`, never by enumerating members. Membership in one of these is
// nominal, which is exactly what a hand-written check would test. The list is a
// whitelist: a class typia later learns about but this table does not merely gets
// composed or refused here, which is safe either way.
//
// It is keyed by name and read only through libraryNominalName, so a first-party
// type sharing one of these names is not admitted by it.
var typiaNativeClasses = map[string]bool{
	"ArrayBuffer": true, "SharedArrayBuffer": true, "DataView": true,
	"Blob": true, "File": true, "Date": true, "RegExp": true,
	"Boolean": true, "Number": true, "String": true, "BigInt": true,
	"WeakMap": true, "WeakSet": true,
	"Int8Array": true, "Int16Array": true, "Int32Array": true, "BigInt64Array": true,
	"Uint8Array": true, "Uint8ClampedArray": true, "Uint16Array": true, "Uint32Array": true,
	"BigUint64Array": true, "Float32Array": true, "Float64Array": true,
}

// typiaFaithful reports whether typia's is-programmer renders t — and every type
// reachable from it — the way a hand-written check would.
//
// This is a WHITELIST, and deliberately total: the final `return false` catches
// every construct not positively recognized above it. A position typia gets wrong
// yields a clause that cannot decide anything (a key no object carries, a bare
// `true`) and reads exactly like a correct one, so the cost of forgetting a case
// has to fall on the composer, not on the emitted guard.
func (s *synthesizer) typiaFaithful(t *shimchecker.Type, seen map[*shimchecker.Type]bool) bool {
	if t == nil {
		return false
	}
	if seen[t] {
		// Reached through itself. typia emits a self-referencing helper with its
		// own cycle detection, so the cycle costs nothing; whether the type is
		// faithful is settled by its finite positions, which this same walk
		// reaches on the way here.
		return true
	}
	seen[t] = true
	defer delete(seen, t)

	flags := t.Flags()
	switch {
	// `boolean` is modeled as `false | true` and carries the Union flag as well,
	// so it has to be classified ahead of any union handling.
	case flags&shimchecker.TypeFlagsBoolean != 0:
		return true
	// A leaf typia checks with a single `typeof`, walking no members.
	case flags&(shimchecker.TypeFlagsString|shimchecker.TypeFlagsNumber|shimchecker.TypeFlagsBigInt|
		shimchecker.TypeFlagsUndefined|shimchecker.TypeFlagsNull|shimchecker.TypeFlagsVoid) != 0:
		return true
	// A literal or enum member is compared against its own value.
	case flags&(shimchecker.TypeFlagsLiteral|shimchecker.TypeFlagsEnumLike) != 0:
		return true
	// A template-literal (or Uppercase/Lowercase) type becomes a `typeof` plus
	// the pattern typia compiles from it.
	case flags&(shimchecker.TypeFlagsTemplateLiteral|shimchecker.TypeFlagsStringMapping) != 0:
		return true
	// Every value inhabits `any` and `unknown`, and none inhabits `never`, so
	// typia's constant is the whole of what any check could say.
	case flags&(shimchecker.TypeFlagsAny|shimchecker.TypeFlagsUnknown|shimchecker.TypeFlagsNever) != 0:
		return true
	// A symbol HAS a `typeof` check, but typia emits a constant `true` for it —
	// a clause that can never be false. Composed instead.
	case flags&shimchecker.TypeFlagsESSymbolLike != 0:
		return false
	// typia checks a union arm by arm, so each arm's own rendering decides.
	case flags&shimchecker.TypeFlagsUnion != 0:
		for _, constituent := range t.Types() {
			if !s.typiaFaithful(constituent, seen) {
				return false
			}
		}
		return true
	// typia merges an intersection's constituents into ONE member set, which
	// works only while they are all objects. A primitive constituent — the
	// `string` half of a brand like `string & { readonly __brand: "UserId" }` — is
	// dropped instead, leaving a check the primitive's own values fail.
	case flags&shimchecker.TypeFlagsIntersection != 0:
		for _, constituent := range t.Types() {
			if isPrimitiveType(constituent) || !s.typiaFaithful(constituent, seen) {
				return false
			}
		}
		return true
	case flags&shimchecker.TypeFlagsObject != 0:
		return s.objectFaithful(t, seen)
	}
	// A type parameter, a conditional, an indexed access, bare `object`, an error
	// type: not recognized, so not assumed.
	return false
}

// objectFaithful is typiaFaithful's object-type arm.
func (s *synthesizer) objectFaithful(t *shimchecker.Type, seen map[*shimchecker.Type]bool) bool {
	// A tuple checks positionally and an array checks `Array.isArray` plus every
	// element; in both the element types ARE the type arguments.
	if shimchecker.IsTupleType(t) || shimchecker.Checker_isArrayType(s.checker, t) || isReadonlyArrayType(t) {
		return s.typeArgumentsFaithful(t, seen)
	}
	// Both of these admit a type by its NAME, so both read it through the same
	// identity gate the composer's `instanceof` uses: a first-party type named
	// `Set` is not the global `Set`, and handing one to typia's fast path is how a
	// vacuous clause gets emitted for it.
	name := s.libraryNominalName(t)
	// A Map or Set is `instanceof` plus an entry-wise / element-wise check over
	// the type arguments.
	if name == "Map" || name == "Set" {
		return s.typeArgumentsFaithful(t, seen)
	}
	if typiaNativeClasses[name] {
		return true
	}
	// A callable becomes a constant `true` — never false, whatever is passed.
	if s.isCallable(t) {
		return false
	}
	// Any other nominal built-in: typia enumerates the members implementing an
	// identity — often symbol-keyed ones — and calls the result a check.
	if typesurface.FromLibrary(s.prog, t) {
		return false
	}
	indexInfos := shimchecker.Checker_getIndexInfosOfType(s.checker, t)
	surface := typesurface.For(s.checker, t, nil)
	switch {
	// Keyed on the checker's internal mangled name, which no object carries. A
	// phantom member counts here even though nothing needs checking for it: typia
	// enumerates the declaration either way, so the mangled key still reaches the
	// emit.
	case surface.PrivateNamed > 0 || surface.SymbolKeyed > 0 || surface.Phantom > 0:
		return false
	// Skipped outright, so the member goes unchecked. typia decides this on the
	// member's DECLARATION, so it holds through a mapped type (`Partial<T>`,
	// `{ [K in keyof T]: T[K] }`) that reminted the accessor as a property.
	case surface.HasAccessor:
		return false
	// Nothing left to check: the guard collapses to a constant `true`.
	case surface.NothingReadable():
		return false
	}
	for _, m := range surface.Members {
		memberType := s.checker.GetTypeOfSymbolAtLocation(m.Symbol, m.Decl)
		if memberType == nil || !s.typiaFaithful(memberType, seen) {
			return false
		}
	}
	// A mapped type's value type is reachable ONLY here: it has neither
	// properties nor type arguments of its own.
	for _, info := range indexInfos {
		if !s.typiaFaithful(info.KeyType(), seen) || !s.typiaFaithful(info.ValueType(), seen) {
			return false
		}
	}
	return s.typeArgumentsFaithful(t, seen)
}

// typeArgumentsFaithful walks an instantiation's type arguments. ONLY a
// reference type has them — asking any other object type panics — and every other
// object shape reaches its inner types through its members or its index infos.
func (s *synthesizer) typeArgumentsFaithful(t *shimchecker.Type, seen map[*shimchecker.Type]bool) bool {
	if t.ObjectFlags()&shimchecker.ObjectFlagsReference == 0 {
		return true
	}
	for _, argument := range s.checker.GetTypeArguments(t) {
		if !s.typiaFaithful(argument, seen) {
			return false
		}
	}
	return true
}

// typeSymbolName is the declared name of t's own symbol, or its generic target's
// — `Map<string, number>` reads as "Map".
func typeSymbolName(t *shimchecker.Type) string {
	if symbol := t.Symbol(); symbol != nil {
		return symbol.Name
	}
	if target := t.Target(); target != nil && target.Symbol() != nil {
		return target.Symbol().Name
	}
	return ""
}

// callableKinds reports which callable signature kinds t carries, each read as
// its own query so a constructor type is recognized distinctly from a plain
// function type.
func (s *synthesizer) callableKinds(t *shimchecker.Type) (call, construct bool) {
	if t == nil || t.Flags()&shimchecker.TypeFlagsObject == 0 {
		return false, false
	}
	call = len(shimchecker.Checker_getSignaturesOfType(s.checker, t, shimchecker.SignatureKindCall)) > 0
	construct = len(shimchecker.Checker_getSignaturesOfType(s.checker, t, shimchecker.SignatureKindConstruct)) > 0
	return call, construct
}

// isCallable reports whether values of t are functions — an object type with a
// call or construct signature, either kind.
func (s *synthesizer) isCallable(t *shimchecker.Type) bool {
	call, construct := s.callableKinds(t)
	return call || construct
}

// callableGuard is the guard for a callable type. Every callable is
// `typeof === "function"`; a type carrying ONLY construct signatures is
// further discriminated as a constructor (constructorCondition). A type with
// call signatures keeps the bare typeof check even when construct signatures
// sit beside them: an ordinary function declaration is itself constructible,
// so no runtime read separates "callable" from "also constructible" without
// rejecting genuine values.
func (s *synthesizer) callableGuard(t *shimchecker.Type) guard {
	f := s.factory()
	call, construct := s.callableKinds(t)
	if construct && !call {
		condition := f.NewBinaryExpression(
			nil,
			f.NewParenthesizedExpression(f.NewBinaryExpression(
				nil,
				f.NewTypeOfExpression(f.NewIdentifier("input")),
				nil,
				f.NewToken(shimast.KindEqualsEqualsEqualsToken),
				f.NewStringLiteral("function", shimast.TokenFlagsNone),
			)),
			nil,
			f.NewToken(shimast.KindAmpersandAmpersandToken),
			f.NewCallExpression(constructorCondition(f), nil, nil,
				f.NewNodeList([]*shimast.Node{f.NewIdentifier("input")}), shimast.NodeFlagsNone),
		)
		return guard{node: guardClosure(f, nil, condition)}
	}
	return guard{node: typeofGuard(f, "function")}
}

// constructorCondition emits the constructor discrimination a construct-only
// type adds over the typeof check:
//
//	(input) => { try { Reflect.construct(Boolean, [], input); return true; }
//	             catch { return false; } }
//
// Reflect.construct with input as the newTarget is the language's own
// IsConstructor test and runs none of input's code — Boolean's construction
// runs, input only supplies the prototype — so an arrow function or a method,
// callable but never constructible, fails the guard the way it fails the type.
func constructorCondition(f *shimast.NodeFactory) *shimast.Node {
	probe := f.NewCallExpression(
		f.NewPropertyAccessExpression(f.NewIdentifier("Reflect"), nil, f.NewIdentifier("construct"), shimast.NodeFlagsNone),
		nil, nil,
		f.NewNodeList([]*shimast.Node{
			f.NewIdentifier("Boolean"),
			f.NewArrayLiteralExpression(f.NewNodeList(nil), false),
			f.NewIdentifier("input"),
		}),
		shimast.NodeFlagsNone,
	)
	tryBlock := f.NewBlock(f.NewNodeList([]*shimast.Node{
		f.NewExpressionStatement(probe),
		f.NewReturnStatement(f.NewKeywordExpression(shimast.KindTrueKeyword)),
	}), false)
	catchBlock := f.NewBlock(f.NewNodeList([]*shimast.Node{
		f.NewReturnStatement(f.NewKeywordExpression(shimast.KindFalseKeyword)),
	}), false)
	body := f.NewBlock(f.NewNodeList([]*shimast.Node{
		f.NewTryStatement(tryBlock, f.NewCatchClause(nil, catchBlock), nil),
	}), false)
	arrow := f.NewArrowFunction(
		nil, nil,
		f.NewNodeList([]*shimast.Node{f.NewParameterDeclaration(nil, nil, f.NewIdentifier("input"), nil, nil, nil)}),
		nil, nil,
		f.NewToken(shimast.KindEqualsGreaterThanToken),
		body,
	)
	return f.NewParenthesizedExpression(arrow)
}

// stringIndexValueType returns the value type of a composable record — an object
// declared in this project whose ONLY index signature is keyed by `string`, so
// every own value can be checked with one guard over `Object.values`. A number-
// or symbol-keyed index signature returns nil: its keys do not survive
// `Object.keys` as themselves, so no faithful key check exists here.
func (s *synthesizer) stringIndexValueType(t *shimchecker.Type) *shimchecker.Type {
	if t == nil || t.Flags()&shimchecker.TypeFlagsObject == 0 {
		return nil
	}
	if s.isCallable(t) || shimchecker.IsTupleType(t) || s.arrayElementType(t) != nil {
		return nil
	}
	infos := shimchecker.Checker_getIndexInfosOfType(s.checker, t)
	if len(infos) != 1 || infos[0].KeyType().Flags()&shimchecker.TypeFlagsString == 0 {
		return nil
	}
	return infos[0].ValueType()
}

// arrayElementType returns the element type of an array (mutable or readonly),
// or nil when t is not one. A tuple is NOT an array here — its elements are
// positional, which the composer does not decompose.
func (s *synthesizer) arrayElementType(t *shimchecker.Type) *shimchecker.Type {
	if t == nil || shimchecker.IsTupleType(t) {
		return nil
	}
	if !shimchecker.Checker_isArrayType(s.checker, t) && !isReadonlyArrayType(t) {
		return nil
	}
	arguments := s.checker.GetTypeArguments(t)
	if len(arguments) != 1 {
		return nil
	}
	return arguments[0]
}

// isReadonlyArrayType reports whether t is a `readonly T[]` — a reference whose
// target is the global ReadonlyArray, which Checker_isArrayType does not cover.
func isReadonlyArrayType(t *shimchecker.Type) bool {
	if t.ObjectFlags()&shimchecker.ObjectFlagsReference == 0 {
		return false
	}
	target := t.Target()
	if target == nil || target.Symbol() == nil {
		return false
	}
	return target.Symbol().Name == "ReadonlyArray"
}

// typeNameOf is the guard's display name for a parameter's type node — the
// source text typia itself names a generic argument by.
func typeNameOf(typeNode *shimast.Node) string {
	return strings.TrimSpace(shimscanner.GetTextOfNode(typeNode))
}

// alwaysPassStrategy emits the un-derivable-member fallback:
//
//	function (original, extension) {
//	    return function (...args) { return extension.call(this, ...args); };
//	}
func (s *synthesizer) alwaysPassStrategy() *shimast.Node {
	f := s.factory()
	inner := s.dispatcherFunction(callBound(f, "extension"))
	return strategyFunction(f, f.NewBlock(f.NewNodeList([]*shimast.Node{f.NewReturnStatement(inner)}), true))
}

// guardedStrategy emits the guarded dispatcher:
//
//	function (original, extension) {
//	    const g0 = <guard>, g2 = <guard>;
//	    return function (...args) {
//	        return args.length >= MIN && args.length <= MAX
//	                && g0(args[0]) && (args[2] === undefined || g2(args[2]))
//	            ? extension(this, ...args)
//	            : original.call(this, ...args);
//	    };
//	}
//
// The guard consts live in the strategy's own scope, so their names can never
// collide with anything in the surrounding module.
func (s *synthesizer) guardedStrategy(guards []guardedParam, minArity, maxArity int, hasRest bool) *shimast.Node {
	f := s.factory()

	declarations := make([]*shimast.Node, 0, len(guards))
	var condition *shimast.Node
	and := func(next *shimast.Node) {
		if condition == nil {
			condition = next
			return
		}
		condition = f.NewBinaryExpression(nil, condition, nil, f.NewToken(shimast.KindAmpersandAmpersandToken), next)
	}

	argsLength := func() *shimast.Node {
		return f.NewPropertyAccessExpression(f.NewIdentifier("args"), nil, f.NewIdentifier("length"), shimast.NodeFlagsNone)
	}
	if minArity > 0 {
		and(f.NewBinaryExpression(nil, argsLength(), nil, f.NewToken(shimast.KindGreaterThanEqualsToken), numericLiteral(f, minArity)))
	}
	if !hasRest {
		and(f.NewBinaryExpression(nil, argsLength(), nil, f.NewToken(shimast.KindLessThanEqualsToken), numericLiteral(f, maxArity)))
	}

	for i, g := range guards {
		name := guardName(g.index)
		declarations = append(declarations, f.NewVariableDeclaration(f.NewIdentifier(name), nil, nil, g.guard))

		var checked *shimast.Node
		if g.kind == paramRest {
			// The rest slice is validated as a whole against the rest
			// parameter's (tuple/array) type: gN(args.slice(N)).
			slice := f.NewCallExpression(
				f.NewPropertyAccessExpression(f.NewIdentifier("args"), nil, f.NewIdentifier("slice"), shimast.NodeFlagsNone),
				nil,
				nil,
				f.NewNodeList([]*shimast.Node{numericLiteral(f, g.index)}),
				shimast.NodeFlagsNone,
			)
			checked = f.NewCallExpression(f.NewIdentifier(name), nil, nil, f.NewNodeList([]*shimast.Node{slice}), shimast.NodeFlagsNone)
		} else {
			element := f.NewElementAccessExpression(f.NewIdentifier("args"), nil, numericLiteral(f, g.index), shimast.NodeFlagsNone)
			checked = f.NewCallExpression(f.NewIdentifier(name), nil, nil, f.NewNodeList([]*shimast.Node{element}), shimast.NodeFlagsNone)
			if g.kind == paramOptional {
				// An absent optional argument matches without consulting the
				// guard (the declared type does not include undefined).
				absent := f.NewBinaryExpression(
					nil,
					f.NewElementAccessExpression(f.NewIdentifier("args"), nil, numericLiteral(f, g.index), shimast.NodeFlagsNone),
					nil,
					f.NewToken(shimast.KindEqualsEqualsEqualsToken),
					f.NewIdentifier("undefined"),
				)
				checked = f.NewParenthesizedExpression(
					f.NewBinaryExpression(nil, absent, nil, f.NewToken(shimast.KindBarBarToken), checked),
				)
			}
		}
		and(checked)
		_ = i
	}

	if condition == nil {
		// A member whose ONLY parameter is a rest parameter has no arity bounds to
		// keep — a rest parameter is never required and never caps the count — so
		// when its guard is dropped too there is genuinely nothing left to test.
		// Every other refusal reaches here with at least one bound or one clause.
		return s.alwaysPassStrategy()
	}
	dispatch := f.NewConditionalExpression(
		condition,
		f.NewToken(shimast.KindQuestionToken),
		callBound(f, "extension"),
		f.NewToken(shimast.KindColonToken),
		callBound(f, "original"),
	)
	inner := s.dispatcherFunction(dispatch)

	statements := []*shimast.Node{}
	if len(declarations) > 0 {
		statements = append(statements, f.NewVariableStatement(nil, f.NewVariableDeclarationList(f.NewNodeList(declarations), shimast.NodeFlagsConst)))
	}
	statements = append(statements, f.NewReturnStatement(inner))
	return strategyFunction(f, f.NewBlock(f.NewNodeList(statements), true))
}

// dispatcherFunction wraps a result expression as the mounted dispatcher:
// `function (...args) { return <result>; }` — a `function` (not arrow) so
// `this` is the receiver instance, per the MergeStrategy contract.
func (s *synthesizer) dispatcherFunction(result *shimast.Node) *shimast.Node {
	f := s.factory()
	restArgs := f.NewParameterDeclaration(nil, f.NewToken(shimast.KindDotDotDotToken), f.NewIdentifier("args"), nil, nil, nil)
	body := f.NewBlock(f.NewNodeList([]*shimast.Node{f.NewReturnStatement(result)}), true)
	return f.NewFunctionExpression(nil, nil, nil, nil, f.NewNodeList([]*shimast.Node{restArgs}), nil, nil, body)
}

// strategyFunction wraps a body as the outer strategy:
// `function (original, extension) { <body> }`.
func strategyFunction(f *shimast.NodeFactory, body *shimast.Node) *shimast.Node {
	parameters := []*shimast.Node{
		f.NewParameterDeclaration(nil, nil, f.NewIdentifier("original"), nil, nil, nil),
		f.NewParameterDeclaration(nil, nil, f.NewIdentifier("extension"), nil, nil, nil),
	}
	return f.NewFunctionExpression(nil, nil, nil, nil, f.NewNodeList(parameters), nil, nil, body)
}

// callBound emits `<name>.call(this, ...args)` — both dispatch arms are
// `this`-based members, forwarded with the dispatcher's own receiver.
func callBound(f *shimast.NodeFactory, name string) *shimast.Node {
	return f.NewCallExpression(
		f.NewPropertyAccessExpression(f.NewIdentifier(name), nil, f.NewIdentifier("call"), shimast.NodeFlagsNone),
		nil,
		nil,
		f.NewNodeList([]*shimast.Node{
			f.NewKeywordExpression(shimast.KindThisKeyword),
			f.NewSpreadElement(f.NewIdentifier("args")),
		}),
		shimast.NodeFlagsNone,
	)
}

// guardName is the strategy-scoped const holding parameter index's guard.
func guardName(index int) string {
	return "g" + itoa(index)
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := []byte{}
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

func numericLiteral(f *shimast.NodeFactory, value int) *shimast.Node {
	return f.NewNumericLiteral(itoa(value), shimast.TokenFlagsNone)
}

// propertyName mints the synthesized strategy map's key: a plain identifier
// when the member name is one, else a string literal.
func propertyName(f *shimast.NodeFactory, name string) *shimast.Node {
	if isIdentifierName(name) {
		return f.NewIdentifier(name)
	}
	return f.NewStringLiteral(name, shimast.TokenFlagsNone)
}

func isIdentifierName(name string) bool {
	if name == "" {
		return false
	}
	for i, ch := range name {
		alpha := ('A' <= ch && ch <= 'Z') || ('a' <= ch && ch <= 'z') || ch == '_' || ch == '$'
		if i == 0 {
			if !alpha {
				return false
			}
			continue
		}
		if !alpha && !('0' <= ch && ch <= '9') {
			return false
		}
	}
	return true
}

// staticName reads a property name's static string form: identifier or string
// literal text; anything else (computed, numeric) yields "".
func staticName(name *shimast.Node) string {
	if name == nil {
		return ""
	}
	if name.Kind == shimast.KindIdentifier || shimast.IsStringLiteral(name) {
		return name.Text()
	}
	return ""
}

// skipWrappers unwraps `satisfies` / `as` / parenthesized wrappers down to the
// underlying expression.
func skipWrappers(expr *shimast.Node) *shimast.Node {
	for expr != nil {
		switch expr.Kind {
		case shimast.KindSatisfiesExpression:
			expr = expr.AsSatisfiesExpression().Expression
		case shimast.KindAsExpression:
			expr = expr.AsAsExpression().Expression
		case shimast.KindParenthesizedExpression:
			expr = expr.AsParenthesizedExpression().Expression
		default:
			return expr
		}
	}
	return nil
}

// functionParameters returns a function-like declaration's parameter nodes,
// or nil for anything else.
func functionParameters(fn *shimast.Node) []*shimast.Node {
	switch fn.Kind {
	case shimast.KindMethodDeclaration, shimast.KindFunctionExpression, shimast.KindArrowFunction, shimast.KindFunctionDeclaration:
		return fn.Parameters()
	}
	return nil
}

// typeParameterNames collects a member's own generic parameter names — any
// reference to one makes a parameter type un-derivable (no closed type exists
// to validate against at build time).
func typeParameterNames(fn *shimast.Node) map[string]bool {
	names := map[string]bool{}
	switch fn.Kind {
	case shimast.KindMethodDeclaration, shimast.KindFunctionExpression, shimast.KindArrowFunction, shimast.KindFunctionDeclaration:
		for _, parameter := range fn.TypeParameters() {
			if name := parameter.Name(); name != nil && name.Kind == shimast.KindIdentifier {
				names[name.Text()] = true
			}
		}
	}
	return names
}

// referencesTypeParameter reports whether a type node mentions any of the
// member's own type parameters (a syntactic walk; shadowing inside nested
// function types is not modeled — a false positive only widens the degrade).
func referencesTypeParameter(typeNode *shimast.Node, names map[string]bool) bool {
	if len(names) == 0 {
		return false
	}
	found := false
	var walk func(node *shimast.Node) bool
	walk = func(node *shimast.Node) bool {
		if node == nil || found {
			return true
		}
		if node.Kind == shimast.KindTypeReference {
			ref := node.AsTypeReferenceNode().TypeName
			if ref != nil && ref.Kind == shimast.KindIdentifier && names[ref.Text()] {
				found = true
				return true
			}
		}
		node.ForEachChild(walk)
		return false
	}
	walk(typeNode)
	return found
}

// compilerOptions mirrors typia's own nil-guarded read of the loaded
// program's compiler options.
func compilerOptions(prog *driver.Program) *shimcore.CompilerOptions {
	if prog == nil || prog.ParsedConfig == nil || prog.ParsedConfig.ParsedConfig == nil {
		return nil
	}
	return prog.ParsedConfig.ParsedConfig.CompilerOptions
}
