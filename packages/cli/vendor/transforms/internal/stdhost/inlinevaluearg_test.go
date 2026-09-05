package stdhost

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// This file pins the SECOND route into the checker nil-deref — the one
// plugin.CheckerAnchor alone does not close, because the node handed to the
// checker never comes off the current tree at query time at all: it was RECORDED
// into the inline stage's artifacts, and recorded from a tree earlier passes had
// already rewritten.
//
// THE MECHANISM. The inline visitor does not descend past a match, so a sugar call
// sitting in RECEIVER (or argument) position under another sugar call is not
// substituted on pass 0 — it waits. While it waits, the primitive stages lower
// whatever is inside its arguments, rebuilding them through factory.Update*. On the
// pass that finally reaches it, `callArguments(call)` hands back those REBUILT
// nodes, and registerPrimitives recorded one as the value-argument primitive's
// `ValueArg`. The typefor stage's artifacts branch hands it straight to the
// checker, which resolves the enclosing call's overloads, contextually types the
// rebuilt (symbol-less) property assignment, and nil-derefs in
// getContextualTypeForObjectLiteralElement. The whole file is then lost: the panic
// aborts before anything is emitted.
//
// THE REPAIR. fileState.anchorValueArg resolves the spliced argument to its pass-0
// node before recording it, so `ValueArg` is a parse node by construction and the
// query is the one the stage meant to ask. A shape with no parse node behind it
// records nil, which every consumer reads as "not a registered value argument" —
// the primitive stays put and the emit sweep names it, rather than the process
// dying.
//
// WHAT THESE TESTS PROTECT. The crash pin below fails LOUDLY on a regression (the
// host emits a STAGE_PANIC diagnostic and no file at all), and the parity pin holds
// the fix honest: the type must be derived from the SOURCE-WRITTEN argument, so a
// registration lowers identically whether it inlined on pass 0 or waited a pass.

// sugarWorkspaceRootPkg makes the fixture a workspace root, so CollectProject
// walks into packages/* and finds the core package's inline entries.
const sugarWorkspaceRootPkg = `{ "name": "ws", "private": true, "workspaces": ["packages/*"] }`

// sugarCorePkg is the runtime package: the receiver and its explicit token
// forms, with no sugar of its own.
const sugarCorePkg = `{
  "name": "@scope/core",
  "version": "1.0.0",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } }
}`

// sugarSugarPkg is the sugar-owning package: it declares two inline entries
// whose bodies live out of barrel in src/inline.ts, mirroring the real
// di.extras shapes (`addClass<T>(ctor)` and `addValue(value)` each carrying a
// VALUE-argument typefor).
const sugarSugarPkg = `{
  "name": "@scope/sugar",
  "version": "1.0.0",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } },
  "dependencies": { "@scope/core": "workspace:*" },
  "rhombus-std": {
    "inline": {
      "entries": [
        { "type": "@scope/core:IManifest", "impl": "@scope/sugar:ManifestInline", "member": "addClass" },
        { "type": "@scope/core:IManifest", "impl": "@scope/sugar:ManifestInline", "member": "addValue" }
      ]
    }
  }
}`

// sugarCoreIndex is the runtime surface the lowered calls land on: the explicit
// token forms a no-transformer author would write by hand. addValue returns the
// manifest so a registration can sit in RECEIVER position, which is what makes the
// following call wait a pass.
const sugarCoreIndex = `export interface IChain {
  as(scope: string): IChain;
}
export interface IManifest {
  addClass(token: unknown, ctor: unknown, sig: unknown): IChain;
  addValue(token: unknown, value: unknown): IManifest;
}
export declare const services: IManifest;
`

// sugarCoreInline holds the single-expression sugar bodies. Both pass their own
// parameter straight into a value-argument typefor call — the shape whose
// recorded argument this file is about.
const sugarCoreInline = `import { typefor } from '@rhombus-std/primitives.extras';
import type { IChain, IManifest } from '@scope/core';
export const ManifestInline = {
  addClass<T>(this: IManifest, ctor: unknown): IChain {
    return this.addClass(typefor<T>(), ctor, typefor(ctor));
  },
  addValue(this: IManifest, value: unknown): IManifest {
    return this.addValue(typefor(value), value);
  },
};
`

