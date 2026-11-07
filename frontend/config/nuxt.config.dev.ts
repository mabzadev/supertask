import { defineNuxtConfig } from 'nuxt/config'
import baseConfig from './nuxt.config.base.ts'

// Hosts the dev server answers besides localhost, such as the Tailscale name it
// is reached through: comma-separated in SUPERTASK_DEV_ALLOWED_HOSTS.
const allowedHosts = (process.env.SUPERTASK_DEV_ALLOWED_HOSTS || '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean)

export default defineNuxtConfig({
  ...baseConfig,
  modules: [...(baseConfig.modules || []), '@nuxt/eslint'],
  devtools: { enabled: true },
  vite: {
    ...baseConfig.vite,
    server: { ...baseConfig.vite?.server, allowedHosts },
  },
})
