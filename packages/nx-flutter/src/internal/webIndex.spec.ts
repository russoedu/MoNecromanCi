import { withHtmlLang } from './webIndex'

/** The `<html>` tag exactly as `flutter create --platforms=web` emits it. */
const FLUTTER_INDEX = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>hello</title>
</head>
<body>
  <script src="flutter_bootstrap.js" async></script>
</body>
</html>
`

describe('withHtmlLang', () => {
  it('adds lang="en" to the bare tag flutter create writes', () => {
    // The real defect: @html-eslint's `require-lang` reports the bare tag as an
    // ERROR, so `mnci add flutter-app` produced a workspace failing its own
    // `npm run lint` on a file the user never opened. Verified against the real
    // binary too — the unpatched shell reports exactly
    // "Missing `lang` attribute in `<html>` tag" and the patched one is clean.
    expect(withHtmlLang(FLUTTER_INDEX)).toContain('<html lang="en">')
    expect(withHtmlLang(FLUTTER_INDEX)).not.toMatch(/<html>/)
  })

  it('leaves the rest of the document byte-identical', () => {
    // Only the tag changes. This is a generated app's real entry point, not a
    // file to reformat in passing.
    const patched = withHtmlLang(FLUTTER_INDEX)
    expect(patched.replace('<html lang="en">', '<html>')).toBe(FLUTTER_INDEX)
  })

  it('does not touch an <html> tag that already has attributes', () => {
    // If Flutter fixes this upstream, or a user sets their own locale, mnci must
    // not overwrite it. Matching any `<html ...>` would clobber both.
    for (const tag of ['<html lang="en">', '<html lang="pt-BR">', '<html dir="rtl">']) {
      const document_ = `<!DOCTYPE html>\n${tag}\n</html>\n`
      expect(withHtmlLang(document_)).toBe(document_)
    }
  })

  it('is idempotent, since `mnci upgrade` re-runs generation paths', () => {
    expect(withHtmlLang(withHtmlLang(FLUTTER_INDEX))).toBe(withHtmlLang(FLUTTER_INDEX))
  })

  it('is a no-op on a document with no <html> tag at all', () => {
    const fragment = '<body>nothing to do here</body>\n'
    expect(withHtmlLang(fragment)).toBe(fragment)
  })
})
