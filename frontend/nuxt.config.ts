const isTest = process.env.VITEST || process.env.APP_ENV === 'test'
const isDev = process.env.APP_ENV === 'dev'
const isCloudflare = process.env.APP_ENV === 'cloudflare'

export default isTest
  ? (await import('./config/nuxt.config.test.ts')).default
  : isCloudflare
    ? (await import('./config/nuxt.config.cloudflare.ts')).default
  : isDev
    ? (await import('./config/nuxt.config.dev.ts')).default
    : (await import('./config/nuxt.config.prod.ts')).default
