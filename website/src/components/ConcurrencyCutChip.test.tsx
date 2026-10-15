// ConcurrencyCutChip — the chat header's chip while the adaptive controller
// holds a concurrency cut, and the per-session marker beside it. Both render the
// gateway's own `throttle` verdict from GET /api/spawn/adaptive; nothing here
// decides on its own whether a cap is low.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { createTestStore, renderWithProviders } from '../test/helpers'
import ChatHeaderChips from './ChatHeaderChips'
import ConcurrencyCutChip, { CAPACITY_CARD_PATH, SessionQueuedMarker, throttleChipLabel } from './ConcurrencyCutChip'
import { api } from '../api/client'
import { sseSubagentQueued } from '../store/chatSlice'
import { i18nT } from '../i18n/t'
import type { SpawnAdaptiveResponse, ThrottleView } from '../api/tasks'

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>()
  return { ...mod, api: { ...mod.api, spawnAdaptive: vi.fn() } }
})

const spawnAdaptive = vi.mocked(api.spawnAdaptive)

const execCut: ThrottleView = {
  cut: true,
  exec: { cap: 2, configured: 8, cut: true },
  gate: { cap: 4, configured: 4, cut: false, paused: false },
  queued: 5,
}

function answer(throttle: ThrottleView | undefined) {
  const body: SpawnAdaptiveResponse = { adaptive: {}, ...(throttle ? { throttle } : {}) }
  spawnAdaptive.mockResolvedValue(body)
}

afterEach(() => { vi.clearAllMocks() })

describe('throttleChipLabel', () => {
  it('names nothing without a cut', () => {
    expect(throttleChipLabel(undefined)).toBeNull()
    expect(throttleChipLabel({ cut: false })).toBeNull()
  })

  it('names the reduced execution cap and the queue behind it', () => {
    expect(throttleChipLabel(execCut)).toBe(
      i18nT('components.concurrencyCutChip.exec_reduced_queued', { cap: 2, configured: 8, queued: 5 }),
    )
    expect(throttleChipLabel({ ...execCut, queued: 0 })).toBe(
      i18nT('components.concurrencyCutChip.exec_reduced', { cap: 2, configured: 8 }),
    )
  })

  it('names backend starts when only the spawn gate is cut', () => {
    const gateOnly: ThrottleView = {
      cut: true,
      exec: { cap: 8, configured: 8, cut: false },
      gate: { cap: 1, configured: 4, cut: true, paused: false },
      queued: 0,
    }
    expect(throttleChipLabel(gateOnly)).toBe(
      i18nT('components.concurrencyCutChip.gate_reduced', { cap: 1, configured: 4 }),
    )
    expect(throttleChipLabel({ ...gateOnly, gate: { ...gateOnly.gate!, paused: true } })).toBe(
      i18nT('components.concurrencyCutChip.gate_paused'),
    )
  })
})

