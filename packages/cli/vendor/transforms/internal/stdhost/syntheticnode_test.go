package stdhost

import (
	"strings"
	"testing"
)

// This file pins the repaired defect: the typescript-go checker nil-derefs when it
// is asked to contextually type an object literal a transform pass minted. It was
// pinned here as a LIVE bug when the panic recovery landed; it is now pinned as
// FIXED, with the same fixtures asserting lowered output instead of a crash.
//
// THE MECHANISM. A slot for an OPTIONAL (or defaulted) constructor parameter
// lowers to a `Type.union(...)` node — minted through the emit factory. A
// minted node was never seen by the binder, so it carries no symbol. On the
// NEXT pass of the fixed-point loop a stage asked the checker about the
// enclosing call chain (typefor resolved the callee's symbol, the inline stage
// resolved the callee's signature); resolving that reached the receiver's
// overload resolution, which contextually typed the minted argument, and a
// checker query that assumes every node has a symbol dereferenced the nil one a
// minted node carries:
//
//	symbol := c.getSymbolOfDeclaration(element)          // nil for a minted node
//	return c.getTypeOfPropertyOfContextualTypeEx(t, symbol.Name, …)  // nil deref
//
// So it took BOTH halves: a minted node in the argument list AND a later
// checker query over the chain that contains it.
//
// THE REPAIR (plugin.CheckerAnchor). Every in-loop checker query now resolves its
// node back to the pristine PARSE node first — TypeScript's own `getParseTreeNode`
// discipline — so the checker is never walked into a tree the loop has rewritten,
// and never meets a minted node. The old `Pos() < 0 || Parent == nil` guard could
// not catch this: `ast.updateNode` copies the original's position and flags onto a
// rebuilt node, so a rebuild looks source-written.
//
// WHAT THESE TESTS PROTECT. Both crashing shapes must now lower cleanly AND emit
// exactly the control registration with the trailing chain call appended — a fix
// that merely stopped crashing while lowering less (a matcher that skipped the
// rebuilt chain) would pass a code==0 assertion and fail these.

// syntheticFixturePkg is the consumer manifest for the fixture below — a
// dependency-free root, so CollectProject resolves nothing and the run needs no
// built dist, no inline bodies, and no ttsc spawn. It asks for inline emission
// so each assertion reads the derived tree at the call site it was derived at,
// which is what makes a rebuilt chain's own derivation legible in a failure.
const syntheticFixturePkg = `{"name":"@rhombus-std/synthetic-fixture","version":"0.0.0","private":true,` +
	`"rhombus-std":{"typefor":{"emit":"inline"}}}`

// syntheticDiStub is a local stand-in for the registration surface: the slot
// grammar (a union slot is an object literal), the `typefor(ctor)` primitive
// the stage anchors on by symbol name, and a chain whose members take VALUE
// arguments. Nothing here resolves off disk.
const syntheticDiStub = `export type Token = string;
export interface Union { readonly union: readonly DepSlot[] }
export interface LiteralRef { readonly value: unknown }
export type DepSlot = Token | Union | LiteralRef;
export type DepSignatures = ReadonlyArray<readonly DepSlot[]>;
export type Ctor = new (...args: never[]) => object;
export declare function typefor(value: unknown): DepSignatures;
export interface IChain {
  withSignature(...slots: readonly DepSlot[]): IChain;
  withSignatures(...signatures: ReadonlyArray<readonly DepSlot[]>): IChain;
  as(scope: string): IChain;
  build(): unknown;
}
export interface IManifest {
  addClass(token: Token, ctor: Ctor, signatures: DepSignatures): IChain;
}
export declare const manifest: IManifest;
`

// syntheticPrelude declares the class whose OPTIONAL second constructor
// parameter is what makes the derived signature carry a union slot — and so an
// object literal — at all. With both parameters required the derived signature is
// two bare token strings and there is no object literal to contextually type.
const syntheticPrelude = `import { manifest, typefor } from "./di";

export interface IClock {}
export interface IOptions {}

export class Widget {
  public constructor(clock: IClock, options?: IOptions) {
    void clock;
    void options;
  }
}

`

// syntheticLoweredRegistration is the registration every shape below must lower
// to, byte for byte: the derived token, the constructor, and the Type.ctor(...)
// node whose optional parameter became the minted union node. Asserting the
// full text (not just "it didn't crash") is what keeps a fix that lowers LESS from
// passing — a matcher that skipped a rebuilt chain would leave `typefor(...)`
// standing here.
const syntheticLoweredRegistration = `manifest.addClass("pkg:Widget", Widget, Type.ctor(` +
	`Type.imported("Widget", "@rhombus-std/synthetic-fixture/private/app"), [[` +
	`Type.imported("IClock", "@rhombus-std/synthetic-fixture/private/app"), ` +
	`Type.union(Type.imported("IOptions", "@rhombus-std/synthetic-fixture/private/app"), Type.typeLiteral(undefined))]]))`

