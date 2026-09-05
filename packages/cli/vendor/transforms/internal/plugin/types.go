// Package plugin holds the two pieces of shared per-file transform plumbing the
// owner host (internal/stdhost) builds on: the FileTransform contract every stage
// implements, the Diagnostic value a stage emits, the token-derivation Context
// builder (context.go), and the fixed-point loop runner (loop.go).
//
// There is ONE host binary now — cmd/ttsc-std, driven by internal/stdhost — so the
// former per-sidecar command dispatch (Run/runTransform/envelope) that used to live
// here is gone; stdhost owns program loading, the envelope, and printing. This
// package is reduced to the reusable transform primitives stdhost composes.
package plugin

import (
	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
)

// FileTransform rewrites one source file inside a shared EmitContext, returning
// the rewritten file (or the input unchanged). It is the only stage-specific
// piece; the loop and the host own everything around it.
type FileTransform func(ec *shimprinter.EmitContext, sf *shimast.SourceFile) *shimast.SourceFile

// Diagnostic is a transform diagnostic destined for the host's envelope. Code is
// the stable string diagnostic code; File is an absolute path (empty when
// unknown).
type Diagnostic struct {
	File    string
	Start   int
	Code    string
	Message string
}
