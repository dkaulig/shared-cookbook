import base from '@familien-kochbuch/config/eslint.config.base.js'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  ...base,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    // `e2e/` ships the Playwright smoke spec (OFF5) — lint is N/A
    // because Playwright's runner owns the syntax contract and the
    // spec uses globals the app ESLint config doesn't know about.
    ignores: ['dist', 'node_modules', 'build', 'coverage', 'e2e'],
  },
]
