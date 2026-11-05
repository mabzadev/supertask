import { lstatSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function ensureSharedNodeModules(relativePath) {
  const target = join(root, relativePath)

  try {
    lstatSync(target)
    return
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }

  symlinkSync('../../frontend/node_modules', target, 'dir')
}

function run(args, extraEnv = {}) {
  const result = spawnSync('npx', ['--yes', 'yarn@1.22.22', ...args], {
    cwd: root,
    env: {
      ...process.env,
      CI: 'true',
      SENTRY_DISABLED: 'true',
      NUXT_PUBLIC_PUBLIC_BACKEND_URL:
        process.env.NUXT_PUBLIC_PUBLIC_BACKEND_URL ||
        'https://supertask.mbza.workers.dev',
      NUXT_PUBLIC_PUBLIC_WEB_FRONTEND_URL:
        process.env.NUXT_PUBLIC_PUBLIC_WEB_FRONTEND_URL || 'https://task.mabza.dev',
      NUXT_PUBLIC_MEDIA_URL:
        process.env.NUXT_PUBLIC_MEDIA_URL ||
        'https://supertask.mbza.workers.dev/media/',
      ...extraEnv,
    },
    stdio: 'inherit',
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

ensureSharedNodeModules('enterprise/web-frontend/node_modules')
ensureSharedNodeModules('premium/web-frontend/node_modules')

run(['--cwd', 'frontend', 'install', '--frozen-lockfile', '--non-interactive'])
run(['--cwd', 'frontend', 'test'], {
  EXTRA_VITEST_PARAMS: '--maxWorkers=2',
})
run(['--cwd', 'frontend', 'test:enterprise'], {
  EXTRA_VITEST_PARAMS: '--maxWorkers=2',
})
run(['--cwd', 'frontend', 'generate'], {
  NODE_ENV: 'production',
})
