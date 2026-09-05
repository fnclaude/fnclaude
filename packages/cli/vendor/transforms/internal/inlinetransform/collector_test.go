package inlinetransform

import (
	"path/filepath"
	"testing"
)

// implsOf returns the set of impl names across a collected entry list.
func implsOf(owned []OwnedEntry) map[string]bool {
	set := map[string]bool{}
	for _, oe := range owned {
		set[oe.Entry.Impl] = true
	}
	return set
}

// TestCollectOwnEntries: a consumer package's OWN rhombus-std inline entries are
// honored, tagged with the consumer's own directory.
func TestCollectOwnEntries(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{ "name": "ws", "private": true, "workspaces": ["packages/*"] }`)
	app := filepath.Join(root, "packages", "app")
	write(t, filepath.Join(app, "package.json"), `{
  "name": "@scope/app",
  "rhombus-std": { "inline": { "entries": [ { "impl": "@scope/app:own" } ] } }
}`)

	owned, err := Collect(app)
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(owned) != 1 {
		t.Fatalf("expected 1 own entry, got %d: %+v", len(owned), owned)
	}
	if owned[0].Entry.Impl != "@scope/app:own" {
		t.Fatalf("Impl = %q, want @scope/app:own", owned[0].Entry.Impl)
	}
	if owned[0].PackageDir != filepath.Clean(app) {
		t.Fatalf("PackageDir = %q, want %q", owned[0].PackageDir, filepath.Clean(app))
	}
}

// TestCollectCyclicDeps: two workspace packages depending on each other must be
// each collected once and the walk must terminate (the visited-by-directory
// cycle guard). A failure here hangs, not just miscounts.
func TestCollectCyclicDeps(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{ "name": "ws", "private": true, "workspaces": ["packages/*"] }`)
	write(t, filepath.Join(root, "packages", "a", "package.json"), `{
  "name": "@scope/a",
  "dependencies": { "@scope/b": "workspace:*" },
  "rhombus-std": { "inline": { "entries": [ { "impl": "@scope/a:a" } ] } }
}`)
	write(t, filepath.Join(root, "packages", "b", "package.json"), `{
  "name": "@scope/b",
  "dependencies": { "@scope/a": "workspace:*" },
  "rhombus-std": { "inline": { "entries": [ { "impl": "@scope/b:b" } ] } }
}`)

	owned, err := Collect(filepath.Join(root, "packages", "a"))
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(owned) != 2 {
		t.Fatalf("a↔b cycle should yield exactly 2 entries, got %d: %+v", len(owned), owned)
	}
	impls := implsOf(owned)
	if !impls["@scope/a:a"] || !impls["@scope/b:b"] {
		t.Fatalf("expected both a and b collected once, got %v", impls)
	}
}

