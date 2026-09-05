// Package stdhost is the shared single-owner ttsc transform-host scaffolding
// behind the @rhombus-std owner binary. The command (cmd/ttsc-std) is a thin
// main that composes a Host value — a name and an ordered stage table — and
// hands it to Run; everything else (the linked-plugin handoff, the per-file
// transform loop, and the JSON envelope) lives here once.
//
// Every stage is ALWAYS on (W7): there is no stage selection. A consumer that
// reaches any @rhombus-std/*.extras dependency spawns this one host through
// ttsc's auto-discovery, and the host runs its whole stage table over every
// file — the stages own disjoint match sets, so a stage with nothing to match is
// a cheap no-op. WHICH sugar bodies are substituted still comes from the §100
// dependency scan (CollectProject), but WHICH stages run no longer does.
//
// There is ONE host. It links typia through the merge-synthesis stage
// (internal/mergesynthtransform, #213), which the base stage table now carries;
// the former two-binary split — a published typia-free host plus an
// in-repo-only sibling that added mergesynth — is retired. typia is fully
// lowered at build time and appears in no shipped artifact or npm manifest (the
// stage embeds its guards as inlined plain JS), so the single binary stays a
// build-time-only tool with no typia runtime footprint.
package stdhost

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/fnioc/std/transforms/internal/inlinetransform"
	"github.com/fnioc/std/transforms/internal/plugin"
	"github.com/fnioc/std/transforms/internal/tokens"
	"github.com/fnioc/std/transforms/internal/typeemit"
	"github.com/fnioc/std/transforms/internal/typeforhoist"
	"github.com/fnioc/std/transforms/internal/typefortransform"
)

const (
	categoryError   = "error"
	categoryWarning = "warning"
)

// stagePanicCode is the diagnostic code for a recovered panic inside the
// per-file transform pipeline. It is an ENGINE bug every time — a stage, the
// emit sweep, or the printer crashed — and the diagnostic exists so the report
// names the file and the stage instead of arriving as an anonymous Go stack
// trace on stderr.
const stagePanicCode = "STAGE_PANIC"

// hostPanicCode is the diagnostic code for a panic recovered OUTSIDE the
// per-file loop — the dependency scan, program load, linked-plugin handoff, or
// envelope encode. There is no file to name at that point, so it is reported on
// stderr rather than in the envelope, but it still carries the host name and the
// stack.
const hostPanicCode = "HOST_PANIC"

var (
	stdout io.Writer = os.Stdout
	stderr io.Writer = os.Stderr
)

// Host is one owner binary's identity: its diagnostic name and its ordered stage
// table (the slice order IS the canonical execution order). Every stage in the
// table runs on every file — the host performs no selection (W7).
type Host struct {
	Name   string
	Stages []Stage
}

// Stage pairs a descriptor name with its transform builder.
type Stage struct {
	Name  string
	Build Builder
}

// Env carries the cross-stage state a builder may need: the project working
// directory, the per-run inline artifacts (populated by the inline stage, read by
// typefor and the emit sweep), the inline BODIES the host pre-collected in its
// single dependency scan (threaded to the inline stage so the walk runs once),
// and the project's typefor const table (nil when the project spells its derived
// types inline).
type Env struct {
	Cwd       string
	Artifacts *inlinetransform.Artifacts
	Bodies    []inlinetransform.OwnedEntry
	Hoist     *typefortransform.Hoist
}

// Sink receives one diagnostic from a stage's transform.
type Sink func(Diag)

// Diag is a stage diagnostic destined for the envelope. Warning diagnostics
// are reported without failing the emit; everything else is a hard error.
// Line and Character are 1-based source positions, populated when the
// diagnostic anchors to a known location; nil when it does not.
type Diag struct {
	File      string
	Warning   bool
	Code      string
	Message   string
	Line      *int
	Character *int
}

// Builder adapts a stage's native transform factory (each with its own
// diagnostic type) onto the shared FileTransform + Diag contract.
type Builder func(prog *driver.Program, ctx *tokens.Context, env *Env, emit Sink) plugin.FileTransform

// DiagFromPlugin converts a plugin.Diagnostic (no category of its own) into a
// hard-error Diag.
func DiagFromPlugin(d plugin.Diagnostic) Diag {
	return Diag{
		File:    d.File,
		Code:    d.Code,
		Message: d.Message,
	}
}