// sugarSugarDts is the sugar package's own declaration merge the transformer
// matches against — the authoring overloads layered over the explicit forms
// above, owned by the package whose bodies serve them.
const sugarSugarDts = `declare module '@scope/core' {
  interface IManifest {
    addClass<T>(ctor: unknown): IChain;
    addValue(value: unknown): IManifest;
  }
}
export {};
`

// sugarAppTsconfig pulls the core package's source into the app program, so the
// merged interface resolves without a built dist.
const sugarAppTsconfig = `{
  "compilerOptions": {
    "target": "ES2022", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "skipLibCheck": true, "noEmitOnError": false
  },
  "files": ["main.ts", "prim.ts", "node_modules/@scope/core/src/index.ts", "node_modules/@scope/sugar/src/index.ts"]
}`

// sugarAppPrim is a local `typefor` stub. It gives the fixture a SOURCE-WRITTEN
// primitive to place inside a registration's value argument — the thing an earlier
// pass rewrites while the enclosing sugar call waits.
const sugarAppPrim = `export declare function typefor<T>(): unknown;
`

// symlinkPkg links name into dir/node_modules so Bundler resolution finds the
// workspace package by its bare specifier.
func symlinkPkg(t *testing.T, dir, name, target string) {
	t.Helper()
	link := filepath.Join(dir, "node_modules", filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(link), err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink %s -> %s: %v", link, target, err)
	}
}

// buildSugarWorkspace materializes the two-package workspace around one app
// source and returns the app directory to drive the host from.
func buildSugarWorkspace(t *testing.T, mainSrc string) string {
	t.Helper()
	root := t.TempDir()
	writeFixtureFile(t, root, "package.json", sugarWorkspaceRootPkg)

	core := filepath.Join(root, "packages", "core")
	writeFixtureFile(t, core, "package.json", sugarCorePkg)
	writeFixtureFile(t, core, "src/index.ts", sugarCoreIndex)

	sugar := filepath.Join(root, "packages", "sugar")
	writeFixtureFile(t, sugar, "package.json", sugarSugarPkg)
	writeFixtureFile(t, sugar, "src/index.ts", sugarSugarDts)
	writeFixtureFile(t, sugar, "src/inline.ts", sugarCoreInline)
	symlinkPkg(t, sugar, "@scope/core", core)

	app := filepath.Join(root, "packages", "app")
	// Inline emission, so an assertion below reads the derived tree where it was
	// derived. What these fixtures pin is the inline STAGE's fixed-point behaviour
	// over a rewritten value argument, which is the same either way; spelling the
	// tree at the call site is simply what makes the pin legible.
	writeFixtureFile(t, app, "package.json", `{"name":"@scope/app","version":"1.0.0",`+
		`"dependencies":{"@scope/core":"workspace:*","@scope/sugar":"workspace:*"},`+
		`"rhombus-std":{"typefor":{"emit":"inline"}}}`)
	writeFixtureFile(t, app, "prim.ts", sugarAppPrim)
	writeFixtureFile(t, app, "main.ts", mainSrc)
	writeFixtureFile(t, app, "tsconfig.json", sugarAppTsconfig)
	symlinkPkg(t, app, "@scope/core", core)
	symlinkPkg(t, app, "@scope/sugar", sugar)
	return app
}

// lowerSugarApp drives the real host over the workspace and returns the lowered
// main.ts plus the decoded envelope. It fails the test on a stage panic, which is
// the regression this file exists to catch: a panic loses the whole file, so the
// envelope carries no emit at all.
func lowerSugarApp(t *testing.T, mainSrc string) (string, decodedEnvelope) {
	t.Helper()
	app := buildSugarWorkspace(t, mainSrc)
	env, stderr, code := driveHost(t, app, `[]`)
	if got := findDiag(env, stagePanicCode); got != nil {
		t.Fatalf("the checker crashed on a recorded value argument (exit %d):\n%s", code, got.MessageText)
	}
	lowered, ok := env.TypeScript["main.ts"]
	if !ok {
		t.Fatalf("envelope has no main.ts emit; code = %d\ndiagnostics = %+v\nstderr: %s", code, env.Diagnostics, stderr)
	}
	return lowered, env
}

