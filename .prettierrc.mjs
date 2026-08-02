// The formatting half of @mnci/eslint-config. Kept in the package so lint and
// format cannot drift apart, and so a fix reaches this repo via `npm update`.
//
// To override, spread it instead of re-exporting:
//   import mnci from '@mnci/eslint-config/prettier'
//   export default { ...mnci, printWidth: 120 }
export { default } from '@mnci/eslint-config/prettier'