// DiagFromTypeScript converts one of the consumer program's own ordinary
// TypeScript diagnostics (a real TS2xxx/TS1xxx error the checker or parser
// raised against the author's source, as opposed to a diagnostic one of this
// host's own stages emitted) into a hard-error Diag, carrying its source
// position when the diagnostic has one.
func DiagFromTypeScript(d driver.Diagnostic) Diag {
	diag := Diag{
		File:    d.File,
		Code:    fmt.Sprintf("TS%d", d.Code),
		Message: d.Message,
	}
	if d.Line > 0 {
		line := d.Line
		character := d.Column
		diag.Line = &line
		diag.Character = &character
	}
	return diag
}

// Run dispatches the host command line: the transform-stage contract the ttsc
// host relies on plus `check`, `version`, and `help` for standalone use,
// mirroring the shared sidecar scaffolding's router.
func Run(host Host, args []string) (code int) {
	// The outer half of the no-anonymous-crash guarantee. The per-file loop
	// recovers its own panics with a file and a stage to name (see
	// transformFileToTypeScript); everything AROUND it — the dependency scan,
	// driver.LoadProgram, the linked-plugin handoff, the envelope encode — has no
	// file to attribute a crash to, so a panic there lands here and is reported
	// against the host itself. It is still a named, prefixed report with a stack
	// rather than a bare runtime trace, and it exits non-zero rather than dying.
	defer func() {
		rec := recover()
		if rec == nil {
			return
		}
		fmt.Fprintf(
			stderr,
			"%s: %s: panicked outside the per-file transform loop: %v\n\n%s\n",
			host.Name,
			hostPanicCode,
			rec,
			debug.Stack(),
		)
		code = 3
	}()
	if len(args) == 0 {
		return runTransform(host, nil)
	}
	switch args[0] {
	case "-h", "--help", "help":
		fmt.Fprintf(stdout, "%s - single owner ttsc transform host\n", host.Name)
		return 0
	case "-v", "--version", "version":
		fmt.Fprintf(stdout, "%s dev\n", host.Name)
		return 0
	case "transform", "check", "build":
		// Strip the subcommand token so the flag parser sees the flags that
		// follow it. ttsc drives an emitting build via the `build` subcommand
		// (source-to-source hosts still answer it with the envelope on stdout);
		// leaving "build" in front of the flags makes flag.Parse stop at that
		// positional and silently drop every flag after it — including
		// --plugins-json, which selection depends on.
		return runTransform(host, args[1:])
	default:
		return runTransform(host, args)
	}
}

