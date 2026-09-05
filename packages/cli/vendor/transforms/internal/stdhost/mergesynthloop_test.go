package stdhost

// The install call mergesynth rewrites is EMITTED MID-LOOP: authors spell the
// authoring sugar `registerAugmentations<R>(set)` (receiver as a type
// argument), and the inline stage substitutes it into the receiver-taking
// runtime form `registerAugmentations(type, set)`. Mergesynth therefore runs
// inside the fixed-point loop — a one-shot pre-pass would fire before the call
// it must rewrite exists, and the emitted install would carry no synthesized
// strategies at all, so a member-name collision would throw at install time.
// This file drives the WHOLE host over that authoring shape and pins the
// emitted third argument, the loop settling, and the strategies landing on
// every install.

import (
	"path/filepath"
	"strings"
	"testing"
)

// installRuntimePkg is the runtime home of the receiver-taking install
// function, mirroring the primitives leaf.
const installRuntimePkg = `{
  "name": "@scope/prims",
  "version": "1.0.0",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } }
}`

const installRuntimeIndex = `export function registerAugmentations(receiver: unknown, set: object, merge?: object): void {
  void receiver; void set; void merge;
}
`

// installSugarPkg is the authoring package: the type-argument sugar whose
// single-expression body EMITS the runtime install call, declared as an inline
// entry — mirroring the extras package. The program resolves the package's
// types face (a declaration file, so the consumer program never loads the body
// with its unbound typefor); the impl walk reads the src barrel.
const installSugarPkg = `{
  "name": "@scope/extras",
  "version": "1.0.0",
  "exports": { ".": { "types": "./types/index.d.ts", "default": "./src/index.ts" } },
  "rhombus-std": {
    "inline": {
      "entries": [
        { "impl": "@scope/extras:registerAugmentations" }
      ]
    }
  }
}`

const installSugarFace = `export declare function registerAugmentations<R>(set: object, merge?: object): void;
`

const installSugarIndex = `export * from './sugar';
`

const installSugarBody = `import { typefor } from '@rhombus-std/primitives.extras';
import { registerAugmentations as register } from '@scope/prims';
export function registerAugmentations<R>(set: object, merge?: object): void {
  return register(typefor<R>(), set, merge);
}
`

// buildInstallWorkspace materializes the three-package workspace and returns
// the app directory to drive the host from.
func buildInstallWorkspace(t *testing.T, mainSrc string) string {
	t.Helper()
	root := t.TempDir()
	writeFixtureFile(t, root, "package.json", sugarWorkspaceRootPkg)

	prims := filepath.Join(root, "packages", "prims")
	writeFixtureFile(t, prims, "package.json", installRuntimePkg)
	writeFixtureFile(t, prims, "src/index.ts", installRuntimeIndex)

	extras := filepath.Join(root, "packages", "extras")
	writeFixtureFile(t, extras, "package.json", installSugarPkg)
	writeFixtureFile(t, extras, "types/index.d.ts", installSugarFace)
	writeFixtureFile(t, extras, "src/index.ts", installSugarIndex)
	writeFixtureFile(t, extras, "src/sugar.ts", installSugarBody)
	symlinkPkg(t, extras, "@scope/prims", prims)

	app := filepath.Join(root, "packages", "app")
	writeFixtureFile(t, app, "package.json", `{"name":"@scope/app","version":"1.0.0",`+
		`"dependencies":{"@scope/extras":"workspace:*"},`+
		`"rhombus-std":{"typefor":{"emit":"inline"}}}`)
	writeFixtureFile(t, app, "main.ts", mainSrc)
	writeFixtureFile(t, app, "tsconfig.json", `{
  "compilerOptions": {
    "target": "ES2022", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "skipLibCheck": true, "noEmitOnError": false
  },
  "files": ["main.ts"]
}`)
	symlinkPkg(t, app, "@scope/extras", extras)
	symlinkPkg(t, app, "@scope/prims", prims)
	return app
}

func TestSugarInstallGainsSynthesizedStrategiesInTheLoop(t *testing.T) {
	app := buildInstallWorkspace(t, `import { registerAugmentations } from '@scope/extras';

export interface IAlpha { id: number; }

export const AlphaExtensions = {
  describe(opts: number): string { return String(opts); },
};
export const MoreExtensions = {
  describe(opts: { verbose: boolean }): string { return String(opts.verbose); },
};

registerAugmentations<IAlpha>(AlphaExtensions);
registerAugmentations<IAlpha>(MoreExtensions);
`)
	env, stderr, code := driveHost(t, app, `[]`)
	if got := findDiag(env, stagePanicCode); got != nil {
		t.Fatalf("a stage panicked (exit %d):\n%s", code, got.MessageText)
	}
	if got := findDiag(env, "FIXED_POINT_EXHAUSTED"); got != nil {
		t.Fatalf("the loop never settled: %s", got.MessageText)
	}
	if code != 0 {
		t.Fatalf("host failed (exit %d)\ndiagnostics = %+v\nstderr: %s", code, env.Diagnostics, stderr)
	}
	lowered, ok := env.TypeScript["main.ts"]
	if !ok {
		t.Fatalf("envelope has no main.ts emit\ndiagnostics = %+v", env.Diagnostics)
	}

	// The sugar lowered into the receiver-taking install with the derived type...
	if !strings.Contains(lowered, `Type.imported("IAlpha", "@scope/app/main"), AlphaExtensions, {`) {
		t.Fatalf("the first install carries no synthesized third argument:\n%s", lowered)
	}
	if !strings.Contains(lowered, `Type.imported("IAlpha", "@scope/app/main"), MoreExtensions, {`) {
		t.Fatalf("the second install carries no synthesized third argument:\n%s", lowered)
	}
	// ...and the synthesized map carries the member's dispatch strategy.
	if !strings.Contains(lowered, "describe: function (original, extension)") {
		t.Fatalf("no synthesized describe strategy:\n%s", lowered)
	}
	if strings.Contains(lowered, "typefor") {
		t.Fatalf("a typefor call survived lowering:\n%s", lowered)
	}
}
