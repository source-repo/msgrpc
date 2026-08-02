#!/usr/bin/env python3
"""
Break Markdown prose onto one line per sentence, for `git diff` and nothing else.

Markdown in this repository is one line per paragraph, because a hard-wrapped file cannot be edited
without re-wrapping it by hand and every editor already flows text at the right margin. The cost is
the diff: change one word and git reports the whole paragraph as rewritten, which is unreadable in
review and useless in `git log -p`.

This is a textconv filter. Git runs it over both sides before diffing, so the *diff* sees sentences
while the *file* stays paragraphs. Nothing on disk changes and nothing about the file's content is
affected - only what git compares.

Wire it up once per clone:

    git config diff.markdown.textconv      "$PWD/tools/md-sentences.py"
    git config diff.markdown.cachetextconv true

`.gitattributes` already points `*.md` at the `markdown` driver. The command has to be configured
locally rather than committed, because git deliberately refuses to let a repository specify programs
it will run - a clone of somebody else's work should never execute a command that arrived with it.

Two things worth knowing. A textconv diff is for reading, not for applying: `git diff` output taken
through this filter is not a patch, and git says so when you ask for one. And `git diff --word-diff`
needs none of this, so it stays the answer for a one-off look.
"""
import re
import sys

# A sentence ends at . ? or ! followed by space and something that starts a new one - a capital, a
# digit, an opening quote, or the bold marker a paragraph in this repository often opens with.
# Deliberately conservative: splitting a little too rarely costs a longer diff line, while splitting
# mid-sentence would produce noise that looks like a change and is not.
SENTENCE_END = re.compile(r'(?<=[.?!])[ ]+(?=(?:\*\*|["\'`(\[]|[A-Z0-9]))')

# Abbreviations that end in a period and do not end a sentence. Short list on purpose: a wrong split
# here is cosmetic, and a long list is a maintenance burden for a diff aid.
ABBREVIATIONS = re.compile(r'\b(?:e\.g|i\.e|cf|vs|etc|Dr|Mr|Ms|St|No|Fig|approx)\.$', re.I)


def split_prose(line: str) -> list[str]:
    if len(line) < 200:
        return [line]
    parts, out = SENTENCE_END.split(line), []
    for part in parts:
        # Re-join what an abbreviation split by mistake.
        if out and ABBREVIATIONS.search(out[-1]):
            out[-1] = f'{out[-1]} {part}'
        else:
            out.append(part)
    return out


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write('usage: md-sentences.py <file>\n')
        return 2
    try:
        with open(sys.argv[1], encoding='utf-8', errors='replace') as handle:
            source = handle.read()
    except OSError as e:
        # A textconv filter that fails takes the diff with it, so an unreadable file is reported and
        # the original is left to git rather than turning a missing file into a broken diff.
        sys.stderr.write(f'md-sentences: {e}\n')
        return 1

    out, fenced = [], False
    for line in source.split('\n'):
        stripped = line.lstrip()
        if stripped.startswith('```') or stripped.startswith('~~~'):
            fenced = not fenced
            out.append(line)
        # Code, tables and indented blocks are left exactly as they are: they are not prose, and
        # their lines are already short enough to diff.
        elif fenced or stripped.startswith(('|', '    ', '\t')) or not stripped:
            out.append(line)
        else:
            out.extend(split_prose(line))
    sys.stdout.write('\n'.join(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
