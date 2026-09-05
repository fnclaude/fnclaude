package tokentext

import "testing"

func TestStripExt(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"a/b/c.d.ts", "a/b/c"},
		{"a/b/c.ts", "a/b/c"},
		{"a/b/c.tsx", "a/b/c"},
		{"a/b/c.mts", "a/b/c"},
		{"a/b/c.js", "a/b/c"},
		{"a/b/index.d.mts", "a/b/index"},
		{"contracts/index", "contracts/index"},
		{"no-ext", "no-ext"},
		{"weird.name.ts", "weird.name"},
	}
	for _, c := range cases {
		if got := StripExt(c.in); got != c.want {
			t.Errorf("StripExt(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestDirname(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"/proj/src/app.ts", "/proj/src"},
		{"/proj/src/", "/proj"},
		{"/proj", "/"},
		{"/", ""},
		{"relative/path/x", "relative/path"},
	}
	for _, c := range cases {
		if got := Dirname(c.in); got != c.want {
			t.Errorf("Dirname(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestPosixRelative(t *testing.T) {
	cases := []struct {
		from, to, want string
		ok             bool
	}{
		{"/proj", "/proj/src/app.ts", "src/app.ts", true},
		{"/proj/", "/proj/src/app.ts", "src/app.ts", true},
		{"/proj", "/proj", "", true},
		{"/proj", "/other/x.ts", "", false},
		{"/proj", "/projector/x.ts", "", false},
	}
	for _, c := range cases {
		got, ok := PosixRelative(c.from, c.to)
		if got != c.want || ok != c.ok {
			t.Errorf("PosixRelative(%q,%q) = (%q,%v), want (%q,%v)", c.from, c.to, got, ok, c.want, c.ok)
		}
	}
}

func TestPackagePrivateToken(t *testing.T) {
	got := PackagePrivateToken("the-app", "/proj", "/proj/src/services/IUserRepo.ts", "IUserRepo")
	want := "the-app/private/services/IUserRepo:IUserRepo"
	if got != want {
		t.Errorf("PackagePrivateToken = %q, want %q", got, want)
	}
}

func TestRootlessToken(t *testing.T) {
	cases := []struct {
		declPath, exportName, root, want string
	}{
		{"/virtual/app.ts", "IFoo", "/virtual", "./app:IFoo"},
		{"/proj/src/app.ts", "IBar", "/proj", "./src/app:IBar"},
	}
	for _, c := range cases {
		if got := RootlessToken(c.declPath, c.exportName, c.root); got != c.want {
			t.Errorf("RootlessToken(%q,%q,%q) = %q, want %q", c.declPath, c.exportName, c.root, got, c.want)
		}
	}
}