func runTransform(host Host, args []string) int {
	fs := flag.NewFlagSet("transform", flag.ContinueOnError)
	fs.SetOutput(stderr)
	_ = fs.String("file", "", "single file (unused: whole-project envelope only)")
	tsconfigPath := fs.String("tsconfig", "tsconfig.json", "tsconfig.json owning the project")
	cwdOverride := fs.String("cwd", "", "override the working directory")
	_ = fs.String("out", "", "unused: single-file output path")
	_ = fs.String("rewrite-mode", "", "unused: native rewrite backend id")
	_ = fs.String("output", "ts", "unused: single-file output kind")
	// The --plugins-json manifest ttsc fills from a tsconfig `plugins` list no
	// longer drives selection (W7: the whole stage table is always on). It is
	// still accepted (and ignored) so ttsc's forwarded flag parses cleanly.
	_ = fs.String("plugins-json", "", "ttsc plugin manifest (accepted, unused: every stage is always on)")
	if err := fs.Parse(filterKnownArgs(args)); err != nil {
		return 2
	}

	cwd := *cwdOverride
	if cwd == "" {
		var derr error
		cwd, derr = os.Getwd()
		if derr != nil {
			fmt.Fprintf(stderr, "%s: cwd: %v\n", host.Name, derr)
			return 2
		}
	}

	// §100 declare-by-depending: ONE workspace dependency scan yields the inline
	// BODIES to substitute at this consumer's call sites. It no longer selects
	// stages — every stage is always on — but it still decides which sugar bodies
	// are in play, threaded into the inline stage so the walk runs exactly once.
	scan, scanErr := inlinetransform.CollectProject(cwd)
	if scanErr != nil {
		fmt.Fprintf(stderr, "%s: dependency scan: %v\n", host.Name, scanErr)
		return 2
	}

	// How this project spells the types typefor derives. It rides the project's
	// own package.json, never the shared descriptor every consumer dedupes to one
	// spawn — so two consumers of the same host can disagree.
	emission, emissionErr := readEmission(cwd)
	if emissionErr != nil {
		fmt.Fprintf(stderr, "%s: %v\n", host.Name, emissionErr)
		return 2
	}

	// No selection: the whole stage table runs on every file. A stage that matches
	// nothing in this program is a cheap no-op (disjoint match sets), and a program
	// with no sugar and no matching source simply emits unchanged — a legitimate
	// outcome, never a NO_STAGES error (the old selection premise is gone, W7).
	selected := host.Stages

	prog, diags, err := driver.LoadProgram(cwd, *tsconfigPath, driver.LoadProgramOptions{ForceEmit: true})
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", host.Name, err)
		return 2
	}
	if len(diags) > 0 {
		driver.WritePrettyDiagnostics(stderr, diags, cwd)
		return 2
	}
	defer prog.Close()

	// Run any foreign transforms linked into this host through ttsc's own driver
	// machinery (source preamble + program mutation), matching what the driver
	// does before its emit. LoadProgram already primed the linked state from the
	// TTSC_LINKED_PLUGINS_JSON env; this applies it deterministically and
	// surfaces any error rather than swallowing it.
	if err := prog.ApplyLinkedPlugins(); err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", host.Name, err)
		return 2
	}

	ctx := plugin.NewContext(prog, cwd)
	out := projectEnvelope{
		Diagnostics: []envelopeDiagnostic{},
		TypeScript:  map[string]string{},
	}
	hasError := false
	emit := func(d Diag) {
		out.Diagnostics = append(out.Diagnostics, envelopeFromDiag(d))
		if !d.Warning {
			hasError = true
		}
	}
	// Route the token core's hard derivation diagnostics (a type reachable only
	// through a non-barrel, non-private export subpath) into the envelope as errors.
	ctx.Diag = func(file string, start int, code, message string) {
		emit(DiagFromPlugin(plugin.Diagnostic{File: file, Start: start, Code: code, Message: message}))
	}

	// The Go host type-checks the whole consumer program to run its stages —
	// tsgo's checker runs regardless — but with noEmitOnError left off (the host
	// always emits, see ForceEmit above) those diagnostics were never carried
	// into the envelope. Collecting them once, program-wide, here surfaces the
	// program's own ordinary TypeScript errors (a broken declare-module merge,
	// a bad call, …) alongside this host's stage diagnostics, rather than
	// silently dropping them while the program still "builds".
	for _, d := range prog.Diagnostics() {
		if !d.IsError() {
			continue
		}
		emit(DiagFromTypeScript(d))
	}

	artifacts := inlinetransform.NewArtifacts()
	env := &Env{Cwd: cwd, Artifacts: artifacts, Bodies: scan.Bodies}
	var roots emitRoots
	if emission == EmissionHoisted {
		roots = resolveEmitRoots(prog, cwd)
		env.Hoist = &typefortransform.Hoist{Registry: typeforhoist.NewRegistry(typeemit.HoistRef()), SourceRoot: roots.source}
	}

	// Build every selected stage into its FileTransform. The WHOLE table runs
	// under the fixed-point loop — mergesynth included, since the inline stage
	// mints install calls mid-loop that mergesynth must re-see.
	tracker := &phaseTracker{}
	loop := make([]plugin.FileTransform, 0, len(selected))
	for _, stage := range selected {
		loop = append(loop, tracker.watch(stage.Name, stage.Build(prog, ctx, env, emit)))
	}

	for _, sf := range prog.SourceFiles() {
		if sf.IsDeclarationFile {
			continue
		}
		key := sourceFileKey(cwd, filepath.ToSlash(sf.FileName()))
		if filepath.IsAbs(key) || key == ".." || strings.HasPrefix(key, "../") {
			continue
		}
		lowered, survived := transformFileToTypeScript(prog, loop, sf, artifacts, emit, tracker)
		if !survived {
			// ABORT THE WHOLE RUN on the first panicking file rather than
			// reporting it and lowering the rest.
			//
			// Why abort: the panic escaped the SHARED typescript-go checker, which
			// every remaining file's stages go on to query. A panic unwinds straight
			// past the checker's own bookkeeping (its type-resolution stack is
			// pushed and popped around each resolution, and the pop is skipped),
			// so from here on its memo tables and resolution state are in an
			// indeterminate condition. A lowering derived from a checker in that
			// state is not trustworthy, and silently-wrong lowered output is a far
			// worse failure than no output — parity with the hand-written form is
			// the whole contract. The run already fails (the panic diagnostic is a
			// hard error), so continuing would only manufacture more diagnostics of
			// unknown quality on top of the one that actually matters.
			break
		}
		out.TypeScript[key] = lowered
	}

	// The const table is complete only once every file has contributed, so the
	// generated module is written after the loop — and never when a stage already
	// failed, since a half-derived table would describe a program that was not
	// emitted.
	if env.Hoist != nil && !hasError {
		if err := writeHoistedModule(env.Hoist.Registry, roots); err != nil {
			fmt.Fprintf(stderr, "%s: %v\n", host.Name, err)
			return 3
		}
	}

	if err := json.NewEncoder(stdout).Encode(out); err != nil {
		fmt.Fprintf(stderr, "%s: encode output: %v\n", host.Name, err)
		return 3
	}
	if hasError {
		return 3
	}
	return 0
}

