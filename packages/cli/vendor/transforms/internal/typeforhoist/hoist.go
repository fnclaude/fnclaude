// Package typeforhoist is the project-wide const table behind typefor's HOISTED
// emission mode: instead of spelling a whole `Type.*` factory tree at every call
// site, each site emits a reference to a named const, and the consts live
// together in one generated module a build materializes beside the emitted
// files.
//
// The table is a DAG. A node is interned under a canonical key (see Node), so
// two call sites that derive the same type share one const, and a composite
// const references its member consts by name instead of re-spelling the subtree.
// Registry.Len therefore equals the number of `const` lines Module renders — the
// zero-redundancy guarantee, checkable by counting.
//
// The canonical key mirrors the runtime intern table's structural identity, so
// one const per key means one runtime `Type` object per const.
package typeforhoist

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ModuleBase is the generated module's basename, placed at the emit root so a
// call site reaches it by the same relative specifier in source space and in
// emit space. Everything about WHERE the module lands follows from this one
// name plus the emit root the host computes.
const ModuleBase = "__typefor__"

// ModuleFile is the generated module's filename on disk. It is plain JS: the
// module is build output that no program typechecks, and a JS specifier
// resolves identically for a bundler and for plain Node.
const ModuleFile = ModuleBase + ".js"

// nameHashLen is how many hex characters of a key's SHA-256 disambiguate a name
// whose readable part cannot be unique on its own. Forty bits is far past the
// point where a collision is credible for a project's node count, and the
// registry asserts uniqueness anyway rather than trusting the odds.
const nameHashLen = 10

// maxReadableLen bounds the readable part of a name, so a deeply-generic type
// does not produce a hundred-character identifier. A longer spelling keeps its
// TAIL, which is the type's own name.
const maxReadableLen = 40

// GlobalFrom is the FROM a name carries when the ambient scope declares it —
// the token grammar's own sentinel, which is why the flat spelling of such a
// type is the bare name with no qualifier. A node carrying it spells as
// `Type.global`, everything else as `Type.imported`.
const GlobalFrom = "global"

// Kind discriminates a Node's populated fields — one case per `Type` factory a
// derived typefor tree can spell.
type Kind int

const (
	// KindNamed is `Type.imported(name, from[, args])`, or `Type.global(name[,
	// args])` when the ambient scope declares it.
	KindNamed Kind = iota
	// KindLiteral is `Type.typeLiteral(value)`.
	KindLiteral
	// KindUnion is `Type.union(...members)`.
	KindUnion
	// KindTuple is `Type.tuple(...members)` — an ordered slot list, open-length
	// when it carries a rest slot, whose ORDER is part of the type where a
	// union's member order is not.
	KindTuple
	// KindGeneric is `Type.generic(label)` — an open-generic hole.
	KindGeneric
	// KindFunc is `Type.func(returns, signatures)`, signatures the slot node the
	// callable answers to.
	KindFunc
	// KindCtor is `Type.ctor(instance, signatures)` — the same slot shape as
	// KindFunc, headed by the instance type.
	KindCtor
	// KindAbstractCtor is `Type.abstractCtor(instance, signatures)` — the same
	// shape as KindCtor, for a construct signature coming from an `abstract class`
	// declaration. Its own kind rather than a flag on KindCtor, matching the
	// `Type` node contract's own `'ctor'`/`'abstract-ctor'` split.
	KindAbstractCtor
	// KindTag is `Type.tag(inner, key)`.
	KindTag
	// KindObject is `Type.object({ key: member, ... })` — a record of named
	// members, each keyed by its property name.
	KindObject
	// KindIntersection is `Type.intersection(...members)`.
	KindIntersection
	// KindUndefined and KindNull are the two nullish singletons, each its own
	// `Type.typeLiteral` call. They are kinds rather than literals because the
	// token grammar's literal values exclude them.
	KindUndefined
	KindNull
)

