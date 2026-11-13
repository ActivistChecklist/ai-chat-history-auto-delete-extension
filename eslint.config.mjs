import js from '@eslint/js';
import globals from 'globals';

/** What to lint — run `yarn lint` / `yarn lint:fix` (no CLI globs needed). */
const lintedFiles = [
  'src/**/*.js',
  'discovery/**/*.js',
  'scripts/**/*.js',
  'scripts/**/*.mjs',
  'tests/**/*.js',
  'tailwind.config.js',
  'eslint.config.mjs'
];

export default [
  {
    ignores: ['node_modules/**', 'icons/**', 'dist/**', 'dist-firefox/**', 'web-ext-artifacts/**', 'release/**', 'coverage/**']
  },
  js.configs.recommended,
  {
    files: lintedFiles,
    rules: {
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      /** Intentional `catch {}` for fire-and-forget chrome.* calls; --fix cannot patch these. */
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    files: ['src/**/*.js', 'discovery/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        chrome: 'readonly'
      }
    }
  },
  {
    files: ['scripts/**/*.js', 'tailwind.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node
    }
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node
    }
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.vitest,
        ...globals.webextensions
      }
    }
  }
];
