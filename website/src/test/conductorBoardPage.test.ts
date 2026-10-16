// @vitest-environment jsdom
/** The Mate task board, driven with the same field bag as its sandbox. */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const TEMPLATE = resolve(
  __dirname,
  '../../../src/kiro_crew/dashboard_templates/builtin/kirocrew-conductor/template.html',
)
const RAW = readFileSync(TEMPLATE, 'utf-8')

function halves() {
  const doc = new DOMParser().parseFromString(RAW, 'text/html')
  const script = doc.querySelector('script')
  const code = script?.textContent ?? ''
  script?.remove()
  return { code, body: doc.body }
}

const HOSTILE = '<img src=x onerror="window.__pwned=1">'

function item(over: Record<string, unknown> = {}) {
  return { item_id: 'it_1', title: 'the task', state: 'open', status: 'progress', summary: '', pr: null, reason: null, ...over }
}

function mount(fields: Record<string, unknown>, agentic: string[] = ['needs_you']) {
  ;(window as unknown as { kirocrew: unknown }).kirocrew = { fields, agentic, seq: 1, stale: false, missing: [], written_at: {} }
  const { code, body } = halves()
  document.body.replaceChildren(...Array.from(body.childNodes))
  for (const node of Array.from(document.querySelectorAll('[data-dashboard-field]'))) {
    const value = fields[node.getAttribute('data-dashboard-field') ?? '']
    if (value !== undefined) node.textContent = typeof value === 'string' ? value : JSON.stringify(value)
  }
  new Function(code)()
}

const text = (selector: string) => document.querySelector(selector)?.textContent ?? ''
const all = (selector: string) => Array.from(document.querySelectorAll(selector))