// Node is one derived type in the table: a small, printer-agnostic mirror of the
// tree the typefor stage derives, carrying the canonical key that IS its
// identity. Build one through the constructors below — each computes the key
// from its children's keys, so identity never depends on a node being walked
// twice the same way.
type Node struct {
	kind Kind
	key  string

	// name/from spell a KindNamed node; args are its closed generic arguments.
	name string
	from string
	args []*Node

	// sig is a KindFunc / KindCtor / KindAbstractCtor node's signatures slot —
	// a tuple or list node for a single signature, a union of those for an
	// overload set.
	sig *Node

	// literal is a KindLiteral node's value as its TypeScript expression text.
	literal string

	// members are a KindUnion's or a KindTuple's member nodes, in the order they
	// are emitted.
	members []*Node

	// tupleRest is a KindTuple's open length: a trailing rest slot's element
	// node, nil for a fixed-length tuple.
	tupleRest *Node

	// label is a KindGeneric's hole number as decimal text.
	label string

	// ret is a KindFunc's return type or a KindCtor's/KindAbstractCtor's
	// instance type.
	ret *Node

	// inner and tag spell a KindTag: the branded base and the key branded onto it.
	inner *Node
	tag   string

	// object are a KindObject's members, each a property name paired with its
	// type node, in declaration order.
	object []ObjectMember
}

// ObjectMember is one member of a KindObject node: a property name and its type.
type ObjectMember struct {
	Key  string
	Type *Node
}

// Key is the node's canonical identity — the string the registry interns on and
// derives its const name from.
func (n *Node) Key() string {
	return n.key
}

// Named builds a named-type node. from is the qualifying source, "global" for an
// unqualified name; args are the closed generic arguments in order.
func Named(name, from string, args []*Node) *Node {
	key := name
	if from != "global" {
		key = from + ":" + name
	}
	if len(args) != 0 {
		key += "<" + joinKeys(args, ",") + ">"
	}
	return &Node{kind: KindNamed, key: key, name: name, from: from, args: args}
}

// Literal builds a literal-type node from the value's TypeScript expression
// text — a quoted string, a numeric or bigint literal, or a boolean keyword.
func Literal(text string) *Node {
	return &Node{kind: KindLiteral, key: text, literal: text}
}

// Union builds a union node. The key sorts the members, matching how the
// runtime intern table identifies a union, so member order never fragments one
// type into two consts.
func Union(members []*Node) *Node {
	keys := make([]string, len(members))
	for i, m := range members {
		keys[i] = m.key
	}
	sort.Strings(keys)
	return &Node{kind: KindUnion, key: strings.Join(keys, " | "), members: members}
}

// Tuple builds a slot-list node. Where a union's key sorts its members, this
// one keeps the order given: two tuples over the same types in two orders are
// two types, and so two consts. rest states the tuple's open length, if any —
// an open tuple appends it to the key a fixed-length one keys by, so the two
// forms of one slot list intern as distinct consts.
func Tuple(members []*Node, rest *Node) *Node {
	key := "[" + joinKeys(members, ",") + "]"
	if rest != nil {
		key += "~" + rest.key
	}
	return &Node{kind: KindTuple, key: key, members: members, tupleRest: rest}
}

// Object builds a record node. The key sorts the members by name, matching how
// the runtime intern table identifies an object, so declaration order never
// fragments one type into two consts; the members are kept in the order given so
// the rendered const reads the way the call site derived it.
func Object(members []ObjectMember) *Node {
	entries := make([]string, len(members))
	for i, m := range members {
		entries[i] = strconv.Quote(m.Key) + ":" + m.Type.key
	}
	sort.Strings(entries)
	return &Node{kind: KindObject, key: "{" + strings.Join(entries, ",") + "}", object: members}
}

// Intersection builds an intersection node. Like a union, its key sorts the
// members so member order never fragments one type, while the members render in
// the order given.
func Intersection(members []*Node) *Node {
	keys := make([]string, len(members))
	for i, m := range members {
		keys[i] = m.key
	}
	sort.Strings(keys)
	return &Node{kind: KindIntersection, key: "(" + strings.Join(keys, " & ") + ")", members: members}
}

// Generic builds an open-generic hole node. label is the hole number's decimal
// text ("1" for $1).
func Generic(label string) *Node {
	return &Node{kind: KindGeneric, key: "$" + label, label: label}
}

// Func builds a call-signature node from its return type and signatures slot.
func Func(ret *Node, sig *Node) *Node {
	return &Node{kind: KindFunc, key: signatureKey("func", ret, sig), ret: ret, sig: sig}
}

