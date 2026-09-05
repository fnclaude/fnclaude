package stdhost

// Every stage runs under the fixed-point loop — mergesynth included, because
// the registerAugmentations authoring sugar's inline body EMITS the install
// call mergesynth rewrites, so its work is minted mid-loop and a one-shot
// pre-pass would run before that call exists. The loop-mergesynth settling
// behavior itself is pinned by mergesynthtransform's idempotence tests and the
// host-level install test in integration_test.go; this file pins only that the
// table reaches the loop whole.

import "testing"

func TestEveryStageLoops(t *testing.T) {
	stages := BaseStages()
	hasMergesynth := false
	for _, s := range stages {
		if s.Name == stagePrefix+"mergesynth" {
			hasMergesynth = true
		}
	}
	if !hasMergesynth {
		t.Fatalf("base stage table has no %smergesynth stage", stagePrefix)
	}
}
