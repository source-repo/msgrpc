const { SemicolonPreference } = require("typescript");

module.exports = {
  root: true,
  env: { browser: false, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  ignorePatterns: ['web-client', 'node_modules', 'dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: [],
  rules: {
    "semi": "off",
    "@typescript-eslint/semi": ["error", "never"]
  },
}