// TestWaitingSugarOverRewrittenValueArgumentDoesNotCrash is the crash pin. The
// `addValue(...)` sugar sits in RECEIVER position under `addClass<IWidget>(...)`,
// so it is not reached on pass 0; meanwhile the source-written `typefor<IClock>()`
// inside its object-literal argument lowers, rebuilding that literal. When the
// receiver finally inlines, the argument it splices — and, before the repair,
// recorded — is the rebuilt one.
//
// The value's type is an anonymous object literal, which derives to a
// `Type.object` token over its members. The point of the pin is that the run
// lowers cleanly and still emits the file, with the sibling registration fully
// lowered — the crash-repair holds whether or not the rewritten argument derives.
func TestWaitingSugarOverRewrittenValueArgumentDoesNotCrash(t *testing.T) {
	lowered, env := lowerSugarApp(t, `import { services } from '@scope/core';
import { typefor } from './prim';

export interface IClock {}
export interface IWidget {}
export class Widget {
  public constructor(clock: IClock) { void clock; }
}

export const registered = services
  .addValue({ clockToken: typefor<IClock>(), retries: 3 })
  .addClass<IWidget>(Widget);
`)

	// The registration that DID inline on pass 0 must be fully lowered — a repair
	// that stopped the crash by lowering less would leave the sugar standing.
	if !strings.Contains(lowered, `.addClass(Type.imported("IWidget", "@scope/app/main"), Widget, `+
		`Type.ctor(Type.imported("Widget", "@scope/app/main"), [[Type.imported("IClock", "@scope/app/main")]]))`) {
		t.Fatalf("the pass-0 registration did not lower:\n%s", lowered)
	}
	// The source-written primitive inside the waiting call's argument lowered too.
	if !strings.Contains(lowered, `Type.imported("IClock", "@scope/app/main"), retries: 3`) {
		t.Fatalf("the source-written typefor inside the waiting call's argument did not lower:\n%s", lowered)
	}
	// The rewritten object-literal value derives its token as a Type.object over
	// its members, so the run lowers cleanly rather than taking the process down.
	if !strings.Contains(lowered, `.addValue(Type.object({ clockToken: `) ||
		!strings.Contains(lowered, `retries: Type.global("number") }),`) {
		t.Fatalf("the object-literal value's token did not derive to Type.object:\n%s", lowered)
	}
	if len(env.Diagnostics) != 0 {
		t.Fatalf("the clean lowering must report no diagnostic; diagnostics = %+v", env.Diagnostics)
	}
}

