package inlinetransform

import (
	"fmt"
	"path/filepath"

	shimast "github.com/microsoft/typescript-go/shim/ast"
)

// discoverMarkerEntries scans a package's reachable source files for
// `registerInlineBodies` marker calls and synthesizes one Entry per exported
// member of each referenced body set — the same Entry values the JSON publish
// list yields, so everything downstream is untouched. The walk is the impl
// BFS: the "." export's src entry, then every intra-package re-export target.
//
// From each marker call:
//
//   - type: the sole type argument, stripped of its own type arguments and
//     resolved through the file's imports to a "<package>:<Name>" ref. A type
//     argument that is not an imported name is a hard error, never a silent
//     skip.
//   - impl: the owning package's name plus the set identifier.
//   - member: each exported function of the referenced `export namespace`, or
//     each property of the referenced object-literal `const`.
func discoverMarkerEntries(b *bodyExtractor, packageDir string) ([]Entry, error) {
	entryFile, err := resolveEntryFile(packageDir)
	if err != nil {
		// A package with no src entry publishes nothing by marker; the JSON
		// list (whose loader raises its own errors) remains its only channel.
		return nil, nil
	}
	ownPkg := packageName(packageDir)

	var out []Entry
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
		fileEntries, ferr := markerEntriesInFile(sf, file, ownPkg)
		if ferr != nil {
			return nil, ferr
		}
		out = append(out, fileEntries...)
		for _, target := range reExportTargets(sf) {
			resolved := resolveRelativeModule(filepath.Dir(file), target)
			if resolved != "" && !seen[resolved] {
				queue = append(queue, resolved)
			}
		}
	}
	return out, nil
}

// markerEntriesInFile synthesizes the entries for every top-level marker call
// in one side-parsed file.
func markerEntriesInFile(sf *shimast.SourceFile, file, ownPkg string) ([]Entry, error) {
	markerLocals := markerImports(sf, ownPkg)
	if len(markerLocals) == 0 {
		return nil, nil
	}
	typeImports := importedTypeNames(sf, ownPkg)

	var out []Entry
	for _, stmt := range sf.Statements.Nodes {
		if stmt.Kind != shimast.KindExpressionStatement {
			continue
		}
		expr := stmt.AsExpressionStatement().Expression
		if expr == nil || expr.Kind != shimast.KindCallExpression {
			continue
		}
		call := expr.AsCallExpression()
		if call.Expression.Kind != shimast.KindIdentifier || !markerLocals[call.Expression.Text()] {
			continue
		}

		receiverRef, rerr := markerReceiverRef(call, typeImports, file)
		if rerr != nil {
			return nil, rerr
		}
		setName, serr := markerSetName(call, file)
		if serr != nil {
			return nil, serr
		}
		members, merr := setMemberNames(sf, setName, file)
		if merr != nil {
			return nil, merr
		}
		for _, member := range members {
			out = append(out, Entry{
				Type:   receiverRef,
				Impl:   ownPkg + ":" + setName,
				Member: member,
			})
		}
	}
	return out, nil
}

// markerImports returns the local names sf binds to the `registerInlineBodies`
// marker: a named import from the marker's home module, or — when the home IS
// the declaring package — from a package-relative specifier.
func markerImports(sf *shimast.SourceFile, declaringPkg string) map[string]bool {
	out := map[string]bool{}
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
			home, known := knownAuthoringMarkers[exported]
			if !known {
				continue
			}
			fromHome := module == home
			fromOwnPackage := isRelativeSpecifier(module) && home == declaringPkg
			if fromHome || fromOwnPackage {
				out[el.Name().Text()] = true
			}
		}
	}
	return out
}

// importedTypeNames maps each locally-bound imported name (type-only imports
// included) to the "<package>:<Name>" reference it stands for. A relative
// specifier resolves to the declaring package's own name — the shape a package
// takes declaring sugar on a receiver it exports itself.
func importedTypeNames(sf *shimast.SourceFile, declaringPkg string) map[string]string {
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
		module := spec.Text()
		if isRelativeSpecifier(module) {
			module = declaringPkg
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
			out[el.Name().Text()] = module + ":" + importSpecifierExportedName(el)
		}
	}
	return out
}

