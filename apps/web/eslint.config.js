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
    ignores: ['dist', 'node_modules', 'build', 'coverage'],
  },
]