// TestWaitingSugarDerivesFromTheSourceWrittenArgument is the parity half: the
// type must come from the argument as the AUTHOR wrote it, so a registration
// lowers identically whether it inlined on pass 0 or waited for the pass above it
// to finish. It is what stops "record the parse node" from silently becoming
// "record whatever the loop happens to have left there".
func TestWaitingSugarDerivesFromTheSourceWrittenArgument(t *testing.T) {
	const prelude = `import { services } from '@scope/core';
import { typefor } from './prim';

export interface IClock {}
export interface IWidget {}
export interface IAppSettings { clockToken: string; retries: number }
export class Widget {
  public constructor(clock: IClock, settings?: IAppSettings) { void clock; void settings; }
}

`
	// WAITING: the addValue sugar is the receiver, so it inlines a pass late, over
	// an argument the typefor lowering has already rebuilt.
	waiting, _ := lowerSugarApp(t, prelude+`export const registered = services
  .addValue({ clockToken: typefor<IClock>(), retries: 3 } as IAppSettings)
  .addClass<IWidget>(Widget);
`)
	// PASS-0: the same two registrations, split so each is reached immediately.
	immediate, _ := lowerSugarApp(t, prelude+`export const a = services.addValue({ clockToken: typefor<IClock>(), retries: 3 } as IAppSettings);
export const b = services.addClass<IWidget>(Widget);
`)

	const wantValue = `.addValue(Type.imported("IAppSettings", "@scope/app/main"), ` +
		`{ clockToken: Type.imported("IClock", "@scope/app/main"), retries: 3 } as IAppSettings)`
	if !strings.Contains(waiting, wantValue) {
		t.Fatalf("the waiting registration did not derive its type from the source-written argument.\nwant to contain:\n%s\ngot:\n%s", wantValue, waiting)
	}
	if !strings.Contains(immediate, wantValue) {
		t.Fatalf("the pass-0 control did not lower as expected.\nwant to contain:\n%s\ngot:\n%s", wantValue, immediate)
	}
	// The OPTIONAL constructor parameter is what mints the union slot, so this is
	// also the sugar-path coverage for the shape the direct-form pins cover: an
	// optional parameter reached through `addClass<T>()` rather than a hand-written
	// registration.
	const wantClass = `.addClass(Type.imported("IWidget", "@scope/app/main"), Widget, Type.ctor(` +
		`Type.imported("Widget", "@scope/app/main"), [[Type.imported("IClock", "@scope/app/main"), ` +
		`Type.union(Type.imported("IAppSettings", "@scope/app/main"), Type.typeLiteral(undefined))]]))`
	for name, out := range map[string]string{"waiting": waiting, "immediate": immediate} {
		if !strings.Contains(out, wantClass) {
			t.Fatalf("the %s registration did not mint the optional parameter's union slot.\nwant to contain:\n%s\ngot:\n%s", name, wantClass, out)
		}
		if strings.Contains(out, "typefor") {
			t.Fatalf("a primitive survived the %s lowering:\n%s", name, out)
		}
	}
}

// TestSugarRegistrationWithOptionalParamAndTrailingChain closes the coverage hole
// the direct-form pins left: the same minted union slot, but reached through the
// `addClass<T>()` SUGAR with a trailing chain call after it. Nothing in the
// workspace or the parity suites registers a class with an optional constructor
// parameter through the sugar path, so this shape — the one a consumer actually
// writes — went entirely unexercised. It must lower to the control registration
// with its trailing call appended.
func TestSugarRegistrationWithOptionalParamAndTrailingChain(t *testing.T) {
	const prelude = `import { services } from '@scope/core';

export interface IClock {}
export interface IOptions {}
export interface IWidget {}
export class Widget {
  public constructor(clock: IClock, options?: IOptions) { void clock; void options; }
}

`
	const wantRegistration = `services.addClass(Type.imported("IWidget", "@scope/app/main"), Widget, Type.ctor(` +
		`Type.imported("Widget", "@scope/app/main"), [[Type.imported("IClock", "@scope/app/main"), ` +
		`Type.union(Type.imported("IOptions", "@scope/app/main"), Type.typeLiteral(undefined))]]))`

	control, _ := lowerSugarApp(t, prelude+"export const m = services.addClass<IWidget>(Widget);\n")
	if !strings.Contains(control, wantRegistration) {
		t.Fatalf("the unchained control did not lower as expected.\nwant to contain:\n%s\ngot:\n%s", wantRegistration, control)
	}

	chained, _ := lowerSugarApp(t, prelude+"export const m = services.addClass<IWidget>(Widget).as(\"singleton\");\n")
	if !strings.Contains(chained, wantRegistration+`.as("singleton")`) {
		t.Fatalf("the chained shape did not lower to the control plus its trailing call.\nwant to contain:\n%s\ngot:\n%s", wantRegistration+`.as("singleton")`, chained)
	}
	if strings.Contains(chained, "typefor") || strings.Contains(chained, "addClass<") {
		t.Fatalf("authoring surface survived the chained lowering:\n%s", chained)
	}
}