// knownValueFlags names the flags this host reads, each of which takes a value.
// Every other flag ttsc forwards to a native host (--emit, --quiet, --verbose,
// --outDir, --tsgo-args, threading/diagnostics knobs) is not ours to interpret.
var knownValueFlags = map[string]bool{
	"file":         true,
	"tsconfig":     true,
	"cwd":          true,
	"out":          true,
	"rewrite-mode": true,
	"output":       true,
	"plugins-json": true,
}

// filterKnownArgs keeps only this host's own flags (with their values, inline or
// space-separated) and drops every other flag ttsc forwards, so the strict Go
// flag parser does not reject an unknown one like `--quiet`. It mirrors the
// reference sidecar's filterHostArgs: an unknown flag is dropped, and a trailing
// bare value it might carry is consumed only when the next token is not itself a
// flag. The subcommand token is already stripped by the router.
func filterKnownArgs(args []string) []string {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		current := args[i]
		if current == "--" {
			break
		}
		if !strings.HasPrefix(current, "-") {
			continue
		}
		name, hasInlineValue := flagBase(current)
		if knownValueFlags[name] {
			out = append(out, current)
			if !hasInlineValue && i+1 < len(args) {
				i++
				out = append(out, args[i])
			}
			continue
		}
		if !hasInlineValue && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
			i++
		}
	}
	return out
}

// flagBase strips leading dashes from a flag token and reports whether it
// carries an inline `=value`, returning the bare flag name.
func flagBase(arg string) (string, bool) {
	name := strings.TrimLeft(arg, "-")
	before, _, found := strings.Cut(name, "=")
	return before, found
}

// maxLoopPasses bounds the fixed-point loop. Each sugar chain peels one layer per
// pass, so a real file settles in a handful of passes (a 3-deep registration chain
// takes 3); 16 is a generous ceiling far above any legitimate chain depth. Hitting
// it means a stage is NOT identity-preserving on a no-op (it rebuilds the tree
// every pass, so the loop can never observe a fixed point) or two stages are
// rewriting the same node back and forth — either way an engine bug, surfaced
// LOUDLY as a per-file FIXED_POINT_EXHAUSTED error rather than a silent cap or an
// infinite spin.
const maxLoopPasses = 16

// phaseTracker names what the per-file pipeline is doing RIGHT NOW, so the
// recover in transformFileToTypeScript can say which stage crashed. A panic
// unwinds past every local variable, so the answer has to live somewhere the
// deferred function can still read — this value, owned by the run and
// overwritten step by step.
type phaseTracker struct {
	phase string
}

// watch wraps one built stage transform so the tracker records the stage's name
// for the duration of its run. Wrapping at build time (rather than naming the
// stage inside the loop) keeps plugin.RunToFixedPoint's contract untouched: it
// still takes bare FileTransforms and knows nothing about diagnostics.
func (t *phaseTracker) watch(name string, transform plugin.FileTransform) plugin.FileTransform {
	return func(ec *shimprinter.EmitContext, sf *shimast.SourceFile) *shimast.SourceFile {
		t.phase = "stage " + name
		return transform(ec, sf)
	}
}