// Ctor builds a construct-signature node from its instance type and signatures
// slot.
func Ctor(instance *Node, sig *Node) *Node {
	return &Node{kind: KindCtor, key: signatureKey("ctor", instance, sig), ret: instance, sig: sig}
}

// AbstractCtor builds a construct-signature node — instance type and
// signatures slot, exactly like Ctor — for a construct signature coming from an
// `abstract class` declaration. Its own method name in the key ("abstractCtor"
// vs "ctor") is what keeps a concrete and an abstract constructor sharing
// every other field interned to two distinct consts; no separate flag is
// needed.
func AbstractCtor(instance *Node, sig *Node) *Node {
	return &Node{kind: KindAbstractCtor, key: signatureKey("abstractCtor", instance, sig), ret: instance, sig: sig}
}

// Tag builds a keyed node — the branded base with the key composed into it.
func Tag(inner *Node, key string) *Node {
	return &Node{kind: KindTag, key: `#tag(` + inner.key + `,"` + key + `")`, inner: inner, tag: key}
}

// Undefined builds the `undefined` literal-type node.
func Undefined() *Node {
	return &Node{kind: KindUndefined, key: "#undefined"}
}

// Null builds the `null` literal-type node.
func Null() *Node {
	return &Node{kind: KindNull, key: "#null"}
}

// signatureKey spells a Func / Ctor / AbstractCtor key over the head's key and
// the slot's own. The leading `#` can only ever start a composite: a leaf's key
// starts with a quote (a string literal), a digit or sign (a number), or an
// identifier character. method itself is what keeps a concrete and an abstract
// constructor over the same shape apart — "ctor" vs "abstractCtor" — so no
// separate marker is needed.
func signatureKey(method string, ret *Node, sig *Node) string {
	return "#" + method + "(" + ret.key + ")(" + sig.key + ")"
}

func joinKeys(nodes []*Node, sep string) string {
	keys := make([]string, len(nodes))
	for i, n := range nodes {
		keys[i] = n.key
	}
	return strings.Join(keys, sep)
}

// TypeRef identifies the value every generated const is built through: the
// module the factories are exported from and the name they hang off. It is DATA
// the caller supplies — this package names no module of its own, so the const
// table and the call-site emission can never disagree about where `Type` comes
// from.
type TypeRef struct {
	Module string
	Export string
}

// Registry is one project's const table. It is not safe for concurrent use; the
// host runs its file loop on one goroutine.
type Registry struct {
	// typeRef is the factory namespace the rendered module imports and builds
	// every const through.
	typeRef TypeRef
	// byKey maps a canonical key to the interned node, so a second Ref of the
	// same type reuses the first node rather than adding a const.
	byKey map[string]*Node
	// names maps a canonical key to its const name, and keyOfName inverts it so a
	// collision is caught at the moment it would be introduced.
	names     map[string]string
	keyOfName map[string]string
	// order is the emission order: a node is appended only after its children,
	// so the rendered module reads top to bottom with no forward reference.
	order []*Node
}

// NewRegistry builds an empty table whose consts are spelled through typeRef.
func NewRegistry(typeRef TypeRef) *Registry {
	return &Registry{
		typeRef:   typeRef,
		byKey:     map[string]*Node{},
		names:     map[string]string{},
		keyOfName: map[string]string{},
	}
}

// Ref interns n and its children and returns the const name a call site
// references it by. The error is a name collision — two distinct types that
// would share one identifier — which is an engine failure, never a user error.
func (r *Registry) Ref(n *Node) (string, error) {
	if name, ok := r.names[n.key]; ok {
		return name, nil
	}
	for _, child := range n.children() {
		if _, err := r.Ref(child); err != nil {
			return "", err
		}
	}
	// The children may have interned this node's key along the way only if the
	// tree were cyclic, which it cannot be; re-check anyway so the invariant
	// "one append per key" holds unconditionally.
	if name, ok := r.names[n.key]; ok {
		return name, nil
	}
	name := nameFor(n.key)
	if owner, taken := r.keyOfName[name]; taken {
		return "", fmt.Errorf("TYPEFOR_HOIST_NAME_COLLISION: %q and %q both name the const %s", owner, n.key, name)
	}
	r.byKey[n.key] = n
	r.names[n.key] = name
	r.keyOfName[name] = n.key
	r.order = append(r.order, n)
	return name, nil
}

