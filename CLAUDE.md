# Working in this repository

## Never put a control character in a source file

Write `\u0000` (or `\x1b`, or whatever it is), never the byte itself — including inside a template literal, where it is invisible in review.

NUL is the one that keeps happening, because it is a good separator: it cannot occur in a peer name, a namespace or an idempotency key, so `` `${a}\u0000${b}` `` cannot be forged by choosing a clever `a`. Keep using it. Just escape it.

A literal NUL makes the file **binary** to every tool that decides by content sniffing:

- `grep` matches but prints nothing — no error, no "Binary file matches" when piped. Searches for a symbol in that file come back empty and look authoritative. This is the one that costs time.
- `file` reports `data`, and anything else sniffing content agrees.
- `git diff` shows `Binary files differ`, but only when the NUL lands in the first 8000 bytes, which is as far as git looks. Put one near the end of a long file and git keeps diffing it happily while grep has already gone silent — so a working `git diff` is not evidence the file is clean.

`RpcServerHandler.ts` and `Idempotency.ts` both had one. `eventProxyKey` in the same file had the escape and read identically. Check with:

```
git ls-files -z | xargs -0 grep -laP '\x00'
```

## Conventions worth knowing before editing

**Ports.** `defaultWebSocketPort` (7843, `rpc`) and `defaultWebPort` (7844, `console`) live in `packages/rpc/src/RPC/Rpc.ts`, with `defaultSecureWebSocketPort` (8843, `rpc-tls`) and `defaultSecureWebPort` (8844, `console-tls`) beside them. Nothing else should hardcode them — the CLI reads the constants for its `--port` defaults, and `--cert`/`--key` select the encrypted pair. A thousand apart rather than adjacent so no firewall range spans a plain port and an encrypted one.

**Comments carry the reasoning, not the mechanics.** The house style explains *why* a thing is the way it is, and especially what breaks if it is changed back. Match the surrounding density; a file here has more prose than most codebases and that is deliberate.

**Contracts are committed and checked.** `packages/cli/src/*.types.json` are extracted from source by `npm run contract` and verified by `npm run check:contract`. Change a service in `bus.ts` or `console.ts` and re-extract, or the check fails.

**Both packages version together**, since the CLI depends on the library's exact shape. `packages/queue` is deliberately **not** part of that rule: it versions on its own, because it depends only on the library's public API — it is the first external consumer of the schema compatibility policy, and pinning it to the library's version would un-prove exactly what it exists to prove.

**Markdown is one line per paragraph.** Do not hard-wrap prose at a column, and do not re-wrap what is here. A single newline inside a paragraph is a space to CommonMark, so wrapped and unwrapped source render identically — the difference is only what happens when the file is edited. Hard wrapping keeps diffs small, but it needs every editor to re-wrap after a change or the margin drifts, and the WYSIWYG editors used on this repo preserve existing breaks without adding new ones. Unwrapped is the convention that survives being edited by anything.

Table rows, headings and fenced blocks are one line each already and are not prose. A deliberate line break inside a paragraph is `<br/>`, or two trailing spaces — a bare newline will not do it.

**Make the diffs readable.** The cost of that convention is that changing one word reports the whole paragraph as rewritten. `tools/md-sentences.py` is a textconv filter that breaks prose onto one line per sentence *for diffing only* — the file on disk never changes, and only what git compares does. Wire it up once per clone:

```
git config diff.markdown.textconv      "$PWD/tools/md-sentences.py"
git config diff.markdown.cachetextconv true
```

`.gitattributes` already points `*.md` at that driver. The command itself has to be local rather than committed, because git refuses to let a repository specify programs it will run — a clone should never execute something that arrived with it.

Two things to know. A textconv diff is for reading, not applying: `git apply` will reject one, and `git diff --no-textconv` is how to get a real patch. And `git diff --word-diff` needs no setup at all, so it stays the answer for a one-off look.

## Commands

```
npm run build        # both workspaces
npm run typecheck
npm run lint         # eslint, --max-warnings 0
npm test             # needs an MQTT broker for the MQTT tests:
                     # docker compose -f docker-compose/docker-compose.yml up -d
```

Without a broker the MQTT tests skip themselves, which is right on a laptop and wrong in CI - a run that reports itself green having quietly skipped a third of the suite is the run somebody trusts. `SOURCE_RPC_REQUIRE_BROKER=1` turns that skip into a failure, and `.github/workflows/ci.yml` sets it alongside the broker it starts. A new test file that talks to a broker needs the same guard in its `test.before`; the seven that have one are identical, so copy the nearest.
