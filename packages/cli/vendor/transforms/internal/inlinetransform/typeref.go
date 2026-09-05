package inlinetransform

import (
	"fmt"
	"strings"

	"github.com/fnioc/std/transforms/internal/tokentext"
)

// TypeRef is a marker reference deserialized through the SAME grammar the rest
// of the engine spells types in — a Go mirror of the TS Type model's ImportedType
// shape (Type.imported(name, from, genericArgs)), a type IDENTIFIER, never a
// signature-shaped Type (FunctionType, ConstructorType, …). A marker entry's
// `type` or `impl` string always deserializes into exactly this: a name, the
// module it comes from, and any generic type arguments — reusing
// tokentext.ParseToken for the "<...>" layer, so there is one grammar for a
// closed-generic token everywhere in this engine, not a second parser for the
// marker.
type TypeRef struct {
	// Name is the exported identifier — a type name for a `type` reference, an
	// export name for an `impl` reference.
	Name string
	// From is the bare package specifier the reference is exported from.
	From string
	// TypeArgs are the reference's top-level generic arguments, in order. Empty
	// for the non-generic references every marker entry spells today.
	TypeArgs []TypeRef
}

// ParseTypeRef deserializes a marker "<package>:<Name>" reference (optionally
// generic — "<package>:<Name><Arg1,Arg2>") into a TypeRef. It returns an error
// for anything that is not a well-formed TypeIdentifier reference: an absent
// or malformed package/colon split, an unbalanced generic-argument list, or an
// argument that itself fails to parse. There is no syntax in this grammar for
// a signature-shaped Type (a function type, a union, …) — a reference that
// parses at all is always an ImportedType.
func ParseTypeRef(raw string) (TypeRef, error) {
	base := raw
	var typeArgs []TypeRef
	if strings.ContainsRune(raw, '<') {
		parsed, ok := tokentext.ParseToken(raw)
		if !ok {
			return TypeRef{}, fmt.Errorf("malformed reference %q", raw)
		}
		base = parsed.Base
		typeArgs = make([]TypeRef, 0, len(parsed.Args))
		for _, arg := range parsed.Args {
			argRef, err := ParseTypeRef(arg)
			if err != nil {
				return TypeRef{}, err
			}
			typeArgs = append(typeArgs, argRef)
		}
	}
	from, name, ok := splitTypeToken(base)
	if !ok {
		return TypeRef{}, fmt.Errorf("malformed reference %q (want \"<package>:<Name>\")", raw)
	}
	return TypeRef{Name: name, From: from, TypeArgs: typeArgs}, nil
}
