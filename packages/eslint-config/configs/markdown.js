import markdown from '@eslint/markdown'

/** Markdown, as GitHub-flavoured. Every generated workspace ships READMEs. */
export default [
  {
    name:     'mnci/markdown',
    files:    ['**/*.md'],
    plugins:  { markdown },
    language: 'markdown/gfm',
    rules:    {
      'markdown/no-empty-links':        'error',
      /*
       * OFF because it CRASHES THE WHOLE LINT RUN, which is strictly worse
       * than not having the rule at all.
       *
       * On a Confluence-style link — `[Levenshtein distance|https://…]`, which
       * is not Markdown but appears in plenty of real documents pasted from a
       * wiki — the rule reaches a node carrying neither ESTree `range` nor
       * mdast `position` offsets, and `@eslint/plugin-kit`'s `getText()`
       * throws `Custom getRange() method must be implemented in the subclass`.
       * ESLint then tries to add a line number to that error, calls `getLoc()`
       * on the same node, and throws a SECOND time — so what a user actually
       * sees is:
       *
       *   Error: Custom getLoc() method must be implemented in the subclass.
       *       at MarkdownSourceCode.getLoc (@eslint/plugin-kit)
       *
       * naming neither the file, nor the rule, nor the real method. The whole
       * `eslint .` invocation exits 2, so `npm run format`, `nx run-many -t
       * lint` and `mnci upgrade`'s format pass all die on one line of prose in
       * one file.
       *
       * Measured, not inferred: a one-line fixture reproduces it identically on
       * eslint 10.9.1 and 10.11.0, and on `@eslint/plugin-kit` 0.7.2 and 0.7.3,
       * so it is the content that triggers it rather than any version pairing.
       * `@eslint/markdown` 8.0.3 is the latest release; there is no fixed
       * version to move to.
       *
       * Re-enable when upstream stops throwing — `tests/markdown-crash.spec.ts`
       * pins the behaviour in both directions and will fail once it does.
       */
      'markdown/no-invalid-label-refs': 'off',
      'markdown/no-duplicate-headings': 'off',
    },
  },
]
