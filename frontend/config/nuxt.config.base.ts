import path from 'node:path'
import { defineNuxtConfig } from 'nuxt/config'
import svgLoader from 'vite-svg-loader'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { locales } from './locales.js'
import pkg from '../package.json'

function baserowModuleConfig(
  premiumBase = '../premium/web-frontend',
  enterpriseBase = '../enterprise/web-frontend'
) {
  const additionalModulesCsv = process.env.ADDITIONAL_MODULES
  const additionalModules = additionalModulesCsv
    ? additionalModulesCsv
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m !== '')
    : []

  if (additionalModules.length > 0) {
    console.log(`Loading extra plugin modules: ${additionalModules}`)
  }

  const baseModules = [
    `./modules/core/module.js`,
    `./modules/database/module.js`,
    `./modules/dashboard/module.js`,
    `./modules/builder/module.js`,
    `./modules/automation/module.js`,
    `./modules/integrations/module.js`,
    `./modules/documents/module.js`,
    `./modules/whiteboards/module.js`,
  ]

  baseModules.push(
    premiumBase + '/modules/baserow_premium/module.js',
    enterpriseBase + '/modules/baserow_enterprise/module.js'
  )

  const modules = baseModules.concat(additionalModules)

  const zipPkgDir = path.dirname(require.resolve('@zip.js/zip.js/package.json'))
  const zipUmdPath = path.join(zipPkgDir, 'dist/zip.min.js')

  return {
    modules,
    zipUmdPath,
  }
}

const baserow = baserowModuleConfig()

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  alias: {
    '@baserow': '',
  },
  css: [],
  runtimeConfig: {
    public: {
      version: pkg.version,
    },
  },
  modules: [...baserow.modules, '@nuxtjs/i18n', '@sentry/nuxt/module'],
  i18n: {
    strategy: 'no_prefix',
    defaultLocale: 'en',
    langDir: 'locales',
    locales,
    trailingSlash: true,
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'i18n-language',
      redirectOn: 'root',
    },
    vueI18n: './i18n.config.ts',
  },
  nitro: {
    externals: {
      external: ['vuejs3-datepicker', 'papaparse', 'antlr4', 'FileStream'],
      traceOptions: { base: '/' },
    },
    rollupConfig: {
      external: ['papaparse'],
    },
    esbuild: {
      options: {
        loader: {
          '.svg': 'text',
        },
      },
    },
  },
  vite: {
    plugins: [
      nodePolyfills({
        include: ['util'],
        // ✅ prevent "process already declared" in Nitro/Node
        globals: {
          process: false,
          Buffer: false,
          global: false,
        },
      }),
      svgLoader(),
    ],
    ssr: {
      noExternal: ['vue-chartjs', 'chart.js'],
      external: ['papaparse', 'antlr4'],
    },
    server: {
      sourcemapIgnoreList: (sourcePath) => sourcePath.includes('node_modules'),
    },
    optimizeDeps: {
      // Pre-bundle moment-guess to avoid missing source map warning
      include: ['moment-guess'],
    },
  },
  buildDir: process.env.NUXT_BUILD_DIR || '.nuxt',
  build: {
    transpile: ['vue-chartjs', 'chart.js'],
  },
  experimental: {
    appManifest: process.env.NODE_ENV !== 'development',
  },
  vue: {
    compilerOptions: {
      comments: false,
    },
  },
})
