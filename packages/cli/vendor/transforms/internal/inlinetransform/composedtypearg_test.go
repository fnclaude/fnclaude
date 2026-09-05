package inlinetransform

import (
	"path/filepath"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

// composedSrc holds two bodies whose primitive call spells a type argument that
// is not itself a type parameter but composes two: a generic instantiation and a
// tuple. The probes below spell the same two types with the arguments the env
// binds, so an instantiation can be compared against what the checker resolves
// for the hand-written spelling.
const composedSrc = `
type Func<A extends unknown[], R> = (...a: A) => R;
interface IBar {}
interface IGadget {}
declare function typefor<T>(): T;
declare function call(address: unknown, ...rest: unknown[]): any;

export const Impl = {
  composed<ServiceType, Args extends unknown[]>(...args: Args): ServiceType {
    return call(typefor<Func<Args, ServiceType>>(), ...args);
  },
  tupled<ServiceType, Args extends unknown[]>(...args: Args): ServiceType {
    return call(typefor<[Args, ServiceType]>(), ...args);
  },
};

declare const probeFunc: Func<[IBar], IGadget>;
declare const probeTuple: [[IBar], IGadget];
`

func TestComposedTypeArgSubstitutesNestedTypeParameters(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "tsconfig.json"), `{
  "compilerOptions": {
    "target": "ES2022", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true
  },
  "files": ["impl.ts"]
}`)
	implPath := filepath.Join(root, "impl.ts")
	write(t, implPath, composedSrc)

	prog, diags, err := driver.LoadProgram(root, "tsconfig.json", driver.LoadProgramOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(diags) != 0 {
		t.Fatalf("unexpected config diagnostics: %v", diags)
	}
	checker := prog.Checker
	st := &fileState{checker: checker, implFiles: programFilesByPath(prog)}

	program := st.implFiles[filepath.ToSlash(filepath.Clean(implPath))]
	if program == nil {
		t.Fatal("the program has no copy of the impl file")
	}
	// `Args` binds to the tuple `[IBar]` and `ServiceType` to `IGadget`, read off
	// the probe spelling both.
	probe := declaredTypeNode(program.AsNode(), "probeFunc")
	if probe == nil {
		t.Fatal("probeFunc's type node not found")
	}
	probeArgs := probe.AsTypeReferenceNode().TypeArguments.Nodes
	env := map[string]*shimchecker.Type{
		"Args":        checker.GetTypeFromTypeNode(probeArgs[0]),
		"ServiceType": checker.GetTypeFromTypeNode(probeArgs[1]),
	}

	sideParsed := parse(t, implPath, composedSrc)
	for _, tc := range []struct {
		member string
		want   *shimast.Node
	}{
		{member: "composed", want: probe},
		{member: "tupled", want: declaredTypeNode(program.AsNode(), "probeTuple")},
	} {
		t.Run(tc.member, func(t *testing.T) {
			body := SingleReturnExpression(FindMemberBody(sideParsed, "Impl", tc.member))
			if body == nil {
				t.Fatalf("no single-return body for %s", tc.member)
			}
			rb := &ResolvedBody{
				Body:             body,
				TypeParams:       []string{"ServiceType", "Args"},
				PrimitiveImports: map[string]string{"typefor": "typefor"},
				File:             implPath,
			}
			composed := st.composedTypeArgs(rb, env)
			written := primitiveTypeArgument(body)
			if written == nil {
				t.Fatal("the body's primitive call has no type argument")
			}
			got := composed[typeArgShape(written)]
			if got == nil {
				t.Fatalf("no substitution recorded for %s", typeArgShape(written))
			}
			if want := checker.GetTypeFromTypeNode(tc.want); got != want {
				t.Fatalf("substituted type %p is not the hand-written spelling %p", got, want)
			}
		})
	}
}

func TestTypeParamsInReachesNestedReferences(t *testing.T) {
	sf := parse(t, "/nested.ts", `
declare function typefor<T>(): T;
declare function open<ServiceType, Args extends unknown[]>(): void;
const a = typefor<ServiceType>();
const b = typefor<Func<Args, ServiceType>>();
const c = typefor<[Args, Promise<ServiceType>]>();
const d = typefor<Other>();
`)
	declared := map[string]bool{"ServiceType": true, "Args": true}
	var got [][]string
	walk(sf.AsNode(), func(n *shimast.Node) bool {
		if n.Kind != shimast.KindCallExpression {
			return false
		}
		typeArgs := n.AsCallExpression().TypeArguments
		if typeArgs == nil || len(typeArgs.Nodes) != 1 {
			return false
		}
		got = append(got, typeParamsIn(typeArgs.Nodes[0], declared))
		return false
	})
	want := [][]string{
		{"ServiceType"},
		{"Args", "ServiceType"},
		{"Args", "ServiceType"},
		nil,
	}
	if len(got) != len(want) {
		t.Fatalf("walked %d type arguments, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if len(got[i]) != len(want[i]) {
			t.Fatalf("type argument %d: got %v want %v", i, got[i], want[i])
		}
		for j := range want[i] {
			if got[i][j] != want[i][j] {
				t.Fatalf("type argument %d: got %v want %v", i, got[i], want[i])
			}
		}
	}
}

// declaredTypeNode returns the type node annotating the variable named name.
func declaredTypeNode(root *shimast.Node, name string) *shimast.Node {
	var found *shimast.Node
	walk(root, func(n *shimast.Node) bool {
		if found != nil || n.Kind != shimast.KindVariableDeclaration {
			return false
		}
		decl := n.AsVariableDeclaration()
		if decl.Name() != nil && decl.Name().Text() == name {
			found = decl.Type
			return true
		}
		return false
	})
	return found
}

// primitiveTypeArgument returns the sole type argument of the body's primitive call.
func primitiveTypeArgument(body *shimast.Node) *shimast.Node {
	var found *shimast.Node
	walk(body, func(n *shimast.Node) bool {
		if found != nil || n.Kind != shimast.KindCallExpression {
			return false
		}
		call := n.AsCallExpression()
		if call.Expression.Kind != shimast.KindIdentifier || call.Expression.Text() != "typefor" {
			return false
		}
		if call.TypeArguments != nil && len(call.TypeArguments.Nodes) == 1 {
			found = call.TypeArguments.Nodes[0]
			return true
		}
		return false
	})
	return found
}
