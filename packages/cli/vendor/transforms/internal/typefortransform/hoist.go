package typefortransform

import (
	"path/filepath"
	"sort"

	shimast "github.com/microsoft/typescript-go/shim/ast"

	"github.com/fnioc/std/transforms/internal/plugin"
	"github.com/fnioc/std/transforms/internal/tokens"
	"github.com/fnioc/std/transforms/internal/typeforhoist"
	"github.com/fnioc/std/transforms/internal/valueimport"
)

// Hoist is the project state HOISTED emission needs: the shared const table
// every file contributes to, and the source root the generated module sits at,
// so each file can spell its own relative specifier. A nil *Hoist selects INLINE
// emission — the `Type.*` tree written out at the call site. It is shared by
// every primitive that derives a `Type.*` tree, not just typefor's own — a
// consumer passes the SAME *Hoist to each stage's constructor so a type reached
// through more than one primitive interns to one const.
type Hoist struct {
	// Registry is the one table for the whole project. Its entries outlive any
	// single file, which is what lets two files share a const.
	Registry *typeforhoist.Registry
	// SourceRoot is the absolute directory the emitted tree is rooted at. The
	// generated module is its direct child, so the specifier a file spells is the
	// same in source space and in emit space.
	SourceRoot string
}

// hoistCollisionCode is the diagnostic raised when two distinct types would name
// the same const. It is an engine bug — the naming scheme is meant to make it
// unreachable — and it fails the build rather than merging the two.
const hoistCollisionCode = "TYPEFOR_HOIST_NAME_COLLISION"

// hoistEmitter replaces each derived tree with a reference to one const, interns
// the tree in the project table, and remembers which consts this file reached so
// the import can be materialized once at the end of the file.
type hoistEmitter struct {
	factory  *shimast.NodeFactory
	registry *typeforhoist.Registry
	// specifier is the module specifier THIS file reaches the generated module by.
	specifier string
	// bindings is one binding per const name referenced in this file, keyed by
	// name so a repeated reference reuses it.
	bindings map[string]*valueimport.Binding
	// sourceFile is what a binding resolves against, honoring an import a previous
	// pass of the fixed-point loop already injected.
	sourceFile *shimast.SourceFile
	emit       func(plugin.Diagnostic)
}

func newHoistEmitter(
	factory *shimast.NodeFactory,
	hoist *Hoist,
	sourceFile *shimast.SourceFile,
	emit func(plugin.Diagnostic),
) *hoistEmitter {
	return &hoistEmitter{
		factory:    factory,
		registry:   hoist.Registry,
		specifier:  moduleSpecifier(hoist.SourceRoot, sourceFile.FileName()),
		bindings:   map[string]*valueimport.Binding{},
		sourceFile: sourceFile,
		emit:       emit,
	}
}

// hoistFromNode mirrors a derived tree onto the const table's own node form,
// whose canonical key is the identity two call sites share a const by. It is the
// structural twin of typeemit.EmitNode over the same tree, so a const holds
// exactly what an inline emission would have spelled. A composite's members
// become CHILD nodes rather than part of the parent's spelling, so each earns its
// own const and is referenced by name.
func hoistFromNode(n *tokens.Node) *typeforhoist.Node {
	switch n.Kind {
	case tokens.KindFunc:
		return typeforhoist.Func(hoistFromNode(n.Ret), hoistFromNode(n.Sig))
	case tokens.KindCtor:
		return typeforhoist.Ctor(hoistFromNode(n.Ret), hoistFromNode(n.Sig))
	case tokens.KindAbstractCtor:
		return typeforhoist.AbstractCtor(hoistFromNode(n.Ret), hoistFromNode(n.Sig))
	case tokens.KindTag:
		return typeforhoist.Tag(hoistFromNode(n.Inner), n.Tag)
	case tokens.KindUnion:
		return typeforhoist.Union(hoistNodes(n.Members))
	case tokens.KindIntersection:
		return typeforhoist.Intersection(hoistNodes(n.Members))
	case tokens.KindTuple:
		var rest *typeforhoist.Node
		if n.TupleRest != nil {
			rest = hoistFromNode(n.TupleRest)
		}
		return typeforhoist.Tuple(hoistNodes(n.Members), rest)
	case tokens.KindObject:
		members := make([]typeforhoist.ObjectMember, 0, len(n.Properties))
		for _, property := range n.Properties {
			members = append(members, typeforhoist.ObjectMember{Key: property.Key, Type: hoistFromNode(property.Type)})
		}
		return typeforhoist.Object(members)
	case tokens.KindGeneric:
		return typeforhoist.Generic(n.Label)
	case tokens.KindLiteral:
		switch n.Literal.Kind {
		case tokens.LiteralUndefined:
			return typeforhoist.Undefined()
		case tokens.LiteralNull:
			return typeforhoist.Null()
		default:
			return typeforhoist.Literal(tokens.LiteralText(n.Literal))
		}
	default: // tokens.KindNamed
		args := make([]*typeforhoist.Node, 0, len(n.Args))
		for _, a := range n.Args {
			args = append(args, hoistFromNode(a))
		}
		return typeforhoist.Named(n.Name, n.From, args)
	}
}

