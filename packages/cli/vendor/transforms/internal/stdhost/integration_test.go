package stdhost

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/samchon/ttsc/packages/ttsc/driver"
)

// This file is the in-process integration tier for the ttsc transform host — the
// missing rung between the per-stage Go unit tests (which drive one transform
// over a hand-built program) and the external tests/*.ttsc.e2e suites (which
// shell out to a real ttsc + node and pay a multi-minute cold sidecar compile).
// Here Run drives the WHOLE host pipeline in one process against a real fixture:
// CollectProject dependency scan -> driver.LoadProgram -> the per-file transform
// loop -> the JSON envelope. No ttsc, no node, no network.
//
// The fixtures compile only LOCAL source — a typefor<T>() over a local interface,
// imported from a local ./typefor stub — so driver.LoadProgram resolves nothing
// off disk and the tier needs no built dist. That is the deliberate scope line:
// the semantic di/isService lowerings require di.core to actually RESOLVE (their
// e2e symlinks and builds it), which couples a lowering to a JS build a Go test
// should not carry; those stay covered by tests/inline.ttsc.e2e. What this tier
// pins is the host wiring the unit tests cannot reach on their own — real program
// loading and the envelope — with the whole stage table always on (W7: no
// selection; the --plugins-json manifest no longer chooses stages).

// decodedEnvelope mirrors host.go's projectEnvelope for reading back the JSON the
// host encodes to stdout.
type decodedEnvelope struct {
	Diagnostics []struct {
		File        *string `json:"file"`
		Category    string  `json:"category"`
		Code        string  `json:"code"`
		MessageText string  `json:"messageText"`
	} `json:"diagnostics"`
	TypeScript map[string]string `json:"typescript"`
}

// fixtureTsconfig is a minimal Bundler-resolution project config. noEmitOnError
// is off and skipLibCheck on so a self-contained fixture loads cleanly; the host
// runs source-to-source (ForceEmit) and returns the envelope on stdout rather
// than writing an outDir, so none is set.
const fixtureTsconfig = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "rootDir": "src",
    "skipLibCheck": true,
    "noEmitOnError": false
  },
  "include": ["src/**/*"]
}
`

// typeforAppSrc is the shared fixture source: a lone typefor<T>() over a local
// interface, imported from a local ./typefor stub. The stage matches any call
// whose callee symbol is named `typefor`, so the local stub is enough; when the
// typefor stage is active the call lowers to the derived `Type.imported` tree and
// the now-dead import elides.
var typeforAppSrc = map[string]string{
	"src/typefor.ts": "export declare function typefor<T>(): unknown;\n",
	"src/app.ts": `import { typefor } from "./typefor";

export interface IWidget {}

