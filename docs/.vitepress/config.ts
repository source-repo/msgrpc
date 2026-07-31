import { defineConfig } from 'vitepress'

/**
 * The whole site is this file plus the markdown beside it. Deliberately: the pages stay plain
 * CommonMark - no front matter, no framework syntax - so the same files read correctly on GitHub,
 * in an editor, and through the repository's one-line-per-paragraph diffing conventions. The
 * sidebar lives here and only here.
 */
export default defineConfig({
    title: 'Source RPC',
    description: 'TypeScript RPC for a network of peers — browsers, Node services and plant devices — over socket.io and MQTT 5',
    // Served as a project page: source-repo.github.io/rpc/
    base: '/rpc/',
    lastUpdated: true,
    // The design documents link to working material in notes/, which is deliberately not on the
    // site. Those links resolve on GitHub; the checker would fail the build over them.
    ignoreDeadLinks: true,
    themeConfig: {
        nav: [
            { text: 'Guide', link: '/guide/getting-started' },
            { text: 'Operations', link: '/deploying-a-network' },
            { text: 'Packages', link: '/packages/rpc' },
            { text: 'npm', link: 'https://www.npmjs.com/package/@source-repo/rpc' }
        ],
        sidebar: [
            {
                text: 'Guide',
                items: [{ text: 'Getting started', link: '/guide/getting-started' }]
            },
            {
                text: 'Operations',
                items: [
                    { text: 'Deploying a network', link: '/deploying-a-network' },
                    { text: 'Security model', link: '/security-model' },
                    { text: 'Schema compatibility', link: '/schema-compatibility' },
                    { text: 'MQTT 5 frame spec', link: '/mqtt5-frame-spec' }
                ]
            },
            {
                text: 'Tools',
                items: [{ text: 'Writing a simulator', link: '/writing-a-simulator' }]
            },
            {
                text: 'Packages',
                items: [
                    { text: '@source-repo/rpc', link: '/packages/rpc' },
                    { text: '@source-repo/rpc-cli', link: '/packages/cli' },
                    { text: '@source-repo/queue', link: '/packages/queue' }
                ]
            },
            {
                text: 'Design',
                items: [{ text: 'Extensions and an ecosystem', link: '/extensions-and-ecosystem' }]
            }
        ],
        outline: { level: [2, 3] },
        // Local search, bundled: the site makes no external requests, like everything else here.
        search: { provider: 'local' },
        socialLinks: [{ icon: 'github', link: 'https://github.com/source-repo/rpc' }],
        editLink: {
            pattern: 'https://github.com/source-repo/rpc/edit/main/docs/:path',
            text: 'Edit this page on GitHub'
        },
        footer: {
            message: 'MIT licensed'
        }
    }
})
