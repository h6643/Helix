import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import tsPlugin from '@typescript-eslint/eslint-plugin'

// Flat config for ESLint 9. `next lint` was removed in Next 16, so lint runs
// through eslint directly. Mirrors the old .eslintrc.json rules.
export default defineConfig([
  globalIgnores([
    'node_modules/**',
    '.next/**',
    'dist/**',
    'out/**',
    'build/**',
    'release/**',
    'electron/ipc/**',
    '*.config.js',
    '*.config.mjs',
    'eslint.config.mjs',
    'next-env.d.ts',
  ]),
  ...nextVitals,
  {
    name: 'helix/all',
    files: ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'],
    rules: {
      'prefer-const': 'error',
      'no-var': 'error',
      'no-unused-vars': 'off',
      'no-debugger': 'warn',
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      // The compiler-nanny rules introduced in eslint-plugin-react-hooks v7
      // (ships with Next 16's config) were never part of this project's
      // intended lint surface. This codebase doesn't use the React Compiler,
      // so keep them as warnings; rules-of-hooks/exhaustive-deps stay errors.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
  {
    name: 'helix/ts',
    files: ['**/*.{ts,tsx,mts,cts}'],
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    name: 'helix/import-order',
    files: ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'],
    rules: {
      'import/order': ['warn', {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling'],
        'newlines-between': 'ignore',
        alphabetize: { order: 'asc' },
      }],
    },
  },
])