describe('kirocrew-conductor at-a-glance page', () => {
  it('puts needs-you before every status and detail section', () => {
    mount({ goal: 'ship the board', items: [], needs_you: ['Approve the merge'] })
    const action = document.getElementById('cb-you')!
    const overview = document.querySelector('.overview')!
    const details = document.getElementById('cb-details')!
    expect(action.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(action.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(text('#cb-you .k')).toBe('Needs you')
  })

  it('keeps task rows in a closed native disclosure', () => {
    mount({ items: [item({ title: 'active task' })] })
    const details = document.getElementById('cb-details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe('Tasks1 total')
    expect(text('#cb-tasks .t')).toBe('active task')
  })

  it('shows only compact goal and progress before task details', () => {
    mount({
      goal: 'ship the board',
      items: [
        item({ item_id: 'a', state: 'accepted', status: 'done' }),
        item({ item_id: 'b', status: 'progress' }),
        item({ item_id: 'c', status: 'done' }),
      ],
    })
    expect(text('h1')).toBe('ship the board')
    expect(text('#cb-meter')).toBe('1 / 3 accepted1 active · 1 review')
    expect(document.querySelector('#cb-meter [role="progressbar"]')).toHaveAttribute('aria-valuenow', '1')
  })

  it('does not repeat task summaries or chat notes', () => {
    mount({
      items: [item({ title: 'short title', summary: 'raw ledger summary' })],
      note: { next: 'chat note text' },
      note_at: '2026-10-13T02:00:00+00:00',
    })
    expect(text('#cb-tasks')).toContain('short title')
    expect(text('#cb-tasks')).not.toContain('raw ledger summary')
    const visible = [text('#cb-you'), text('.overview'), text('#cb-details')].join(' ')
    expect(visible).not.toContain('chat note text')
    expect(document.querySelector('[data-dashboard-field="note"]')).toHaveAttribute('hidden')
  })

  it('does not repeat an action task inside task details', () => {
    mount({
      items: [
        item({ item_id: 'a', title: 'Needs a choice', status: 'question' }),
        item({ item_id: 'b', title: 'Still moving', status: 'progress' }),
      ],
    })
    expect(text('#cb-you .v')).toBe('Needs a choice')
    expect(all('#cb-tasks .t').map((node) => node.textContent)).toEqual(['Still moving'])
  })

  it('keeps a title that looks like markup as text', () => {
    mount({ items: [item({ title: HOSTILE, summary: HOSTILE })] })
    expect(document.querySelector('#cb-tasks img')).toBeNull()
    expect(text('#cb-tasks .t')).toBe(HOSTILE)
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('shows Mate-written actions with a short source label', () => {
    mount({ items: [], needs_you: ['Approve the merge', HOSTILE] })
    expect(all('#cb-you .v').map((node) => node.textContent)).toEqual(['Approve the merge', HOSTILE])
    expect(text('#cb-you .tag')).toBe('from Mate')
    expect(document.querySelector('#cb-you img')).toBeNull()
    expect(document.body.textContent).not.toContain('Nothing sends')
  })

  it('does not add the Mate label to host-derived actions', () => {
    mount({ items: [], needs_you: ['a line'] }, [])
    expect(text('#cb-you .v')).toBe('a line')
    expect(document.querySelector('#cb-you .tag')).toBeNull()
  })

  it('deduplicates a task covered by a Mate-written action', () => {
    mount({
      items: [item({ title: 'Serve operator pages', status: 'blocked', reason: 'approval' })],
      needs_you: ['Approve Serve operator pages'],
    })
    expect(all('#cb-you .v').map((node) => node.textContent)).toEqual(['Approve Serve operator pages'])
  })

  it('shows only a short reason for a blocked task', () => {
    mount({ items: [item({ title: 'stuck one', status: 'blocked', reason: 'approval', summary: 'long raw detail' })] })
    expect(text('#cb-you .v')).toBe('stuck one')
    expect(text('#cb-you .why')).toBe('Blocked · Approval')
    expect(text('#cb-you')).not.toContain('long raw detail')
  })

  it('counts forgotten closed tasks in accepted and total', () => {
    mount({
      items: [item({ state: 'accepted', status: 'done' }), item({ item_id: 'b', status: 'progress' })],
      forgotten: { items: 11, accepted: 8 },
    })
    expect(text('#cb-meter')).toContain('9 / 13 accepted')
    expect(text('#cb-count')).toBe('13 total')
    const bar = document.querySelector('#cb-meter [role="progressbar"]')
    expect(bar).toHaveAttribute('aria-valuemax', '13')
    expect(bar).toHaveAttribute('aria-valuenow', '9')
  })

  it('hides round and update stamps until each has a value', () => {
    mount({ round: 0, items: [] })
    expect((document.getElementById('cb-round') as HTMLElement).hidden).toBe(true)
    expect((document.getElementById('cb-updated') as HTMLElement).hidden).toBe(true)
    mount({ round: 2, last_entry_at: '2026-10-13T02:00:00+00:00', items: [] })
    expect((document.getElementById('cb-round') as HTMLElement).hidden).toBe(false)
    expect((document.getElementById('cb-updated') as HTMLElement).hidden).toBe(false)
  })

  it('keeps omitted rows inside details with a short chat action', () => {
    mount({ items: [item()], omitted: 3 })
    expect(text('#cb-more')).toBe('3 hiddenShow all in chat')
    mount({ items: [item()], omitted: 0 })
    expect((document.getElementById('cb-more') as HTMLElement).hidden).toBe(true)
  })

  it('offers Reply through the composer-only bridge', () => {
    const sent: unknown[] = []
    const spy = vi.spyOn(window.parent, 'postMessage').mockImplementation((message: unknown) => { sent.push(message) })
    mount({ items: [], needs_you: ['Approve the push'] })
    ;(document.querySelector('#cb-you button.reply') as HTMLButtonElement).click()
    expect(sent).toEqual([{ type: 'kirocrew-dashboard:act', text: 'About "Approve the push": ' }])
    expect(text('#cb-you button.reply')).toBe('Reply')
    spy.mockRestore()
  })

  it('has clear quiet and empty states', () => {
    mount({})
    expect(text('h1')).toBe('No goal yet')
    expect(text('#cb-you')).toBe('No action needed')
    expect(text('#cb-tasks')).toBe('No other tasks')
  })
})