// TestCollectPeerAndDevDeps: entries reachable only via peerDependencies (this
// repo's real graph shape, e.g. di ← di.core) and via devDependencies are both
// traversed.
func TestCollectPeerAndDevDeps(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{ "name": "ws", "private": true, "workspaces": ["packages/*"] }`)
	write(t, filepath.Join(root, "packages", "app", "package.json"), `{
  "name": "@scope/app",
  "peerDependencies": { "@scope/peer": "workspace:*" },
  "devDependencies": { "@scope/dev": "workspace:*" }
}`)
	write(t, filepath.Join(root, "packages", "peer", "package.json"), `{
  "name": "@scope/peer",
  "rhombus-std": { "inline": { "entries": [ { "impl": "@scope/peer:peer" } ] } }
}`)
	write(t, filepath.Join(root, "packages", "dev", "package.json"), `{
  "name": "@scope/dev",
  "rhombus-std": { "inline": { "entries": [ { "impl": "@scope/dev:dev" } ] } }
}`)

	owned, err := Collect(filepath.Join(root, "packages", "app"))
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	impls := implsOf(owned)
	if !impls["@scope/peer:peer"] {
		t.Fatalf("peerDependencies entry not collected: %v", impls)
	}
	if !impls["@scope/dev:dev"] {
		t.Fatalf("devDependencies entry not collected: %v", impls)
	}
}

// TestCollectProjectBodiesRootOnlyDevDeps exercises the root-only-devDeps
// refinement of the body walk (§100): the root's own devDep bodies and the
// transitive dep/peer bodies are collected, but a transitive dependency's devDep
// bodies are NOT — a core that devDeps its own authoring package must never drag
// that package's sugar onto a consumer of the core. (Stage selection is retired,
// W7 — the walk collects only bodies now, so root-only-devDeps is verified over
// the rhombus-std inline face.)
func TestCollectProjectBodiesRootOnlyDevDeps(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{ "name": "ws", "private": true, "workspaces": ["packages/*"] }`)
	// app: a runtime dep on a core, a dev dep on an authoring package.
	write(t, filepath.Join(root, "packages", "app", "package.json"), `{
  "name": "@scope/app",
  "dependencies": { "@scope/core": "workspace:*" },
  "devDependencies": { "@scope/roottf": "workspace:*" }
}`)
	// roottf: the root's own devDep authoring package (bodies collected) whose
	// runtime dep on another authoring package (transitive dep) is also collected.
	write(t, filepath.Join(root, "packages", "roottf", "package.json"), `{
  "name": "@scope/roottf",
  "dependencies": { "@scope/deptf": "workspace:*" },
  "rhombus-std": { "inline": { "entries": [ { "impl": "@scope/roottf:roottf" } ] } }
}`)
	write(t, filepath.Join(root, "packages", "deptf", "package.json"), `{
  "name": "@scope/deptf",
  "rhombus-std": { "inline": { "entries": [ { "impl": "@scope/deptf:deptf" } ] } }
}`)
	// core: no bodies, but devDeps an authoring package whose bodies must NOT leak —
	// the core is not the root, so its devDeps are its own build tooling.
	write(t, filepath.Join(root, "packages", "core", "package.json"), `{
  "name": "@scope/core",
  "devDependencies": { "@scope/leaktf": "workspace:*" }
}`)
	write(t, filepath.Join(root, "packages", "leaktf", "package.json"), `{
  "name": "@scope/leaktf",
  "rhombus-std": { "inline": { "entries": [ { "impl": "@scope/leaktf:leaktf" } ] } }
}`)

	scan, err := CollectProject(filepath.Join(root, "packages", "app"))
	if err != nil {
		t.Fatalf("CollectProject: %v", err)
	}
	got := implsOf(scan.Bodies)
	if !got["@scope/roottf:roottf"] {
		t.Errorf("root devDep body 'roottf' not collected: %v", got)
	}
	if !got["@scope/deptf:deptf"] {
		t.Errorf("transitive dep body 'deptf' not collected: %v", got)
	}
	if got["@scope/leaktf:leaktf"] {
		t.Errorf("transitive DEVDEP body 'leaktf' leaked (root-only devDeps violated): %v", got)
	}
}

// TestCollectProjectNoPackageJsonDegradesToEmpty: a bare directory with no
// package.json in it or any ancestor (a non-workspace ttsc project — the parity
// fixtures) yields an EMPTY scan and NO error. With stage selection retired (W7)
// an empty scan is a legitimate no-op — the host runs its always-on stage table
// and emits an unmatched file unchanged. A normal workspace consumer still carries
// its bodies.
func TestCollectProjectNoPackageJsonDegradesToEmpty(t *testing.T) {
	// (a) rootless dir -> empty scan, no error.
	bare := t.TempDir()
	scan, err := CollectProject(bare)
	if err != nil {
		t.Fatalf("CollectProject on a rootless dir must not error, got: %v", err)
	}
	if len(scan.Bodies) != 0 {
		t.Fatalf("rootless scan must be empty, got bodies=%v", scan.Bodies)
	}

	// (b) a normal workspace consumer still yields its bodies.
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{ "name": "ws", "private": true, "workspaces": ["packages/*"] }`)
	write(t, filepath.Join(root, "packages", "app", "package.json"), `{
  "name": "@scope/app",
  "devDependencies": { "@scope/tf": "workspace:*" }
}`)
	write(t, filepath.Join(root, "packages", "tf", "package.json"), `{
  "name": "@scope/tf",
  "rhombus-std": { "inline": { "entries": [ { "impl": "@scope/tf:tf" } ] } }
}`)
	ws, err := CollectProject(filepath.Join(root, "packages", "app"))
	if err != nil {
		t.Fatalf("CollectProject on a workspace dir: %v", err)
	}
	if len(ws.Bodies) == 0 {
		t.Fatalf("workspace scan must carry bodies, got bodies=%v", ws.Bodies)
	}
}

// TestWorkspaceObjectForm: the object form of the "workspaces" field
// (`{ "packages": [...] }`) must be parsed for the workspace map.
func TestWorkspaceObjectForm(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{
  "name": "ws", "private": true,
  "workspaces": { "packages": ["packages/*"] }
}`)
	write(t, filepath.Join(root, "packages", "app", "package.json"), `{
  "name": "@scope/app",
  "dependencies": { "@scope/lib": "workspace:*" }
}`)
	write(t, filepath.Join(root, "packages", "lib", "package.json"), `{
  "name": "@scope/lib",
  "rhombus-std": { "inline": { "entries": [ { "impl": "@scope/lib:lib" } ] } }
}`)

	owned, err := Collect(filepath.Join(root, "packages", "app"))
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if !implsOf(owned)["@scope/lib:lib"] {
		t.Fatalf("object-form workspaces did not resolve @scope/lib: %+v", owned)
	}
}
