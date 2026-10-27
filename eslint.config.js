import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

// Flat config covering both workspaces: the Vue/JS web app and the TS daemon.
// Formatting is owned by Prettier (eslint-config-prettier turns off the rules
// that would conflict), so ESLint here is about correctness, not style.
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'web/tests/e2e/fixtures/**', // standalone fake-engine fixtures
    ],
  },

  // Web app (Vue 3 + plain JS) — essential rules only (real bugs, not style).
  {
    files: ['web/**/*.{js,vue}'],
    ...js.configs.recommended,
  },
  ...pluginVue.configs['flat/essential'],
  {
    files: ['web/**/*.{js,vue}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      // Single-file views like App/Dashboard are intentionally one word.
      'vue/multi-word-component-names': 'off',
      // Best-effort `try { … } catch {}` (fit/resize/parse) is a deliberate
      // pattern here — an empty catch is fine, other empty blocks are not.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // e2e specs run under Node but also evaluate code in the browser context.
  {
    files: ['web/tests/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // Vite's own config runs in Node, not the browser, even though it lives
  // under web/ — it reads env vars to pick the dev ports.
  {
    files: ['web/*.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Daemon (TypeScript on Node).
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ['daemon/**/*.ts'] })),
  {
    files: ['daemon/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Must come last: disable stylistic rules that fight Prettier.
  prettier,
)
