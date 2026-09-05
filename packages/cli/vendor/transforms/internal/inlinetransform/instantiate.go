package inlinetransform

import (
	_ "unsafe"

	shimchecker "github.com/microsoft/typescript-go/shim/checker"
)

// Substituting an impl's type parameter INSIDE a composed type argument
// (`typefor<Func<Args, ServiceType>>()`) means instantiating the written type
// with the call site's types — the same operation the checker performs for a
// hand-written `Func<[IBar], IGadget>`, and the reason the two land on the very
// same interned type. The ttsc shim exposes no instantiation entry point, so the
// checker's own is reached by linkname, the way tokens/alias.go reaches the
// unexported alias field.
//
// typeMapper and typeAlias stand in for checker.TypeMapper and checker.TypeAlias,
// whose names are unexported: both cross the boundary as opaque pointers this
// package only ever forwards, never dereferences.
type typeMapper struct{}

type typeAlias struct{}

//go:linkname checkerNewTypeMapper github.com/microsoft/typescript-go/internal/checker.newTypeMapper
func checkerNewTypeMapper(sources []*shimchecker.Type, targets []*shimchecker.Type) *typeMapper

//go:linkname checkerInstantiateTypeWithAlias github.com/microsoft/typescript-go/internal/checker.(*Checker).instantiateTypeWithAlias
func checkerInstantiateTypeWithAlias(recv *shimchecker.Checker, t *shimchecker.Type, m *typeMapper, alias *typeAlias) *shimchecker.Type

// instantiateType substitutes targets for sources throughout t. The pairing is
// positional, and a nil result (or an unchanged t, which means the mapper reached
// nothing) reports failure, so a caller falls back rather than deriving a token
// from a type still carrying type parameters.
func instantiateType(checker *shimchecker.Checker, t *shimchecker.Type, sources, targets []*shimchecker.Type) (*shimchecker.Type, bool) {
	if checker == nil || t == nil || len(sources) == 0 || len(sources) != len(targets) {
		return nil, false
	}
	for i := range sources {
		if sources[i] == nil || targets[i] == nil {
			return nil, false
		}
	}
	instantiated := checkerInstantiateTypeWithAlias(checker, t, checkerNewTypeMapper(sources, targets), nil)
	if instantiated == nil || instantiated == t {
		return nil, false
	}
	return instantiated, true
}