export const widgetToken = typefor<IWidget>();
`,
}

// writeFixtureFile writes body to dir/rel (rel is forward-slashed), creating any
// parent directories.
func writeFixtureFile(t *testing.T, dir, rel, body string) {
	t.Helper()
	full := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(full), err)
	}
	if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", full, err)
	}
}

// writeFixture materializes a fixture in dir: package.json (so CollectProject
// finds a root), the Bundler tsconfig, and the given src files.
func writeFixture(t *testing.T, dir, pkgJSON string, srcFiles map[string]string) {
	t.Helper()
	writeFixtureFile(t, dir, "package.json", pkgJSON)
	writeFixtureFile(t, dir, "tsconfig.json", fixtureTsconfig)
	for rel, body := range srcFiles {
		writeFixtureFile(t, dir, rel, body)
	}
}

// driveHost runs stdhost.Run over an already-materialized fixture dir with the
// given plugin manifest and returns the decoded envelope, captured stderr, and
// the exit code. The linked-plugins env is forced empty so the run does not
// inherit an ambient TTSC_LINKED_PLUGINS_JSON from the host machine.
func driveHost(t *testing.T, dir, manifest string) (decodedEnvelope, string, int) {
	t.Helper()
	return driveHostWith(t, testHost(), dir, manifest)
}

// driveHostWith is driveHost over a caller-supplied host, so a test can drive the
// same fixture path with a hand-built stage table (a deliberately panicking stub
// stage, say) instead of the real one.
func driveHostWith(t *testing.T, host Host, dir, manifest string) (decodedEnvelope, string, int) {
	t.Helper()
	t.Setenv(driver.LinkedPluginsEnv, "")

	var outBuf, errBuf bytes.Buffer
	restore := swapStreams(&outBuf, &errBuf)
	defer restore()

	code := Run(host, []string{
		"--cwd=" + dir,
		"--tsconfig=" + filepath.Join(dir, "tsconfig.json"),
		"--plugins-json", manifest,
	})

	var env decodedEnvelope
	if outBuf.Len() > 0 {
		if err := json.Unmarshal(outBuf.Bytes(), &env); err != nil {
			t.Fatalf("decode envelope: %v\nstdout: %q\nstderr: %s", err, outBuf.String(), errBuf.String())
		}
	}
	return env, errBuf.String(), code
}

// selfFixturePkg is a dependency-free consumer manifest. CollectProject finds it
// as the root, resolves no dependencies, and returns an empty body scan — the
// whole stage table still runs (W7: always-on), so the local typefor call lowers
// with no plugin manifest at all.
const selfFixturePkg = `{"name":"@rhombus-std/a2-fixture","version":"0.0.0","private":true}`

// selfFixtureTypeforPkg is selfFixturePkg's shape plus an inline typefor-emission
// pin, so a lowered call site is a single self-contained assertion rather than a
// reference into a second generated-module envelope entry.
const selfFixtureTypeforPkg = `{"name":"@rhombus-std/a2-fixture","version":"0.0.0","private":true,` +
	`"rhombus-std":{"typefor":{"emit":"inline"}}}`

// loweredApp pulls the emitted src/app.ts out of the envelope, failing loudly
// (with the available keys) when it is absent.
func loweredApp(t *testing.T, env decodedEnvelope) string {
	t.Helper()
	lowered, ok := env.TypeScript["src/app.ts"]
	if !ok {
		keys := make([]string, 0, len(env.TypeScript))
		for k := range env.TypeScript {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		t.Fatalf("envelope has no src/app.ts entry; keys=%v", keys)
	}
	return lowered
}

// assertTypeforLowered checks the emitted app carries a derived IWidget import and
// no surviving `typefor` (neither the call nor its now-dead import). The name is
// asserted rather than the whole call so the check does not pin the package name
// or path derivation, only that a Type was minted for IWidget.
func assertTypeforLowered(t *testing.T, lowered string) {
	t.Helper()
	if !strings.Contains(lowered, `Type.imported("IWidget"`) {
		t.Fatalf("expected a derived Type.imported(\"IWidget\", ...) call, got:\n%s", lowered)
	}
	if strings.Contains(lowered, "typefor") {
		t.Fatalf("typefor survived lowering (call or import not elided):\n%s", lowered)
	}
}

// TestRunLowersSourceTypeforAlwaysOnInProcess drives the full host over a
// self-contained fixture with an EMPTY plugin manifest and proves the whole
// always-on path end-to-end in one process (W7: no selection): a real
// driver.LoadProgram over a real (if tiny) project, the always-on stage table run
// over every source file, and the lowered result read back off the envelope. The
// typefor stage lowering the local call with no manifest entry IS the always-on
// proof — the old design would have emitted NO_STAGES here.
func TestRunLowersSourceTypeforAlwaysOnInProcess(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, dir, selfFixtureTypeforPkg, typeforAppSrc)

	env, stderr, code := driveHost(t, dir, `[]`)
	if code != 0 {
		t.Fatalf("host exit = %d, want 0\nstderr: %s", code, stderr)
	}
	assertTypeforLowered(t, loweredApp(t, env))
}
