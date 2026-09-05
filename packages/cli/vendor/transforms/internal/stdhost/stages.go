package stdhost

import (
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/fnioc/std/transforms/internal/inlinetransform"
	"github.com/fnioc/std/transforms/internal/mergesynthtransform"
	"github.com/fnioc/std/transforms/internal/plugin"
	"github.com/fnioc/std/transforms/internal/schemaoftransform"
	"github.com/fnioc/std/transforms/internal/tokens"
	"github.com/fnioc/std/transforms/internal/typefortransform"
)

// stagePrefix namespaces each stage's internal name (e.g. "rhombusstd_typefor").
// The names are host-internal identifiers used to label diagnostics — not
// selectors: the whole stage table always runs.
const stagePrefix = "rhombusstd_"

// BaseStages is the fixed execution order every base stage runs in. There is no
// selection — the host runs this whole table on every file; a stage that matches
// nothing is a cheap no-op (disjoint match sets).
// Every stage is a DOMAIN-AGNOSTIC primitive: a family's own authoring forms are
// inline sugar bodies the inline stage substitutes, and the primitives transform
// what those bodies leave behind under the fixed-point loop. Order:
//
// inline first (so single-expression sugar bodies are substituted before any
// primitive stage runs), then mergesynth (it reads the ORIGINAL augmentation
// member declarations through the checker and threads a plain-JS merge-strategies
// object as the third argument of each registerAugmentations/applyAugmentations
// call — it runs before typefor so typefor still lowers the call's type argument,
// and later stages leave the synthesized object untouched), then typefor (the
// structured `Type.*` lowering of `typefor<T>()` / `typefor(value)`, including
// the inline stage's synthetic typefor calls and a constructor's or factory's
// dependency-signature derivation), then schemaof (the structural expansion of
// `schemaof<T>()` into the `Type` tree describing T). All stages own DISJOINT
// match sets, so correctness never depends on this order — it is fixed only for
// reproducible output.
//
// Returned as a fresh slice each call so a caller can reorder or extend it
// without mutating shared state.
func BaseStages() []Stage {
	return []Stage{
		{Name: stagePrefix + "inline", Build: buildInline},
		{Name: stagePrefix + "mergesynth", Build: buildMergesynth},
		{Name: stagePrefix + "typefor", Build: buildTypefor},
		{Name: stagePrefix + "schemaof", Build: buildSchemaof},
	}
}

// buildInline activates the generic single-expression inline stage. It collects
// the workspace publish list, substitutes matched sugar bodies, and registers
// the synthetic primitive calls a downstream primitive stage lowers. Every
// diagnostic it raises is a hard error.
func buildInline(prog *driver.Program, _ *tokens.Context, env *Env, emit Sink) plugin.FileTransform {
	return inlinetransform.Build(prog, env.Bodies, env.Artifacts, func(d plugin.Diagnostic) {
		emit(DiagFromPlugin(d))
	})
}

// buildMergesynth activates the merge-strategy synthesizer. It runs in the
// fixed-point loop like every other stage: the registerAugmentations authoring
// sugar's inline body EMITS the install call it rewrites, so its work can be
// minted mid-loop, and a call it already rewrote comes back untouched (the
// settle condition). It sits ahead of the loop's typefor pass, so typefor
// still lowers each install call's type argument. It reads the ORIGINAL
// augmentation member declarations through the checker and threads a plain-JS
// strategies object as the third argument of each
// registerAugmentations/applyAugmentations call, so a member-name collision
// dispatches by argument shape instead of throwing. The synthesized guards are
// inlined plain JS (the typia embed is fully lowered at build time — no typia
// runtime import survives). It is category-aware: an advisory warning (a
// dropped guard that would have needed a typia runtime helper) never fails the
// emit.
func buildMergesynth(prog *driver.Program, _ *tokens.Context, _ *Env, emit Sink) plugin.FileTransform {
	return mergesynthtransform.New(prog, func(d mergesynthtransform.Diagnostic) {
		emit(Diag{
			File:    d.File,
			Warning: d.Category == mergesynthtransform.Warning,
			Code:    d.Code,
			Message: d.Message,
		})
	})
}

// buildTypefor activates the typefor primitive stage. It lowers each
// `typefor<T>()` / `typefor(value)` to the `Type.*` factory tree its argument
// derives, folding an immediate known-accessor property access (`.instance`,
// `.return`, `.args`, `.value`, `.tag`, `.type`, `.kind`) through to the
// surviving sub-tree. Where that tree LANDS is the project's choice
// (Env.Hoist): in one generated module of named consts the call site references,
// or at the call site itself. Its own diagnostics are hard errors.
func buildTypefor(prog *driver.Program, ctx *tokens.Context, env *Env, emit Sink) plugin.FileTransform {
	return typefortransform.New(prog, ctx, env.Artifacts, env.Hoist, func(d plugin.Diagnostic) {
		emit(DiagFromPlugin(d))
	})
}

// buildSchemaof activates the `schemaof<T>()` primitive stage. It expands each
// schemaof call — the inline `.withType<T>()` body's synthetic call and any
// source-written one — into the runtime `Type` tree describing T's structure,
// materializing the `Type` value-import the tree is spelled through. A member
// that stops at a name, literal, or nullish singleton lands where typefor's own
// derivations do (Env.Hoist): in the project's shared const table, or at the
// call site itself; the object/tuple/union structure this stage composes around
// such a member is always spelled at the call site. On a member the Type grammar
// cannot spell, or a non-object root, it reports the targeted
// 992001/992002/992003 (a hard error) and leaves the call un-lowered — the sweep
// defers the surviving-primitive diagnostic to it.
func buildSchemaof(prog *driver.Program, ctx *tokens.Context, env *Env, emit Sink) plugin.FileTransform {
	return schemaoftransform.New(prog, ctx, env.Artifacts, env.Hoist, func(d plugin.Diagnostic) {
		emit(DiagFromPlugin(d))
	})
}