func hoistNodes(ns []*tokens.Node) []*typeforhoist.Node {
	out := make([]*typeforhoist.Node, 0, len(ns))
	for _, n := range ns {
		out = append(out, hoistFromNode(n))
	}
	return out
}

// node interns the derived tree and returns the identifier the const is
// referenced by, or nil when naming failed (reported as a hard diagnostic).
func (e *hoistEmitter) node(n *tokens.Node) *shimast.Node {
	name, err := e.registry.Ref(hoistFromNode(n))
	if err != nil {
		e.emit(plugin.Diagnostic{
			Code:    hoistCollisionCode,
			File:    filepath.ToSlash(e.sourceFile.FileName()),
			Message: err.Error(),
		})
		return nil
	}
	binding, ok := e.bindings[name]
	if !ok {
		binding = valueimport.Resolve(e.sourceFile, valueimport.Ref{Module: e.specifier, Export: name})
		e.bindings[name] = binding
	}
	binding.Used = true
	return binding.Expr(e.factory)
}

// imports are the file's bindings in a stable order — sorted by const name, so
// the injected import reads the same however the file happened to be visited.
func (e *hoistEmitter) imports() []*valueimport.Binding {
	names := make([]string, 0, len(e.bindings))
	for name := range e.bindings {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]*valueimport.Binding, 0, len(names))
	for _, name := range names {
		out = append(out, e.bindings[name])
	}
	return out
}

// HoistEmitter is hoistEmitter under the name a sibling package names it by — a
// per-file handle on the project's shared const table. Build one with
// NewHoistEmitter.
type HoistEmitter = hoistEmitter

// NewHoistEmitter builds a per-file handle on hoist's shared const table: every
// Node call this file makes interns into the SAME registry a typefor stage
// sharing the same *Hoist also references, so a type either primitive derives
// spells through one const.
func NewHoistEmitter(
	factory *shimast.NodeFactory,
	hoist *Hoist,
	sourceFile *shimast.SourceFile,
	emit func(plugin.Diagnostic),
) *HoistEmitter {
	return newHoistEmitter(factory, hoist, sourceFile, emit)
}

// Node interns n in the shared const table and returns the reference to its
// const, or nil when naming failed (reported through emit) — the entry point a
// sibling primitive's own leaf emission shares with typefor's.
func (e *hoistEmitter) Node(n *tokens.Node) *shimast.Node {
	return e.node(n)
}

// Imports are the file's hoisted-const bindings, in a stable order — what a
// caller passes to valueimport.Ensure once the file settles.
func (e *hoistEmitter) Imports() []*valueimport.Binding {
	return e.imports()
}

// moduleSpecifier is the relative specifier a file in sourceRoot's tree reaches
// the generated module by. A file directly in the root spells `./`; a nested one
// climbs back out.
func moduleSpecifier(sourceRoot, file string) string {
	rel, err := filepath.Rel(filepath.Dir(file), sourceRoot)
	if err != nil {
		return "./" + typeforhoist.ModuleFile
	}
	rel = filepath.ToSlash(rel)
	if rel == "." {
		return "./" + typeforhoist.ModuleFile
	}
	return rel + "/" + typeforhoist.ModuleFile
}
