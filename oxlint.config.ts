import { defineConfig } from 'oxlint'
import mnci from '@mnci/oxlint-config'

export default defineConfig({ extends: [mnci()] })
