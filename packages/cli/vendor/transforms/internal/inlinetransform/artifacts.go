package inlinetransform

import (
	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
)

// PrimitiveUse records a primitive call the inline stage minted by substitution:
// a side-parsed callee (e.g. `typefor<T>()`) whose type arguments were bound to
// checker-valid types captured at the ORIGINAL call site. A downstream primitive
// stage reads these to lower a synthetic call it could never anchor on its own
// (the callee clone has no symbol).
//
// TypeArgs carries a TYPE-argument primitive's bound arguments (typefor<T>()).
// ValueArg carries a VALUE-argument primitive's argument (typefor(ctor)) as the
// PARSE node behind it, so the consuming stage can checker-query it even though
// the primitive's own callee is synthetic.
//
// IT IS A PARSE NODE, NOT THE SPLICED ONE, AND THAT IS LOAD-BEARING. Substitution
// happens on whatever pass the visitor first reaches the sugar call, which is not
// always pass 0, so the argument spliced into the body may be one earlier passes
// already rewrote. Handing that to the checker walks it into the minted,
// symbol-less literals those passes produced and nil-derefs it
// (plugin.CheckerAnchor). fileState.anchorValueArg resolves the parse node at
// record time and records nil when there is none; every consumer treats nil as
// "not a registered value argument".
type PrimitiveUse struct {
	Name     string
	TypeArgs []*shimchecker.Type
	ValueArg *shimast.Node
}

// MemberShape is a certified member-sugar call shape the sweep matches a
// surviving call against: the type arguments exactly, and a value-argument
// count anywhere from the required parameters up to the whole list — the span
// between the two is the optional tail a call may stop short of. Unbounded
// marks a rest-bodied shape, whose accepted argument count has no upper bound.
type MemberShape struct {
	TypeArgCount     int
	MinValueArgCount int
	MaxValueArgCount int
	Unbounded        bool
}

// Artifacts is the per-run state the inline stage hands to downstream stages and
// the emit sweep. One instance lives per build (the sidecar is one-shot).
type Artifacts struct {
	// PrimitiveCalls maps a substituted primitive call node to its resolved use.
	PrimitiveCalls map[*shimast.Node]PrimitiveUse
	// SugarMembers maps a certified member name to every sugar call shape declared
	// for it, for the emit sweep's member-sugar residue check. It is keyed off the
	// MARKER, not off what resolved: a member whose sugar declarations turned out
	// to be absent still publishes its shape, so a call written in that shape is
	// reported rather than passed through. One name carries several shapes when
	// several entries contribute to it, each with its own arity — a call matching
	// ANY of them is residue.
	SugarMembers map[string][]MemberShape
	// FunctionSugars holds every certified, active free-function entry resolved
	// against this program, for the emit sweep's free-function residue check —
	// the entry's own resolution (Module/Member) IS the check's data, so no
	// separate name-keyed registry is built alongside it.
	FunctionSugars []*Resolved
	// Active is set once the inline stage is selected AND at least one entry's
	// surface is present in this program — whether or not anything inlined. The
	// emit sweep keys off it.
	Active bool
}

// NewArtifacts builds an empty, inactive Artifacts.
func NewArtifacts() *Artifacts {
	return &Artifacts{
		PrimitiveCalls: map[*shimast.Node]PrimitiveUse{},
		SugarMembers:   map[string][]MemberShape{},
	}
}
