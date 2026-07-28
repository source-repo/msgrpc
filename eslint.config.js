import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
    { ignores: ['**/dist/**', '**/dist-examples/**', '**/node_modules/**', '**/src/fixture/**'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            globals: { ...globals.node }
        },
        rules: {
            semi: 'off',
            // A leading underscore is the conventional way to say a binding is deliberately unused.
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
            ],
            '@typescript-eslint/no-empty-object-type': 'off'
        }
    },
    /**
     * Type-aware, and only for the rules that need to be.
     *
     * A promise nobody awaits and nobody catches is an unhandled rejection, and Node's default is
     * to end the process on one - so a single peer sending a single malformed frame could take down
     * a server answering everybody else. That is not a class of bug worth finding by hand twice,
     * and it is invisible to the untyped config above.
     */
    {
        files: ['packages/*/src/**/*.ts'],
        languageOptions: {
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
        },
        rules: {
            '@typescript-eslint/no-floating-promises': 'error',
            // Passing an async function where a void-returning one is expected is the same hazard
            // wearing a different hat: every async event listener is one of these.
            '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false, attributes: false } }]
        }
    }
)
