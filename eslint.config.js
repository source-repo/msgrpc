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
    }
)
