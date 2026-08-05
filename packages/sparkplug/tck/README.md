# Sparkplug TCK baseline

Run the Eclipse Sparkplug 3.0.0 Edge profile development baseline with:

```sh
npm run tck:edge -w @source-repo/sparkplug
```

The runner downloads the official TCK binary into the user cache, verifies its pinned SHA-256, extracts the official HiveMQ extension, and starts a digest-pinned HiveMQ Community Edition container on `127.0.0.1:1885`. It writes the official raw result log and a Markdown summary under `tck/reports/`, then removes the container and temporary files.

Requirements: Node.js 22 or newer, Docker, and `unzip`. Override the broker port with `SOURCE_SPARK_TCK_PORT` and the report prefix with `SOURCE_SPARK_TCK_REPORT`.

This baseline is engineering evidence, not an Eclipse Foundation compatibility claim. A formal listing must follow the Eclipse Sparkplug compatibility process and use the official binary under its TCK license.
