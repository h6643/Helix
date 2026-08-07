import { defineConfig, globalIgnores } from 'eslint/config'
import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import reactPlugin from 'eslint-plugin-react'

// Flat config for ESLint 9. The old config inherited eslint-config-next; with
// the Tauri/Vite migration the Next preset is gone, so we use the
// typescript-eslint + react-hooks presets that covered the same surface.
export default defineConfig([
  globalIgnores([
    'node_modules/**',
    'dist/**',
    'out/**',
    'build/**',
    'release/**',
    'electron/**',
    'src-tauri/**',
    'hermes-agent/**',
    '*.config.js',
    '*.config.mjs',
    '*.config.ts',
    'eslint.config.mjs',
  ]),
  {
    name: 'helix/js',
    files: ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'],
    ...js.configs.recommended,
  },
  {
    name: 'helix/ts',
    files: ['**/*.{ts,tsx,mts,cts}'],
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    name: 'helix/react',
    files: ['**/*.{jsx,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      react: reactPlugin,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': 'warn',
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
