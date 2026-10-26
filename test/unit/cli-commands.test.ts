import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { cliNodes } from '../../src/backend/cli.js'

const keys = (code: string) => cliNodes(ts.createSourceFile('cli.ts', code, ts.ScriptTarget.Latest, true)).map((n) => [n.key, n.value.getText(), n.computed ?? false])

describe('command-line commands', () => {
  it('reads commander and cac commands with their action handler', () => {
    expect(keys("program.command('analyze').description('x').option('--out <f>').action((o) => analyze(o))\ncli.command('build [root]', 'Build').action(build)")).toEqual([
      ['CLI analyze', '(o) => analyze(o)', false],
      ['CLI build', 'build', false],
    ])
  })

  it('reads yargs commands with the handler as the last argument, and the default command', () => {
    expect(keys("yargs(argv).command('serve [port]', 'start', (y) => y, serve).command('$0', 'help', {}, (a) => help(a))")).toEqual([
      ['CLI (default)', '(a) => help(a)', false],
      ['CLI serve', 'serve', false],
    ])
  })

  it('keeps a computed command name with the expression in braces, marked as computed', () => {
    expect(keys('program.command(names.sync).action(sync)')).toEqual([['CLI {names.sync}', 'sync', true]])
  })

  it('leaves out an action that is not a command, and commands without a handler', () => {
    expect(keys("store.dispatch(action)\nbutton.action(onClick)\nprogram.command('install', 'install packages')\nredis.command('GET', key, cb)")).toEqual([])
  })
})