// Len is the number of distinct interned nodes — and so the number of consts
// Module renders.
func (r *Registry) Len() int {
	return len(r.order)
}

// children are the nodes a node's factory call takes as arguments, in emission
// order.
func (n *Node) children() []*Node {
	switch n.kind {
	case KindNamed:
		return n.args
	case KindUnion:
		return n.members
	case KindTuple:
		if n.tupleRest != nil {
			return append(append([]*Node{}, n.members...), n.tupleRest)
		}
		return n.members
	case KindFunc, KindCtor, KindAbstractCtor:
		if rows, fixed := fixedSlotRows(n.sig); fixed {
			out := []*Node{n.ret}
			for _, row := range rows {
				out = append(out, row...)
			}
			return out
		}
		return []*Node{n.ret, n.sig}
	case KindTag:
		return []*Node{n.inner}
	case KindObject:
		out := make([]*Node, 0, len(n.object))
		for _, member := range n.object {
			out = append(out, member.Type)
		}
		return out
	case KindIntersection:
		return n.members
	default:
		return nil
	}
}

// Module renders the generated module's source: the `Type` import, a header
// naming the scheme, then one const per interned node in dependency order.
// Returns "" when nothing was interned.
func (r *Registry) Module() string {
	if len(r.order) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(header)
	b.WriteString("import { " + r.typeRef.Export + " } from \"" + r.typeRef.Module + "\";\n\n")
	for _, n := range r.order {
		b.WriteString("export const " + r.names[n.key] + " = " + r.expr(n) + ";\n")
	}
	return b.String()
}

const header = `// Generated. Every derived type this project names, once each.
//
// A call site that derives a type references one of these consts instead of
// spelling the factory call inline, and a composite const references its member
// consts, so no subtree is written twice. The runtime interns structurally
// identical types to one object, so a const here and a hand-written
// Type.from("…") of the same spelling are the same object.
//
// A name is "$" plus the type's canonical spelling with every non-alphanumeric
// character replaced by "_", trimmed to its last 40 characters — the type's own
// name, since a spelling reads qualifier-first. A spelling that was entirely
// alphanumeric is unique on its own; anything else carries a short hash of the
// full spelling, so the name stays readable and still cannot collide.

`

// expr renders one node's `Type.*` factory call, referencing children by their
// const names.
func (r *Registry) expr(n *Node) string {
	switch n.kind {
	case KindLiteral:
		return r.typeRef.Export + ".typeLiteral(" + n.literal + ")"
	case KindUnion:
		return r.typeRef.Export + ".union(" + r.joinNames(n.members) + ")"
	case KindTuple:
		if n.tupleRest == nil {
			return r.typeRef.Export + ".tuple(" + r.joinNames(n.members) + ")"
		}
		return r.typeRef.Export + ".tuple({ members: [" + r.joinNames(n.members) + "], rest: " + r.names[n.tupleRest.key] + " })"
	case KindGeneric:
		return r.typeRef.Export + ".generic(\"" + n.label + "\")"
	case KindFunc:
		return r.signature(n, "func")
	case KindCtor:
		return r.signature(n, "ctor")
	case KindAbstractCtor:
		return r.signature(n, "abstractCtor")
	case KindTag:
		return r.typeRef.Export + ".tag(" + r.names[n.inner.key] + ", \"" + n.tag + "\")"
	case KindObject:
		members := make([]string, len(n.object))
		for i, member := range n.object {
			members[i] = ObjectKey(member.Key) + ": " + r.names[member.Type.key]
		}
		return r.typeRef.Export + ".object({ " + strings.Join(members, ", ") + " })"
	case KindIntersection:
		return r.typeRef.Export + ".intersection(" + r.joinNames(n.members) + ")"
	case KindUndefined:
		return r.typeRef.Export + ".typeLiteral(undefined)"
	case KindNull:
		return r.typeRef.Export + ".typeLiteral(null)"
	default: // KindNamed
		// A name is addressed by where it is reached from: the ambient scope
		// declares a global, and there is no specifier for it to carry.
		call := r.typeRef.Export + ".global(\"" + n.name + "\""
		if n.from != GlobalFrom {
			call = r.typeRef.Export + ".imported(\"" + n.name + "\", \"" + n.from + "\""
		}
		if len(n.args) != 0 {
			call += ", [" + r.joinNames(n.args) + "]"
		}
		return call + ")"
	}
}

