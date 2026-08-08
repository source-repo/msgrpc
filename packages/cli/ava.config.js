export default {
    files: ['dist/**/*.test.js'],
    workerThreads: false,
    /**
     * A ceiling on silence, not on slowness: ava resets this on every completed assertion, so a
     * test that is still doing something is never cut off - only one that has stopped. Without it a
     * single wedged test runs forever, which on a suite full of real sockets and spawned child
     * processes is one missed `close()` away, and the failure looks like nothing at all happening.
     * The longest legitimate quiet spell here is a watch window, at 60 seconds.
     */
    timeout: '2m'
}
