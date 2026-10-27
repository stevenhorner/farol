import { describe, expect, it } from 'vitest'
import type { ChangedFile } from '../../src/git/types.js'
import { sqlFindings, sqlTokens } from '../../src/signals/sql.js'

const changed = (text: string, lines?: number[]): { file: ChangedFile; read: (p: string) => string } => ({
  file: { path: 'db/x.sql', status: 'modified', added: (lines ?? text.split('\n').map((_, i) => i + 1)).map((line) => ({ line, text: '' })), removed: [] } as unknown as ChangedFile,
  read: () => text,
})
const find = (text: string, lines?: number[]): string[] => {
  const { file, read } = changed(text, lines)
  return sqlFindings([file], read, () => false).map((f) => `${f.line} ${f.severity} ${f.message}`)
}

describe('SQL tokens', () => {
  it('skips comments, strings and quoted identifiers, counting lines', () => {
    const tokens = sqlTokens("/* DROP /* nested */ TABLE */ SELECT 'it''s; DROP' -- DELETE\nFROM [drop table]")
    expect(tokens.map((t) => `${t.line}:${t.word}`)).toEqual(["1:SELECT", "1:'", '2:FROM', '2:ID'])
  })
})

describe('destructive SQL', () => {
  it('flags statements that destroy data', () => {
    expect(find('TRUNCATE TABLE orders;\nDROP INDEX ix_orders ON orders;\nEXEC sp_rename \'orders.total\', \'amount\';\nALTER TABLE orders ALTER COLUMN total DECIMAL(12, 2);')).toEqual([
      '1 high TRUNCATE removes every row',
      '2 medium DROP INDEX removes a database object',
      '3 medium sp_rename renames an object its users still name',
      "4 medium ALTER COLUMN changes a column's type or nullability",
    ])
  })

  it('reads the statement after a CTE, and WHERE outside subqueries only', () => {
    expect(find('WITH old AS (SELECT id FROM orders WHERE total = 0)\nDELETE FROM orders')).toEqual(['1 high DELETE without WHERE removes every row'])
    expect(find('UPDATE orders SET total = (SELECT 0 WHERE 1 = 1)')).toEqual(['1 high UPDATE without WHERE changes every row'])
    expect(find('UPDATE orders SET total = 0 WHERE id IN (SELECT id FROM old)')).toEqual([])
  })

  it('splits batches on GO and only reports statements on added lines', () => {
    expect(find('DROP TABLE a\nGO\nDROP TABLE b', [3])).toEqual(['3 high DROP TABLE removes it and its data'])
  })
})
