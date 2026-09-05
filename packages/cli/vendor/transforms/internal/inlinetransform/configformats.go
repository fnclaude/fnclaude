package inlinetransform

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	toml "github.com/pelletier/go-toml/v2"
	yaml "gopkg.in/yaml.v3"
)

// parseConfigFile reads path's already-loaded data and parses it into the
// canonical JSON data model (map[string]any / []any / string / float64 /
// bool / nil), picking a parser by extension: .yaml/.yml is YAML, .toml is
// TOML, and everything else — including .json and no extension — is JSON,
// the format every rhombus-std config file used before "extends" could name
// a sibling in another format. A present-but-unparseable file, an
// unresolvable YAML anchor cycle, or a top level that isn't an object are all
// loud INLINE_ENTRY_IMPORT errors.
func parseConfigFile(path string, data []byte) (map[string]any, error) {
	var (
		decoded any
		err     error
	)
	switch strings.ToLower(filepath.Ext(path)) {
	case ".yaml", ".yml":
		decoded, err = parseYAML(data)
	case ".toml":
		decoded, err = parseTOML(data)
	default:
		err = json.Unmarshal(data, &decoded)
	}
	if err != nil {
		return nil, fmt.Errorf("INLINE_ENTRY_IMPORT: malformed %s: %w", path, err)
	}
	obj, ok := decoded.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("INLINE_ENTRY_IMPORT: %s must resolve to an object", path)
	}
	return obj, nil
}

// parseYAML decodes data as YAML, rejecting a self-referential anchor/alias
// cycle before it can recurse without bound, then normalizes the result
// (normalizeParsed) onto the canonical JSON data model.
func parseYAML(data []byte) (any, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	if err := checkYAMLCycle(&doc, map[*yaml.Node]bool{}); err != nil {
		return nil, err
	}
	var decoded any
	if err := doc.Decode(&decoded); err != nil {
		return nil, err
	}
	return normalizeParsed(decoded), nil
}

// checkYAMLCycle walks node's content depth-first, following an alias to its
// target as if inlined there, and fails the moment a target is already on the
// current path — the one shape yaml.v3's own Decode would otherwise recurse
// into without bound.
func checkYAMLCycle(node *yaml.Node, path map[*yaml.Node]bool) error {
	target := node
	if node.Kind == yaml.AliasNode {
		target = node.Alias
	}
	if target == nil {
		return nil
	}
	if path[target] {
		return fmt.Errorf("anchor cycle at %q", target.Value)
	}
	path[target] = true
	defer delete(path, target)
	for _, child := range target.Content {
		if err := checkYAMLCycle(child, path); err != nil {
			return err
		}
	}
	return nil
}

// parseTOML decodes data as TOML and normalizes the result (normalizeParsed)
// onto the canonical JSON data model — TOML's native datetime/date/time types
// have no JSON counterpart and its integers are a distinct Go type from
// JSON's own float64 numbers.
func parseTOML(data []byte) (any, error) {
	var decoded any
	if err := toml.Unmarshal(data, &decoded); err != nil {
		return nil, err
	}
	return normalizeParsed(decoded), nil
}

// normalizeParsed recursively coerces a YAML- or TOML-decoded value onto the
// canonical JSON data model — map[string]any and []any structurally, string/
// bool/nil/float64 as scalars, the same shape encoding/json.Unmarshal
// produces — so every format validates and merges identically from here on.
// A YAML map key that decoded as a non-string scalar is forced to its string
// form; a TOML/YAML temporal value renders as RFC3339 (an offset datetime) or
// the equivalent ISO 8601 date/time-only text (a local, offset-less TOML
// value), verbatim from its own String() method; every integer width widens
// to float64 alongside JSON's own single number type.
func normalizeParsed(v any) any {
	switch val := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(val))
		for k, sub := range val {
			out[k] = normalizeParsed(sub)
		}
		return out
	case map[any]any:
		out := make(map[string]any, len(val))
		for k, sub := range val {
			out[fmt.Sprint(k)] = normalizeParsed(sub)
		}
		return out
	case []any:
		out := make([]any, len(val))
		for i, sub := range val {
			out[i] = normalizeParsed(sub)
		}
		return out
	case time.Time:
		return val.Format(time.RFC3339Nano)
	case toml.LocalDate:
		return val.String()
	case toml.LocalTime:
		return val.String()
	case toml.LocalDateTime:
		return val.String()
	case int:
		return float64(val)
	case int64:
		return float64(val)
	case uint64:
		return float64(val)
	case float32:
		return float64(val)
	default:
		return val
	}
}
