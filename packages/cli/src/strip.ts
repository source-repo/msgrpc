import { Project, SyntaxKind, type ClassDeclaration, type Decorator } from 'ts-morph'
import type { Diagnostic } from './extract.js'

/**
 * Rewrites a decorated source file into the decorator-free twin that Node's type stripping can run.
 *
 * The decorators this library uses are standard ECMAScript, which V8 does not ship - so a script
 * written the natural way dies with a SyntaxError at the first `@` when run directly. The CLI
 * already understands these decorators, because extraction reads them; this gives it the second
 * role: strip them out and append the runtime equivalents - `declareRpcNamespace` and
 * `exposeMethods` - which say exactly the same things through the same records.
 *
 * Two properties are load-bearing. **Line numbers do not move**: a removed decorator is blanked to
 * whitespace of the same shape (newlines kept), and everything added goes at the end of the file,
 * so a stack trace from the stripped twin points at the same line as the decorated source. And
 * **only the library's decorators are understood**: any other decorator is reported rather than
 * guessed at, because stripping a decorator whose runtime effect we cannot reproduce would change
 * what the program means and call that a success.
 */

export interface StripOutcome {
    output: string
    /** How many decorators were replaced by runtime marks. 0 means the twin is the original. */
    stripped: number
    problems: Diagnostic[]
}

/**
 * The `{ ... }` a decorator carried, or the empty options a bare `@rpc` means. Collapsed onto one
 * line, because the mark is inserted on the class's closing-brace line and must not add newlines.
 */
const optionsTextOf = (decorator: Decorator) => {
    if (!decorator.isDecoratorFactory()) return '{}'
    const [options] = decorator.getArguments()
    return options?.getText().replace(/\s*\n\s*/g, ' ') ?? '{}'
}

/** A method name as an object key: bare when it is a usable identifier, quoted when not. */
const asKey = (name: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name))

export const stripSource = (source: string, fileName = 'script.ts'): StripOutcome => {
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: false } })
    const file = project.createSourceFile(fileName, source)
    const problems: Diagnostic[] = []
    /** [start, end) spans to blank out. */
    const spans: [number, number][] = []
    /**
     * Mark calls inserted at the class's closing brace, not appended at the end of the file: a
     * script exposes its class somewhere below the declaration, and marks that ran after the whole
     * file would run after the expose they exist to inform. On the brace's own line they run the
     * statement after the class exists and add no newline, so nothing below moves.
     */
    const insertions: { at: number; text: string }[] = []
    let needsNamespace = false
    let needsMethods = false
    const handled = new Set<Decorator>()

    const stripClass = (declaration: ClassDeclaration) => {
        const className = declaration.getName()
        const where = className ?? '(anonymous class)'
        const marks: string[] = []
        for (const decorator of declaration.getDecorators()) {
            if (decorator.getName() !== 'rpcNamespace') continue
            handled.add(decorator)
            if (!className) {
                problems.push({ where, reason: 'an anonymous class cannot be re-marked by name - give it one' })
                continue
            }
            const argumentsText = decorator
                .getArguments()
                .map((argument) => argument.getText().replace(/\s*\n\s*/g, ' '))
                .join(', ')
            spans.push([decorator.getStart(), decorator.getEnd()])
            marks.push(`__rpcNamespace(${className}, ${argumentsText})`)
            needsNamespace = true
        }
        const methods: string[] = []
        for (const method of declaration.getMethods()) {
            for (const decorator of method.getDecorators()) {
                if (decorator.getName() !== 'rpc') continue
                handled.add(decorator)
                if (!className) {
                    problems.push({ where: `${where}.${method.getName()}`, reason: 'an anonymous class cannot be re-marked by name - give it one' })
                    continue
                }
                if (method.isStatic()) {
                    // The decorator would have thrown at runtime; stripping must not launder it.
                    problems.push({ where: `${className}.${method.getName()}`, reason: '@rpc: static methods cannot be exposed' })
                    continue
                }
                spans.push([decorator.getStart(), decorator.getEnd()])
                methods.push(`${asKey(method.getName())}: ${optionsTextOf(decorator)}`)
            }
        }
        if (methods.length && className) {
            marks.push(`__rpcMethods(${className}, { ${methods.join(', ')} })`)
            needsMethods = true
        }
        if (marks.length) insertions.push({ at: declaration.getEnd(), text: `; ${marks.join('; ')}` })
    }

    // Only classes that are statements of the file itself: a class inside a function would need
    // its marks inside that function, and appending them at top level would reference a name that
    // does not exist there. Reported below when such a class carries our decorators.
    for (const declaration of file.getClasses()) stripClass(declaration)

    // Every decorator in the file has to be one we replaced: an unknown one has a runtime effect
    // this cannot reproduce, and one on a nested class would lose its mark silently.
    for (const decorator of file.getDescendantsOfKind(SyntaxKind.Decorator)) {
        if (handled.has(decorator)) continue
        const name = decorator.getName()
        problems.push({
            where: decorator.getFirstAncestorByKind(SyntaxKind.ClassDeclaration)?.getName() ?? name,
            reason:
                name === 'rpc' || name === 'rpcNamespace'
                    ? `@${name} sits on something strip cannot re-mark from the top level - only methods of classes declared as statements of the file are handled`
                    : `@${name} is not a decorator this library defines, so stripping it would change what the program means`
        })
    }

    if (problems.length) return { output: source, stripped: 0, problems }
    if (!spans.length) return { output: source, stripped: 0, problems: [] }

    // Blank the decorator spans in place, keeping every newline, so nothing below them moves.
    const characters = [...source]
    for (const [start, end] of spans) for (let index = start; index < end; index++) if (characters[index] !== '\n') characters[index] = ' '
    let body = characters.join('')
    // Highest offset first, so each splice leaves the earlier offsets true.
    for (const { at, text } of [...insertions].sort((a, b) => b.at - a.at)) body = `${body.slice(0, at)}${text}${body.slice(at)}`
    const imports: string[] = []
    if (needsNamespace) imports.push('declareRpcNamespace as __rpcNamespace')
    if (needsMethods) imports.push('exposeMethods as __rpcMethods')
    // The import sits at the end, and legally so: ESM hoists import bindings before any module
    // code runs, so the marks on each class's closing-brace line already see these names.
    const appended = [
        '',
        '// Added by source-rpc strip: the decorators above are blanked out - Node cannot run them -',
        '// and re-said as runtime marks on the closing line of each class. Line numbers are unchanged.',
        `import { ${imports.join(', ')} } from '@source-repo/rpc'`,
        ''
    ].join('\n')
    return { output: `${body}${body.endsWith('\n') ? '' : '\n'}${appended}`, stripped: spans.length, problems: [] }
}
