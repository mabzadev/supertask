/**
 * Cloudflare Pages SPA build config
 * ssr: false → full client-side rendering, no Worker needed
 * Deploys as pure static files to Cloudflare Pages
 */
import baseConfig from './nuxt.config.base.ts'

const cfg = { ...(baseConfig as any) }

export default {
  ...cfg,
  // SPA mode: no SSR, no Worker, no Node.js compat issues
  ssr: false,
  routeRules: {
    ...(cfg.routeRules || {}),
    '/_nuxt/**': {
      headers: {
        'cache-control': 'public, max-age=0, must-revalidate',
      },
    },
  },
  nitro: {
    ...(cfg.nitro || {}),
    preset: 'cloudflare-pages-static',
    prerender: {
      failOnError: false,
      crawlLinks: false,
      routes: ['/', '/login', '/200.html', '/404.html'],
    },
  },
  sourcemap: { server: false, client: false },
  vite: {
    ...(cfg.vite || {}),
    build: {
      ...(cfg.vite?.build || {}),
      rollupOptions: {
        ...(cfg.vite?.build?.rollupOptions || {}),
        output: {
          ...(cfg.vite?.build?.rollupOptions?.output || {}),
          // Named route middleware is imported lazily, one small chunk after
          // the other while a route resolves. Grouped in one chunk (pulled in
          // with the global authentication middleware), it loads once, upfront.
          manualChunks(id: string) {
            if (/\/modules\/[^/]+\/middleware\//.test(id)) return 'route-middleware'
          },
        },
      },
    },
  },
}