// markerReceiverRef reads the marker call's sole type argument — the receiver
// the set's members are declared on — stripped of its own type arguments
// (`registerInlineBodies<Manifest<any>>` yields `Manifest`) and resolved
// through the file's imports.
func markerReceiverRef(call *shimast.CallExpression, typeImports map[string]string, file string) (string, error) {
	if call.TypeArguments == nil || len(call.TypeArguments.Nodes) != 1 {
		return "", fmt.Errorf("INLINE_MARKER_TYPE: %s: registerInlineBodies takes exactly one type argument naming the receiver", file)
	}
	ta := call.TypeArguments.Nodes[0]
	if ta.Kind != shimast.KindTypeReference {
		return "", fmt.Errorf("INLINE_MARKER_TYPE: %s: registerInlineBodies' type argument must be a named type reference", file)
	}
	name := ta.AsTypeReferenceNode().TypeName
	if name == nil || name.Kind != shimast.KindIdentifier {
		return "", fmt.Errorf("INLINE_MARKER_TYPE: %s: registerInlineBodies' type argument must be a bare imported name", file)
	}
	ref, ok := typeImports[name.Text()]
	if !ok {
		return "", fmt.Errorf("INLINE_MARKER_TYPE: %s: registerInlineBodies' type argument %q is not an imported name", file, name.Text())
	}
	return ref, nil
}

// markerSetName reads the marker call's sole argument — the identifier of the
// body set published beside it.
func markerSetName(call *shimast.CallExpression, file string) (string, error) {
	if call.Arguments == nil || len(call.Arguments.Nodes) != 1 {
		return "", fmt.Errorf("INLINE_MARKER_SET: %s: registerInlineBodies takes exactly one argument naming the body set", file)
	}
	arg := call.Arguments.Nodes[0]
	if arg.Kind != shimast.KindIdentifier {
		return "", fmt.Errorf("INLINE_MARKER_SET: %s: registerInlineBodies' argument must be the body set's identifier", file)
	}
	return arg.Text(), nil
}

// setMemberNames returns the member names of the body set named setName in sf:
// each exported function of an `export namespace`, or each property of an
// object-literal `const`. Overload signatures and their implementation share a
// name and yield one member.
func setMemberNames(sf *shimast.SourceFile, setName, file string) ([]string, error) {
	set := findTopLevelDeclaration(sf, setName)
	if set == nil {
		return nil, fmt.Errorf("INLINE_MARKER_SET: %s: registerInlineBodies references %q, which resolves to nothing in this file", file, setName)
	}
	var out []string
	seen := map[string]bool{}
	add := func(name string) {
		if name != "" && !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	switch set.Kind {
	case shimast.KindModuleDeclaration:
		body := set.AsModuleDeclaration().Body
		if body == nil || body.Kind != shimast.KindModuleBlock {
			break
		}
		for _, stmt := range body.AsModuleBlock().Statements.Nodes {
			if stmt.Kind != shimast.KindFunctionDeclaration || !hasExportModifier(stmt) {
				continue
			}
			if name := stmt.Name(); name != nil {
				add(name.Text())
			}
		}
	case shimast.KindVariableDeclaration:
		init := set.AsVariableDeclaration().Initializer
		init = unwrapExpression(init)
		if init == nil || init.Kind != shimast.KindObjectLiteralExpression {
			break
		}
		for _, prop := range init.AsObjectLiteralExpression().Properties.Nodes {
			switch prop.Kind {
			case shimast.KindPropertyAssignment, shimast.KindMethodDeclaration, shimast.KindShorthandPropertyAssignment:
				if name := prop.Name(); name != nil {
					add(name.Text())
				}
			}
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("INLINE_MARKER_SET: %s: body set %q declares no members", file, setName)
	}
	return out, nil
}

// hasExportModifier reports whether a declaration carries the `export` keyword.
func hasExportModifier(node *shimast.Node) bool {
	mods := node.Modifiers()
	if mods == nil {
		return false
	}
	for _, m := range mods.Nodes {
		if m.Kind == shimast.KindExportKeyword {
			return true
		}
	}
	return false
}

// unwrapExpression strips `as`/`satisfies` and parenthesized wrappers off an
// expression, returning the node they annotate.
func unwrapExpression(node *shimast.Node) *shimast.Node {
	for node != nil {
		switch node.Kind {
		case shimast.KindAsExpression:
			node = node.AsAsExpression().Expression
		case shimast.KindSatisfiesExpression:
			node = node.AsSatisfiesExpression().Expression
		case shimast.KindParenthesizedExpression:
			node = node.AsParenthesizedExpression().Expression
		default:
			return node
		}
	}
	return node
}
