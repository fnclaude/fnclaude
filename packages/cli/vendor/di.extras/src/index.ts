// Named rather than a side-effect import: a `rhombus-std` inline entry's `impl` is
// resolved by walking this entry's re-export graph, so a set that is only
// imported for its registration is never found.
export * from './augmentations';
