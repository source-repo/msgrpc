import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The console is served by the CLI from its own dist, so the build has to be self-contained: a
// plant network usually has no route to the internet, and a page that fetches from a CDN renders
// blank exactly where it is needed.
export default defineConfig({
    root: __dirname,
    plugins: [react()],
    base: './',
    resolve: {
        // See mqtt-stub.ts: the browser half of the console never opens a broker connection.
        alias: { mqtt: fileURLToPath(new URL('./src/mqtt-stub.ts', import.meta.url)) }
    },
    build: {
        outDir: '../dist/web',
        emptyOutDir: true,
        // A console is a debugging tool. When it breaks, "_ is not a function" in minified output
        // is worth less than the few hundred kB the maps cost, and they are only fetched when
        // devtools is open.
        sourcemap: true,
        // Fixed names, so the static handler serves a known set rather than hashed ones.
        rollupOptions: { output: { entryFileNames: 'app.js', assetFileNames: 'app.[ext]' } }
    },
    // `npm run dev:web` serves the app with hot reload and forwards the RPC link to a console
    // started separately on its default port. `console.json` is forwarded too: it is how the page
    // learns the name to address the console by, and it is fetched before the socket is opened, so
    // without it the dev server renders a page that can never connect.
    server: {
        proxy: {
            '/socket.io': { target: 'http://localhost:7844', ws: true },
            '/console.json': { target: 'http://localhost:7844' }
        }
    }
})
