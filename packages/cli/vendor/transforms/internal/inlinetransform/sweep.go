package inlinetransform

import (
	"fmt"

	shimast "github.com/microsoft/typescript-go/shim/ast"

	"github.com/fnioc/std/transforms/internal/plugin"
)

// schemaofPrimitive is the type-expansion primitive whose OWN stage reports its
// failures (the targeted 992001/992002/992003) and leaves the call un-expanded. A
// surviving `schemaof<T>()` is therefore already accompanied by that precise
// diagnostic, so the sweep defers to it rather than adding the generic "primitive
// survived" error on top.
const schemaofPrimitive = "schemaof"

// Sweep is emit tripwire 2: a syntactic walk of a fully-lowered output file that
// hard-errors on any surviving primitive or listed-sugar call. It runs after all
// selected stages, whenever the inline stage had a marker surface in the program.
//
// It anchors on the MARKER, exactly as matching does: the member table it tests
// against is every marker member whose surface this program carries, not the
// subset that resolved to something inlineable. A member whose sugar declarations
// are missing is the case that most needs the report — nothing could lower, so
// every call to it is residue — and keying the table off what resolved is what
// made that case silent.
//
// Known accepted residual (documented): a first-party stranger generic member
// named exactly like a listed sugar member with the same call shape would
// false-positive here — implausible in this workspace, loud, and diagnosable.
func Sweep(sf *shimast.SourceFile, artifacts *Artifacts) []plugin.Diagnostic {
	if artifacts == nil || !artifacts.Active {
		return nil
	}
	var diags []plugin.Diagnostic
	imports := importedNames(sf)

	walk(sf.AsNode(), func(n *shimast.Node) bool {
		if n.Kind != shimast.KindCallExpression {
			return false
		}
		call := n.AsCallExpression()

		// (1) surviving primitive: a node still carrying a registered PrimitiveUse.
		if use, registered := artifacts.PrimitiveCalls[n]; registered {
			// A surviving `schemaof<T>()` is a type the Type grammar cannot spell; its
			// own stage already reported the targeted 992001/992002/992003 and left the
			// call in place. Defer to that — don't add the generic "primitive survived"
			// error on top.
			if use.Name == schemaofPrimitive {
				return false
			}
			diags = append(diags, sweepDiag("INLINE_UNLOWERED_PRIMITIVE", n,
				"a registered primitive call survived lowering"))
			return false
		}
		if call.Expression.Kind == shimast.KindIdentifier && call.TypeArguments != nil &&
			len(call.TypeArguments.Nodes) >= 1 {
			if _, isPrimitive := knownPrimitives[call.Expression.Text()]; isPrimitive {
				diags = append(diags, sweepDiag("INLINE_UNLOWERED_PRIMITIVE", n,
					fmt.Sprintf("primitive %q with a type argument survived lowering", call.Expression.Text())))
				return false
			}
		}

		typeArgs, valueArgs := callArity(call)

		// (2) surviving member sugar: a property-access call whose name is a
		// certified member and whose (type-arg, value-arg) counts are consistent
		// with the sugar's shape.
		if call.Expression.Kind == shimast.KindPropertyAccessExpression {
			name := call.Expression.AsPropertyAccessExpression().Name().Text()
			if anySugarShapeMatches(artifacts.SugarMembers[name], typeArgs, valueArgs) {
				diags = append(diags, sweepDiag("INLINE_UNLOWERED_SUGAR", n,
					fmt.Sprintf("member sugar %q survived lowering", name)))
			}
			return false
		}

		// (3) surviving free-function sugar: an identifier call to a certified
		// function while the file still imports that name FROM THE DECLARING PACKAGE.
		// The module is what identifies the sugar — a same-named function imported
		// from anywhere else is a different function, and a call importing the name
		// from the entry's declared forwarding target (`from`) is the runtime
		// target itself, never sugar residue.
		if call.Expression.Kind == shimast.KindIdentifier {
			name := call.Expression.Text()
			pkg := imports[name]
			for _, fn := range artifacts.FunctionSugars {
				if fn.Member == name && pkg == fn.Module {
					diags = append(diags, sweepDiag("INLINE_UNLOWERED_SUGAR", n,
						fmt.Sprintf("free-function sugar %q survived lowering", name)))
					break
				}
			}
		}
		return false
	})
	return diags
}

// sugarShapeMatches reports whether a call's (type-arg, value-arg) counts are
// consistent with a certified member-sugar shape. Type-argument count is an
// EXACT match: it is what separates a surviving sugar call from the stage's own
// substitution output. A substituted body's call (`this.addClass(typefor<T>(),
// ctor, ...)`) carries ZERO type arguments — the explicit one was consumed
// turning `typefor<T>()` into a token argument — so lowered output is
// syntactically identical to an ordinary token-taking call at that arity, and
// the sweep must not mistake it for residue. (A sugar call that omits its own
// explicit type argument and relies on inference is, for the same reason,
// indistinguishable from lowered output here and is a deliberate blind spot —
// the sweep only catches an unlowered call that still spells its type argument.)
//
// Value-arity is a span rather than a count, because a call may stop short of
// the implementation's optional tail; a rest-bodied shape has no upper bound.
func sugarShapeMatches(shape MemberShape, typeArgs, valueArgs int) bool {
	if typeArgs != shape.TypeArgCount || valueArgs < shape.MinValueArgCount {
		return false
	}
	return shape.Unbounded || valueArgs <= shape.MaxValueArgCount
}

// anySugarShapeMatches reports whether a call's arity fits any of a member's
// declared shapes. A member several entries contribute to answers to each of
// their arities, so residue in any one of them is still residue.
func anySugarShapeMatches(shapes []MemberShape, typeArgs, valueArgs int) bool {
	for _, shape := range shapes {
		if sugarShapeMatches(shape, typeArgs, valueArgs) {
			return true
		}
	}
	return false
}

// callArity returns a call's type-argument and value-argument counts.
func callArity(call *shimast.CallExpression) (int, int) {
	typeArgs := 0
	if call.TypeArguments != nil {
		typeArgs = len(call.TypeArguments.Nodes)
	}
	valueArgs := 0
	if call.Arguments != nil {
		valueArgs = len(call.Arguments.Nodes)
	}
	return typeArgs, valueArgs
}

// importedNames maps each local name a file's top-level imports still bind to the
// module specifier it was bound from, so a name can be matched against the package
// that declares it rather than on spelling alone.
func importedNames(sf *shimast.SourceFile) map[string]string {
	out := map[string]string{}
	for _, stmt := range sf.Statements.Nodes {
		if stmt.Kind != shimast.KindImportDeclaration {
			continue
		}
		decl := stmt.AsImportDeclaration()
		spec := decl.ModuleSpecifier
		if spec == nil || spec.Kind != shimast.KindStringLiteral {
			continue
		}
		clause := decl.ImportClause
		if clause == nil {
			continue
		}
		bindings := clause.AsImportClause().NamedBindings
		if bindings == nil || bindings.Kind != shimast.KindNamedImports {
			continue
		}
		for _, el := range bindings.AsNamedImports().Elements.Nodes {
			out[el.Name().Text()] = spec.Text()
		}
	}
	return out
}

func sweepDiag(code string, node *shimast.Node, msg string) plugin.Diagnostic {
	return plugin.Diagnostic{
		Code:    code,
		File:    nodeFile(node),
		Start:   node.Pos(),
		Message: fmt.Sprintf("%s at %s", msg, nodePosition(node)),
	}
}
