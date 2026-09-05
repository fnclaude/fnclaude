package plugin

import (
	"os"
	"regexp"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/fnioc/std/transforms/internal/tokens"
	"github.com/fnioc/std/transforms/internal/tokentext"
)

var moduleExtStem = regexp.MustCompile(`\.[mc]?tsx?$`)

// NewContext builds the token-derivation context for a loaded program: the
// checker, the project root (rootDir when set, else the working directory), a
// stem index resolving each export entry's on-disk target to the declaration
// file the program loaded, the default-lib predicate, and a package.json reader.
func NewContext(prog *driver.Program, cwd string) *tokens.Context {
	options := prog.TSProgram.Options()
	projectRoot := cwd
	if options.RootDir != "" {
		projectRoot = tokentext.Normalize(options.RootDir)
	}

	// Index every source file by its extension-stripped path; a .d.ts outranks a
	// .ts, which outranks a .js, at the same stem — that's the module whose
	// exports package-public detection reads. This MUST span declaration files
	// too (external node_modules types), so it reads the program's full file
	// list, not the transform-only (non-declaration) view.
	byStem := map[string]*shimast.SourceFile{}
	rank := func(name string) int {
		switch {
		case len(name) > 5 && name[len(name)-5:] == ".d.ts":
			return 3
		case moduleExtStem.MatchString(name):
			return 2
		default:
			return 1
		}
	}
	for _, sf := range prog.TSProgram.GetSourceFiles() {
		name := tokentext.Normalize(sf.FileName())
		stem := tokentext.StripExt(name)
		if existing, ok := byStem[stem]; !ok || rank(name) >= rank(tokentext.Normalize(existing.FileName())) {
			byStem[stem] = sf
		}
	}

	return &tokens.Context{
		Checker:     prog.Checker,
		ProjectRoot: projectRoot,
		ReadFile: func(path string) (string, bool) {
			data, err := os.ReadFile(path)
			if err != nil {
				return "", false
			}
			return string(data), true
		},
		SourceFileAtStem: func(stem string) *shimast.SourceFile {
			return byStem[stem]
		},
		IsDefaultLib: func(sf *shimast.SourceFile) bool {
			return prog.TSProgram.IsSourceFileDefaultLibrary(sf.Path())
		},
	}
}