// syntheticFixture assembles the two-file fixture around one registration
// statement.
func syntheticFixture(registration string) map[string]string {
	return map[string]string{
		"src/di.ts":  syntheticDiStub,
		"src/app.ts": syntheticPrelude + registration,
	}
}

// lowerSyntheticFixture runs the real host over the fixture and returns the
// lowered app source, failing the test on any diagnostic or non-zero exit.
func lowerSyntheticFixture(t *testing.T, registration string) string {
	t.Helper()
	dir := t.TempDir()
	writeFixture(t, dir, syntheticFixturePkg, syntheticFixture(registration))

	env, stderr, code := driveHost(t, dir, `[]`)
	if code != 0 {
		t.Fatalf("the run must succeed; code = %d\ndiagnostics = %+v\nstderr: %s", code, env.Diagnostics, stderr)
	}
	if got := findDiag(env, stagePanicCode); got != nil {
		t.Fatalf("the checker crashed again: %s", got.MessageText)
	}
	return loweredApp(t, env)
}

// TestChainedRegistrationOverMintedLiteralLowers is the promoted pin. Both shapes
// carry a minted union slot in the argument list AND a trailing chain call whose
// resolution used to drag the checker back into that literal. Each must lower to
// the control registration with its own trailing call appended, and leave nothing
// un-lowered behind.
func TestChainedRegistrationOverMintedLiteralLowers(t *testing.T) {
	cases := map[string]struct{ registration, want string }{
		// The smallest shape there is: one trailing scope call.
		"trailing as": {
			registration: `export const m = manifest.addClass("pkg:Widget", Widget, typefor(Widget)).as("singleton");`,
			want:         syntheticLoweredRegistration + `.as("singleton")`,
		},
		// A trailing single-slot append reaches it the same way.
		"trailing withSignature": {
			registration: `export const m = manifest.addClass("pkg:Widget", Widget, typefor(Widget)).withSignature("pkg:IClock");`,
			want:         syntheticLoweredRegistration + `.withSignature("pkg:IClock")`,
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			lowered := lowerSyntheticFixture(t, tc.registration)
			if !strings.Contains(lowered, tc.want) {
				t.Fatalf("lowered registration mismatch.\nwant to contain:\n%s\ngot:\n%s", tc.want, lowered)
			}
			if strings.Contains(lowered, "typefor(") {
				t.Fatalf("typefor survived lowering:\n%s", lowered)
			}
		})
	}
}

// TestUnchainedRegistrationLowersIdentically is the control the crashing cases are
// measured against: the SAME minted union slot with nothing chained after it. It
// never reached the defect (no later query over the rewritten chain), so it is the
// oracle — the chained shapes above must lower to exactly this registration plus
// their trailing call, not to something the repair quietly changed.
func TestUnchainedRegistrationLowersIdentically(t *testing.T) {
	lowered := lowerSyntheticFixture(t,
		`export const m = manifest.addClass("pkg:Widget", Widget, typefor(Widget));`,
	)
	if !strings.Contains(lowered, syntheticLoweredRegistration) {
		t.Fatalf("the control registration did not lower as expected.\nwant to contain:\n%s\ngot:\n%s", syntheticLoweredRegistration, lowered)
	}
	if !strings.Contains(lowered, "Type.union(") {
		t.Fatalf("the fixture did not mint the union node the chained cases depend on — the pins above would be vacuous:\n%s", lowered)
	}
	if strings.Contains(lowered, "typefor(") {
		t.Fatalf("typefor survived lowering:\n%s", lowered)
	}
}

// TestAllRequiredParamsMintNoObjectLiteral pins the OTHER half of the mechanism:
// with both constructor parameters required the derived signature is two bare
// token strings, so no object literal is minted and the crash was unreachable even
// when chained. It guards the fixture above from silently losing its optional
// parameter — that would leave the pins passing for the wrong reason.
func TestAllRequiredParamsMintNoObjectLiteral(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, dir, syntheticFixturePkg, map[string]string{
		"src/di.ts": syntheticDiStub,
		"src/app.ts": `import { manifest, typefor } from "./di";

export interface IClock {}
export interface IOptions {}

export class Widget {
  public constructor(clock: IClock, options: IOptions) {
    void clock;
    void options;
  }
}

export const m = manifest.addClass("pkg:Widget", Widget, typefor(Widget)).as("singleton");
`,
	})

	env, stderr, code := driveHost(t, dir, `[]`)
	if code != 0 {
		t.Fatalf("an all-required constructor must lower cleanly; code = %d\ndiagnostics = %+v\nstderr: %s", code, env.Diagnostics, stderr)
	}
	lowered := loweredApp(t, env)
	if strings.Contains(lowered, "Type.union(") {
		t.Fatalf("an all-required constructor must derive plain Type nodes, no union:\n%s", lowered)
	}
	if strings.Contains(lowered, "typefor(") {
		t.Fatalf("typefor survived lowering:\n%s", lowered)
	}
}