describe('ConcurrencyCutChip', () => {
  it('renders an empty live region while no cut is in force', async () => {
    answer({ cut: false })
    renderWithProviders(<ConcurrencyCutChip />)
    await waitFor(() => expect(spawnAdaptive).toHaveBeenCalled())
    const region = screen.getByRole('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.textContent).toBe('')
  })

  it('renders nothing for an older gateway that sends no throttle reading', async () => {
    answer(undefined)
    renderWithProviders(<ConcurrencyCutChip />)
    await waitFor(() => expect(spawnAdaptive).toHaveBeenCalled())
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('shows the cut as a link to the capacity card and announces the cut alone', async () => {
    answer(execCut)
    renderWithProviders(<ConcurrencyCutChip />)
    const label = i18nT('components.concurrencyCutChip.exec_reduced_queued', { cap: 2, configured: 8, queued: 5 })
    const hint = i18nT('components.concurrencyCutChip.hint')
    const chip = await screen.findByText(label)
    const link = chip.closest('a')!
    expect(link.getAttribute('href')).toBe(CAPACITY_CARD_PATH)
    expect(link.getAttribute('title')).toBe(hint)
    // The label stays the link's name; the hint reaches touch and AT readers as
    // visually hidden text, not as an aria-label that would replace the name.
    expect(link.getAttribute('aria-label')).toBeNull()
    expect(link).toHaveAccessibleName(expect.stringContaining(label))
    expect(link.querySelector('.sr-only')?.textContent).toBe(hint)
    // The live region names the cut without the queued count, which moves on
    // every read and would otherwise be re-announced each time.
    expect(screen.getByRole('status').textContent).toBe(
      i18nT('components.concurrencyCutChip.exec_reduced', { cap: 2, configured: 8 }),
    )
  })
})

describe('SessionQueuedMarker', () => {
  const marker = (queued: number) => i18nT('components.concurrencyCutChip.session_queued', { queued })
  const execLabel = i18nT('components.concurrencyCutChip.exec_reduced_queued', { cap: 2, configured: 8, queued: 5 })
  // The chip renders beside the marker so a test can wait for the reading to
  // land before it asserts that the marker stayed silent.
  const header = (slotKey: string) => (
    <>
      <ConcurrencyCutChip />
      <SessionQueuedMarker slotKey={slotKey} />
    </>
  )

  it('marks the session whose subagent starts wait while the execution cap is cut', async () => {
    answer(execCut)
    const store = createTestStore()
    store.dispatch(sseSubagentQueued({ slot: 's1', queued: 3 }))
    renderWithProviders(header('s1'), { store })
    const el = await screen.findByTestId('session-queued-marker')
    const hint = i18nT('components.concurrencyCutChip.session_queued_hint')
    expect(el.textContent).toContain(marker(3))
    expect(el.getAttribute('title')).toBe(hint)
    expect(el.querySelector('.sr-only')?.textContent).toBe(hint)
    act(() => { store.dispatch(sseSubagentQueued({ slot: 's1', queued: 0 })) })
    expect(screen.queryByTestId('session-queued-marker')).toBeNull()
  })

  it('stays silent for a session with nothing queued', async () => {
    answer(execCut)
    const store = createTestStore()
    store.dispatch(sseSubagentQueued({ slot: 'other', queued: 2 }))
    renderWithProviders(header('s1'), { store })
    await screen.findByText(execLabel)
    expect(screen.queryByTestId('session-queued-marker')).toBeNull()
  })

  it('stays silent when only the spawn gate is cut', async () => {
    answer({ ...execCut, exec: { cap: 8, configured: 8, cut: false }, gate: { cap: 1, configured: 4, cut: true, paused: false } })
    const store = createTestStore()
    store.dispatch(sseSubagentQueued({ slot: 's1', queued: 3 }))
    renderWithProviders(header('s1'), { store })
    // The gate label is in the link and in the live region alike.
    await screen.findByRole('link', { name: new RegExp(i18nT('components.concurrencyCutChip.gate_reduced', { cap: 1, configured: 4 })) })
    expect(screen.queryByTestId('session-queued-marker')).toBeNull()
  })

  it('leaves a memory wait to its own wording', async () => {
    answer(execCut)
    const store = createTestStore()
    store.dispatch(sseSubagentQueued({ slot: 's1', queued: 3, reason: 'low_memory', available_gb: 1, required_gb: 2 }))
    renderWithProviders(header('s1'), { store })
    await screen.findByText(execLabel)
    expect(screen.queryByTestId('session-queued-marker')).toBeNull()
  })
})

describe('ChatHeaderChips', () => {
  it('mounts the cut chip and the session marker in the header row', async () => {
    answer(execCut)
    const store = createTestStore()
    store.dispatch(sseSubagentQueued({ slot: 's1', queued: 2 }))
    renderWithProviders(<ChatHeaderChips slotKey="s1" />, { store })
    const label = i18nT('components.concurrencyCutChip.exec_reduced_queued', { cap: 2, configured: 8, queued: 5 })
    expect((await screen.findByText(label)).closest('a')?.getAttribute('href')).toBe(CAPACITY_CARD_PATH)
    expect((await screen.findByTestId('session-queued-marker')).textContent).toContain(
      i18nT('components.concurrencyCutChip.session_queued', { queued: 2 }),
    )
  })
})
