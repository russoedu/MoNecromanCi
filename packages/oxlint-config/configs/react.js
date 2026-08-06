/**
 * JSX/TSX rules, mirroring `@mnci/eslint-config`'s `mnci/react` block.
 *
 * @remarks
 * Derived by diffing the ESLint config's resolved rules for a `.tsx` against a
 * plain `.ts`, so this is exactly what that block adds — **and, since one pass
 * got this wrong, what it takes away.** The original diff compared only the
 * rules `mnci/react` switches ON, so the one rule it switches OFF was missed
 * and stayed enabled here. A fresh `mnci add react-app` then failed
 * `npm run lint` on Nx's own generated `app.tsx` and `nx-welcome.tsx` under
 * oxlint while passing under ESLint — the precise shape of the violation the
 * parity contract exists to prevent, since oxlint may be more permissive but
 * never stricter. `tests/parity.spec.ts` now asserts the disables too, so a
 * scoped `'off'` added on the ESLint side cannot silently go unmirrored.
 *
 * Accessibility is the bulk of it, and it belongs here rather than with the HTML
 * rules for the reason the sibling package records: `@html-eslint`'s rules apply
 * to `**\/*.html` only, so an `<img>` inside a component is checked by nothing
 * without these.
 *
 * The React rules themselves come from oxlint's `react` plugin. Note it is a
 * port of `eslint-plugin-react`, which `@mnci/eslint-config` has **replaced**
 * with `@eslint-react/eslint-plugin` — so the mapping here is by rule name
 * across two different implementations, which is exactly the kind of place a
 * behavioural divergence would surface. `tests/parity.spec.ts` is the guard.
 */
export const REACT_FILES = ['**/*.{jsx,tsx}']

export default {
  'react/no-array-index-key': 'error',
  'react/no-clone-element': 'error',
  'react/no-direct-mutation-state': 'error',
  'react/jsx-no-comment-textnodes': 'error',
  'jsx_a11y/alt-text': 'error',
  'jsx_a11y/anchor-has-content': 'error',
  'jsx_a11y/anchor-is-valid': 'error',
  'jsx_a11y/aria-activedescendant-has-tabindex': 'error',
  'jsx_a11y/aria-props': 'error',
  'jsx_a11y/aria-proptypes': 'error',
  'jsx_a11y/aria-role': 'error',
  'jsx_a11y/aria-unsupported-elements': 'error',
  'jsx_a11y/autocomplete-valid': 'error',
  'jsx_a11y/click-events-have-key-events': 'error',
  'jsx_a11y/heading-has-content': 'error',
  'jsx_a11y/html-has-lang': 'error',
  'jsx_a11y/iframe-has-title': 'error',
  'jsx_a11y/img-redundant-alt': 'error',
  'jsx_a11y/interactive-supports-focus': [
    'error',
    { tabbable: ['button', 'checkbox', 'link', 'searchbox', 'spinbutton', 'switch', 'textbox'] }
  ],
  'jsx_a11y/label-has-associated-control': 'error',
  'jsx_a11y/media-has-caption': 'error',
  'jsx_a11y/mouse-events-have-key-events': 'error',
  'jsx_a11y/no-access-key': 'error',
  'jsx_a11y/no-autofocus': 'error',
  'jsx_a11y/no-distracting-elements': 'error',
  'jsx_a11y/no-interactive-element-to-noninteractive-role': [
    'error',
    { tr: ['none', 'presentation'], canvas: ['img'] }
  ],
  'jsx_a11y/no-noninteractive-element-interactions': [
    'error',
    {
      handlers: [
        'onClick',
        'onError',
        'onLoad',
        'onMouseDown',
        'onMouseUp',
        'onKeyPress',
        'onKeyDown',
        'onKeyUp'
      ],
      alert: ['onKeyUp', 'onKeyDown', 'onKeyPress'],
      body: ['onError', 'onLoad'],
      dialog: ['onKeyUp', 'onKeyDown', 'onKeyPress'],
      iframe: ['onError', 'onLoad'],
      img: ['onError', 'onLoad']
    }
  ],
  'jsx_a11y/no-noninteractive-element-to-interactive-role': [
    'error',
    {
      ul: ['listbox', 'menu', 'menubar', 'radiogroup', 'tablist', 'tree', 'treegrid'],
      ol: ['listbox', 'menu', 'menubar', 'radiogroup', 'tablist', 'tree', 'treegrid'],
      li: ['menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'row', 'tab', 'treeitem'],
      table: ['grid'],
      td: ['gridcell'],
      fieldset: ['radiogroup', 'presentation']
    }
  ],
  'jsx_a11y/no-noninteractive-tabindex': [
    'error',
    { tags: [], roles: ['tabpanel'], allowExpressionValues: true }
  ],
  'jsx_a11y/no-redundant-roles': 'error',
  'jsx_a11y/no-static-element-interactions': [
    'error',
    {
      allowExpressionValues: true,
      handlers: ['onClick', 'onMouseDown', 'onMouseUp', 'onKeyPress', 'onKeyDown', 'onKeyUp']
    }
  ],
  'jsx_a11y/role-has-required-aria-props': 'error',
  'jsx_a11y/role-supports-aria-props': 'error',
  'jsx_a11y/scope': 'error',
  'jsx_a11y/tabindex-no-positive': 'error',
  'react/rules-of-hooks': 'error',
  'react/exhaustive-deps': 'error',

  // OFF, mirroring `mnci/react`, and this is the one entry here that removes a
  // rule rather than adding one. A component's return type is always JSX and
  // TypeScript infers it precisely, so annotating every one adds noise and no
  // information — and leaving it on made Nx's generated `app.tsx` fail lint in
  // a workspace the user had not touched yet. Still enforced on plain `.ts`
  // (see `native.js`), where a return type is real API surface.
  'typescript/explicit-function-return-type': 'off'
}