// signature renders a KindFunc / KindCtor / KindAbstractCtor const — the
// return / instance type followed by its signatures. A slot of fixed argument
// lists renders as the rows spelling over member consts, the same text a hand
// author writes, so no const is minted for the rows themselves; a slot carrying
// an open length references the slot node's own const instead.
func (r *Registry) signature(n *Node, method string) string {
	if rows, fixed := fixedSlotRows(n.sig); fixed {
		parts := make([]string, len(rows))
		for i, row := range rows {
			parts[i] = "[" + r.joinNames(row) + "]"
		}
		return r.typeRef.Export + "." + method + "(" + r.names[n.ret.key] + ", [" + strings.Join(parts, ", ") + "])"
	}
	return r.typeRef.Export + "." + method + "(" + r.names[n.ret.key] + ", " + r.names[n.sig.key] + ")"
}

// fixedSlotRows reads a signatures slot back as fixed parameter rows — ok=false
// when any signature carries an open length (a rest slot, or a row that IS a
// list), which the rows spelling cannot state.
func fixedSlotRows(sig *Node) ([][]*Node, bool) {
	rowNodes := []*Node{sig}
	if sig.kind == KindUnion {
		rowNodes = sig.members
	}
	rows := make([][]*Node, 0, len(rowNodes))
	for _, row := range rowNodes {
		if row.kind != KindTuple || row.tupleRest != nil {
			return nil, false
		}
		rows = append(rows, row.members)
	}
	return rows, true
}

func (r *Registry) joinNames(nodes []*Node) string {
	parts := make([]string, len(nodes))
	for i, n := range nodes {
		parts[i] = r.names[n.key]
	}
	return strings.Join(parts, ", ")
}

// nameFor derives a const name from a canonical key. A key made only of
// alphanumeric characters survives sanitization unchanged, so it names itself
// and no other key can reach the same name; every other key gets a hash of its
// full spelling appended, since sanitization alone would merge, say, `a:b` and
// `a.b`.
func nameFor(key string) string {
	readable := sanitize(key)
	if readable == key && readable != "" {
		return "$" + readable
	}
	if len(readable) > maxReadableLen {
		// Keep the TAIL: a spelling reads qualifier-first, so its last characters
		// are the type's own name — the part someone scanning the module is
		// looking for.
		readable = strings.TrimLeft(readable[len(readable)-maxReadableLen:], "_")
	}
	sum := sha256.Sum256([]byte(key))
	suffix := hex.EncodeToString(sum[:])[:nameHashLen]
	if readable == "" {
		return "$" + suffix
	}
	return "$" + readable + "_" + suffix
}

// ObjectKey renders an object member's key the way an emitted call site spells
// it: a bare identifier when the name is a legal JS identifier, else a quoted
// string. Every renderer of an object member derives its key from this one rule,
// so a hoisted `Type.object` const reads byte-for-byte like the inline call it
// stands in for.
func ObjectKey(name string) string {
	if IsIdentifier(name) {
		return name
	}
	return strconv.Quote(name)
}

// IsIdentifier reports whether a member name can be spelled bare, for a renderer
// that builds a key node rather than a string and so needs the test without the
// quoting.
func IsIdentifier(name string) bool {
	return jsIdentifier.MatchString(name)
}

var jsIdentifier = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)

// sanitize replaces every non-alphanumeric rune with "_", collapsing runs and
// trimming the ends, so the readable part of a name is a legal identifier body.
func sanitize(key string) string {
	var b strings.Builder
	underscore := false
	for _, r := range key {
		alnum := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if alnum {
			b.WriteRune(r)
			underscore = false
			continue
		}
		if !underscore {
			b.WriteByte('_')
			underscore = true
		}
	}
	return strings.Trim(b.String(), "_")
}
