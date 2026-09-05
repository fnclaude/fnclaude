package inlinetransform

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// rhombusStdSchemaID is the schema's own "$id" — the resource URL it is
// registered and compiled under.
const rhombusStdSchemaID = "https://github.com/fnioc/std/releases/latest/download/rhombus-std.schema.json"

//go:embed rhombus-std.schema.json
var rhombusStdSchemaBytes []byte

var (
	rhombusStdSchemaOnce sync.Once
	rhombusStdSchema     *jsonschema.Schema
	rhombusStdSchemaErr  error
)

// compiledConfigSchema compiles the embedded rhombus-std.schema.json once and
// caches the result. A malformed embed (a build-time invariant, never an
// authoring mistake) fails every call rather than panicking mid-resolve.
func compiledConfigSchema() (*jsonschema.Schema, error) {
	rhombusStdSchemaOnce.Do(func() {
		var doc any
		if err := json.Unmarshal(rhombusStdSchemaBytes, &doc); err != nil {
			rhombusStdSchemaErr = fmt.Errorf("inline: embedded rhombus-std.schema.json is malformed: %w", err)
			return
		}
		compiler := jsonschema.NewCompiler()
		if err := compiler.AddResource(rhombusStdSchemaID, doc); err != nil {
			rhombusStdSchemaErr = fmt.Errorf("inline: registering the rhombus-std config schema: %w", err)
			return
		}
		sch, err := compiler.Compile(rhombusStdSchemaID)
		if err != nil {
			rhombusStdSchemaErr = fmt.Errorf("inline: compiling the rhombus-std config schema: %w", err)
			return
		}
		rhombusStdSchema = sch
	})
	return rhombusStdSchema, rhombusStdSchemaErr
}

// validateConfigNode validates v — one resolved rhombus-std config node —
// against schema/rhombus-std.schema.json, tagging a failure with source (the
// file, package.json marker, or resolved-config label it came from) and the
// JSON path the schema's own error already carries.
func validateConfigNode(v any, source string) error {
	sch, err := compiledConfigSchema()
	if err != nil {
		return err
	}
	if verr := sch.Validate(v); verr != nil {
		return fmt.Errorf("INLINE_CONFIG_SCHEMA: %s does not match the rhombus-std config schema: %w", source, verr)
	}
	return nil
}
