import antfu from '@antfu/eslint-config'

export default antfu(
  {
    ignores: ['dist', 'docs'],
    rules: {
      'antfu/consistent-list-newline': 'off',
      'curly': ['error'],
      'format/prettier': 'off',
      'import/extensions': 'off',
      'import/order': 'off',
      'jsdoc/check-alignment': 'error',
      'jsdoc/check-line-alignment': 'error',
      'new-cap': 'off',
      // HAP-NodeJS has no logger of its own; the console is where its warnings are meant to go
      'no-console': 'off',
      'no-undef': 'error',
      'perfectionist/sort-exports': 'error',
      'perfectionist/sort-imports': [
        'error',
        {
          groups: [
            ['type-builtin', 'type-external', 'type-internal'],
            ['type-parent', 'type-sibling', 'type-index'],
            'builtin',
            'external',
            'internal',
            ['parent', 'sibling', 'index'],
            'side-effect',
            'unknown',
          ],
          internalPattern: ['^@/.*'],
          order: 'asc',
          type: 'natural',
          newlinesBetween: 1,
        },
      ],
      'perfectionist/sort-named-exports': 'error',
      'perfectionist/sort-named-imports': 'error',
      'quotes': ['error', 'single'],
      'sort-imports': 'off',
      'style/brace-style': ['error', '1tbs'],
      'style/quote-props': ['error', 'consistent-as-needed'],
      'test/no-only-tests': 'error',
      'ts/consistent-type-imports': 'off',
      // a public library: exported functions and methods declare their types
      'ts/explicit-module-boundary-types': 'error',
      // method signatures are deliberate in a public API: the property form checks parameters more strictly,
      // so rewriting them would break plugins that implement these interfaces with narrower parameter types
      'ts/method-signature-style': 'off',
      // it puts `new` in front of any call whose name ends in Error, which turned calls to the
      // IsKnownHAPStatusError() function into objects that are always truthy
      'unicorn/throw-new-error': 'off',
      // the event enums are declared after the interfaces that describe their listeners, as before
      'ts/no-use-before-define': [
        'error',
        {
          classes: false,
          enums: false,
          functions: false,
          variables: true,
        },
      ],
      'unused-imports/no-unused-vars': [
        'error',
        { caughtErrors: 'none' },
      ],
    },
    typescript: true,
    formatters: {
      markdown: true,
    },
  })
  .append({
    files: ['**/*.md'],
    rules: {
      'jsdoc/check-alignment': 'off',
      'jsdoc/check-line-alignment': 'off',
      'markdown/fenced-code-language': 'off',
      'markdown/require-alt-text': 'off',
      'perfectionist/sort-exports': 'off',
      'perfectionist/sort-imports': 'off',
      'perfectionist/sort-named-exports': 'off',
      'perfectionist/sort-named-imports': 'off',
    },
  })
  .append({
    files: ['src/**/*.spec.ts'],
    rules: {
      // testRequestResponse() makes its own assertions on the HAP response
      'test/expect-expect': [
        'error',
        {
          assertFunctionNames: ['expect', 'testRequestResponse'],
        },
      ],
      'test/no-commented-out-tests': 'error',
      'test/no-conditional-expect': 'error',
      'test/no-disabled-tests': 'warn',
      'test/no-focused-tests': 'error',
      'test/no-identical-title': 'error',
      'test/no-import-node-test': 'error',
      'test/no-interpolation-in-snapshots': 'error',
      'test/no-mocks-import': 'error',
      'test/no-standalone-expect': [
        'error',
        {
          additionalTestBlockFunctions: ['itWithSymlinks'],
        },
      ],
      'test/no-unneeded-async-expect-function': 'error',
      'test/padding-around-before-each-blocks': 'error',
      'test/padding-around-after-each-blocks': 'error',
      'test/padding-around-before-all-blocks': 'error',
      'test/padding-around-after-all-blocks': 'error',
      'test/padding-around-describe-blocks': 'error',
      'test/padding-around-test-blocks': 'error',
      'test/prefer-called-exactly-once-with': 'error',
      'test/require-local-test-context-for-concurrent-snapshots': 'error',
      'test/valid-describe-callback': 'error',
      // Off due to an upstream false positive in @vitest/eslint-plugin: it misreads the
      // `expect.any()` asymmetric matcher as an invalid `.any` chai chain and reports
      // "Expect has an unknown modifier". Re-enable if that bug is fixed upstream.
      'test/valid-expect': 'off',
      'test/valid-expect-in-promise': 'error',
      'test/valid-title': 'error',
    },
  })
