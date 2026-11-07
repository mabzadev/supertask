/**
 * This file can be used in combination with intellij idea so the @supertask path
 * resolves.
 *
 * Intellij IDEA: Preferences -> Languages & Frameworks -> JavaScript -> Webpack ->
 * webpack configuration file
 */

const path = require('path')

module.exports = {
  resolve: {
    extensions: ['.js', '.json', '.vue', '.ts'],
    root: path.resolve(__dirname),
    alias: {
      '@supertask': path.resolve(__dirname),
      '@supertask_premium': path.resolve(
        __dirname,
        '../premium/web-frontend/modules/supertask_premium'
      ),
      '@supertask_premium_test': path.resolve(
        __dirname,
        '../premium/web-frontend/test'
      ),
      '@supertask_enterprise': path.resolve(
        __dirname,
        '../enterprise/web-frontend/modules/supertask_enterprise'
      ),
      '@supertask_enterprise_test': path.resolve(
        __dirname,
        '../enterprise/web-frontend/test'
      ),
      '@supertask_test_cases': path.resolve(__dirname, '../tests/cases'),
    },
  },
}