// transformFileToTypeScript lowers one file to its fixed point in a single
// EmitContext and prints the result back as TypeScript for the ttsc host to
// type-strip. It returns the lowered source and whether the file SURVIVED — a
// false second result means a panic was recovered and reported, and the caller
// must abandon the run.
//
// PANIC RECOVERY. Every stage queries the shared typescript-go checker, and the
// checker nil-derefs on some synthetic nodes a prior pass minted (it expects a
// bound symbol on every object-literal element, and a node the parser never saw
// has none). Without recovery that reaches the user as a bare Go stack trace
// naming no file and no stage — the single least actionable failure this engine
// can produce. So the whole per-file pipeline runs under a recover that reports
// the SOURCE FILE, the phase (which stage, or the sweep / the print), the
// recovered value, and the stack as one ordinary hard diagnostic, and the run
// fails cleanly through the envelope instead of dying. It is an engine bug every
// time, never a user error, but the user is the one who has to report it.
//
// Every stage — mergesynth included — runs under RunToFixedPoint: the whole
// set, back to back, until a full pass changes nothing. Mergesynth sits in the
// loop because the registerAugmentations authoring sugar's inline body EMITS
// the install call it must rewrite, so the install's final shape is minted
// mid-loop; it settles because a call it already rewrote reads as fully
// covered (its strategyNames recurses through the spread its own rewrite
// emits) and comes back untouched. Change detection is pointer identity (every
// stage returns the identical *SourceFile on a no-op). Only after the loop settles
// does the emit sweep run (tripwire 2) — once, over the fully-lowered, fully-
// parented output — so a synthetic node can walk to a positioned ancestor.
func transformFileToTypeScript(
	prog *driver.Program,
	loop []plugin.FileTransform,
	sf *shimast.SourceFile,
	artifacts *inlinetransform.Artifacts,
	emit Sink,
	tracker *phaseTracker,
) (lowered string, survived bool) {
	file := filepath.ToSlash(sf.FileName())
	defer func() {
		rec := recover()
		if rec == nil {
			return
		}
		// debug.Stack() inside a deferred function of a panicking call still
		// carries the frames the panic came from, so this is the crash site's
		// stack — the trace the anonymous failure used to print, now attached to
		// the file and stage that produced it.
		emit(Diag{
			File: file,
			Code: stagePanicCode,
			Message: fmt.Sprintf(
				"the transform host panicked while lowering this file, during %s: %v\n\n%s",
				tracker.phase,
				rec,
				debug.Stack(),
			),
		})
		lowered, survived = "", false
	}()

	// A starting phase so the report is never blank: a host with an empty stage
	// table reaches the sweep and the print without watch ever firing.
	tracker.phase = "the transform stage table"

	options := prog.TSProgram.Options()
	ec := shimprinter.NewEmitContext()
	result := sf

	var exhausted bool
	result, _, exhausted = plugin.RunToFixedPoint(ec, loop, result, maxLoopPasses)
	if exhausted {
		emit(Diag{
			File:    filepath.ToSlash(sf.FileName()),
			Code:    "FIXED_POINT_EXHAUSTED",
			Message: fmt.Sprintf("the transform loop did not reach a fixed point after %d passes — the file still changes on every pass. A stage is likely not identity-preserving on a no-op (it rebuilds the tree each pass), or two stages are rewriting the same node back and forth. This is an engine bug, not a user error.", maxLoopPasses),
		})
	}

	if artifacts != nil && artifacts.Active {
		tracker.phase = "the inline emit sweep"
		for _, d := range inlinetransform.Sweep(result, artifacts) {
			emit(DiagFromPlugin(d))
		}
	}
	tracker.phase = "printing the lowered file"
	writer := shimprinter.NewTextWriter(options.NewLine.GetNewLineCharacter(), 0)
	printer := shimprinter.NewPrinter(shimprinter.PrinterOptions{NewLine: options.NewLine}, shimprinter.PrintHandlers{}, ec)
	printer.Write(result.AsNode(), result, writer, nil)
	return writer.String(), true
}

type projectEnvelope struct {
	Diagnostics []envelopeDiagnostic `json:"diagnostics,omitempty"`
	TypeScript  map[string]string    `json:"typescript"`
}

type envelopeDiagnostic struct {
	File        *string `json:"file"`
	Category    string  `json:"category"`
	Code        string  `json:"code"`
	Line        *int    `json:"line,omitempty"`
	Character   *int    `json:"character,omitempty"`
	MessageText string  `json:"messageText"`
}

// envelopeFromDiag converts a stage Diag into its envelope form.
func envelopeFromDiag(d Diag) envelopeDiagnostic {
	category := categoryError
	if d.Warning {
		category = categoryWarning
	}
	return envelopeDiagnostic{
		File:        filePointer(d.File),
		Category:    category,
		Code:        d.Code,
		Line:        d.Line,
		Character:   d.Character,
		MessageText: d.Message,
	}
}

func filePointer(file string) *string {
	if file == "" {
		return nil
	}
	normalized := filepath.ToSlash(file)
	return &normalized
}

func sourceFileKey(cwd, file string) string {
	rel, err := filepath.Rel(cwd, filepath.FromSlash(file))
	if err != nil {
		return filepath.ToSlash(file)
	}
	return filepath.ToSlash(rel)
}
