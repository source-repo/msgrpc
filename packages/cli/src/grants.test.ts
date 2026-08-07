import test from 'ava'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grantLines, loadAiGrants } from './grants.js'

const withFile = (contents: string, run: (path: string) => void) => {
    const directory = mkdtempSync(join(tmpdir(), 'source-rpc-grants-'))
    const path = join(directory, 'grants.json')
    writeFileSync(path, contents)
    try {
        run(path)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}

/**
 * The whole point of the document is that it refuses rather than degrades. A node that starts
 * holding a policy it could not read is the failure this exists to prevent, and "carry on with
 * nothing granted" is a quiet answer to a loud problem - the operator meant to grant something.
 */
test('a grants document that cannot be read refuses, naming the file and the reason', (t) => {
    withFile('{ not json', (path) => {
        const failure = t.throws(() => loadAiGrants(path))
        t.regex(failure.message, /cannot read grants from/)
        t.true(failure.message.includes(path))
    })

    withFile(JSON.stringify({ grants: 2, revision: 1 }), (path) => {
        const failure = t.throws(() => loadAiGrants(path))
        t.true(failure.message.includes(path), 'the reason has to name the file somebody must go and edit')
        t.regex(failure.message, /unsupported document version/)
    })

    withFile(JSON.stringify({ grants: 1, revision: 1, open: { 'ai.tool.wright': {} } }), (path) => {
        t.regex(t.throws(() => loadAiGrants(path))!.message, /'ai.tool.wright' is not a grant this library defines/)
    })

    withFile(JSON.stringify({ grants: 1, open: {} }), (path) => {
        t.regex(t.throws(() => loadAiGrants(path))!.message, /revision must be a number/)
    })
})

test('a document with nothing open is valid, and says so rather than saying nothing', (t) => {
    withFile(JSON.stringify({ grants: 1, revision: 4 }), (path) => {
        const grants = loadAiGrants(path)
        t.is(grants.revision, 4)
        t.deepEqual(grantLines(grants), ['grants revision 4: nothing open, so AI principals may observe and nothing else'])
    })
})

test('with no document at all the report still says what that means', (t) => {
    t.deepEqual(grantLines(undefined), ['no grants document, so AI principals may observe and nothing else'])
})

test('what is open is reported with its bounds, and an expired grant is simply not open', (t) => {
    const now = 1_000_000
    const grants = {
        grants: 1 as const,
        revision: 7,
        open: {
            'ai.tool.write': { to: ['bench'], expiresAt: now + 60_000 },
            'ai.program.write': { roles: ['commissioning'], maxGeneration: 2 },
            // Already lapsed at `now`, so it must not be listed as open - which is not the same
            // as it having been taken out of the file, and the file is what a reviewer diffs.
            'ai.program.program': { to: ['bench'], expiresAt: now - 1 }
        }
    }
    const lines = grantLines(grants, now)
    t.is(lines[0], 'grants revision 7:')
    t.true(lines.some((line) => line.includes('ai.tool.write') && line.includes('to bench') && line.includes('until ')))
    t.true(lines.some((line) => line.includes('ai.program.write') && line.includes('roles commissioning') && line.includes('generation 2')))
    t.false(lines.some((line) => line.includes('ai.program.program')), 'an expired grant is not open')
    // An unbounded grant is a real choice; it should not read as though somebody forgot the lease.
    t.true(lines.some((line) => line.includes('ai.program.write') && line.includes('no expiry')))
})
