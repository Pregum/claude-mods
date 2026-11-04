import { expect, test } from 'claude-code/testing'

import { cells, draftOf, dueOf, fit, parseTasks } from '../hooks/tasks'

test('list_tasks の答えを読み、id か題名の無いものは落とす', () => {
  const { tasks, count } = parseTasks(
    JSON.stringify({
      count: 3,
      tasks: [
        { id: 'local/1', title: '一つ目', source: 'local', due: '2026-11-03T00:00:00.000' },
        { id: 'local/2' },
        { title: '題名だけ' },
      ],
    }),
  )
  expect(count).toBe(3)
  expect(tasks.map(todo => todo.id)).toEqual(['local/1'])
  expect(() => parseTasks('{"tasks":"broken"}')).toThrow()
})

const NOW = new Date(2026, 10, 4, 12, 0).getTime()
const local = (d: number, h = 0, m = 0) => {
  const at = new Date(2026, 10, d, h, m)
  return `${at.getFullYear()}-11-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000`
}

test('期限: 時刻の無いものはその日いっぱい今日、過ぎたものは期限切れ', () => {
  expect(dueOf(local(4), NOW)).toEqual({ label: '今日', level: 'today' })
  expect(dueOf(local(3), NOW)).toEqual({ label: '11/3', level: 'over' })
  expect(dueOf(local(5), NOW)).toEqual({ label: '11/5', level: 'later' })
  expect(dueOf(local(4, 17, 5), NOW)).toEqual({ label: '今日 17:05', level: 'today' })
  expect(dueOf(local(4, 9, 30), NOW)?.level).toBe('over')
  expect(dueOf(undefined, NOW)).toBeUndefined()
  expect(dueOf('そのうち', NOW)).toBeUndefined()
})

test('全角は 2 マスで切り、下書きはメモがあれば足す', () => {
  expect(cells('あa')).toBe(3)
  expect(fit('あいうえお', 6)).toBe('あい…')
  expect(draftOf({ id: '1', title: '直す' })).toBe('Todo: 直す')
  expect(draftOf({ id: '1', title: '直す', notes: '手順' })).toBe('Todo: 直す\n\n手順')
})
