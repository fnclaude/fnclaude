package tokentext

import "strings"

// ParsedToken is a closed-generic token split into its base and top-level args.
type ParsedToken struct {
	Base string
	Args []string
}

// ParseToken splits a closed-generic token into its base and top-level args, or
// returns ok=false for a non-generic token (no top-level `<`) and for malformed
// input (empty base, unbalanced brackets, empty arg, trailing text, unterminated
// quote). Depth-tracked and quote-aware for double quotes (backslash escapes
// honored), so literal-type args like `"a,b" | "<c>"` split correctly.
func ParseToken(token string) (ParsedToken, bool) {
	open := strings.IndexByte(token, '<')
	if open <= 0 {
		return ParsedToken{}, false
	}
	base := token[:open]
	if strings.ContainsAny(base, ">\"") {
		return ParsedToken{}, false
	}
	args := []string{}
	depth := 1
	inQuote := false
	argStart := open + 1
	for i := open + 1; i < len(token); i++ {
		ch := token[i]
		if inQuote {
			if ch == '\\' {
				i++
			} else if ch == '"' {
				inQuote = false
			}
			continue
		}
		switch ch {
		case '"':
			inQuote = true
		case '<':
			depth++
		case '>':
			depth--
			if depth == 0 {
				if i != len(token)-1 {
					return ParsedToken{}, false
				}
				last := token[argStart:i]
				if last == "" {
					return ParsedToken{}, false
				}
				args = append(args, last)
				return ParsedToken{Base: base, Args: args}, true
			}
		case ',':
			if depth == 1 {
				arg := token[argStart:i]
				if arg == "" {
					return ParsedToken{}, false
				}
				args = append(args, arg)
				argStart = i + 1
			}
		}
	}
	return ParsedToken{}, false
}

// IsOpenToken reports whether token contains a hole (`$N`) at any depth — i.e. it
// is an open template rather than a resolvable token. Grammar-aware: a `$N`
// inside a quoted literal arg is not a hole.
func IsOpenToken(token string) bool {
	if isGenericNode(token) {
		return true
	}
	parsed, ok := ParseToken(token)
	if !ok {
		return false
	}
	for _, arg := range parsed.Args {
		if IsOpenToken(arg) {
			return true
		}
	}
	return false
}

// isGenericNode reports whether token is exactly a hole node `$N` with decimal
// N >= 1 (no leading zero).
func isGenericNode(token string) bool {
	if len(token) < 2 || token[0] != '$' {
		return false
	}
	if token[1] < '1' || token[1] > '9' {
		return false
	}
	for i := 2; i < len(token); i++ {
		if token[i] < '0' || token[i] > '9' {
			return false
		}
	}
	return true
}
