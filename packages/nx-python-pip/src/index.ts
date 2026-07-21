// @mnci/nx-python-pip has no runtime entry point of its own — everything is
// resolved through generators.json/executors.json (Nx's own plugin
// discovery) and the ./release/version-actions export. This file exists
// only so `package.json`'s `main`/`types` fields resolve to something.
export {}
