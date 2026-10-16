/**
 * `useSessionSort`: the sidebar's session sort read from `dashboard.session_sort`,
 * written through `api.patchConfig`, and the one-time carry-over of the choice an
 * earlier build kept in this browser's local storage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const mocks = vi.hoisted(() => ({
  server: { dashboard: {} as Record<string, unknown> },
  kirocrewConfig: vi.fn(),
  patchConfig: vi.fn(),
}))
vi.mock('../../api/client', () => ({
  api: { kirocrewConfig: mocks.kirocrewConfig, patchConfig: mocks.patchConfig },
}))

import { useSessionSort } from './sessionSort'
import { useSessionSortKey } from '../../hooks/useSessionSortKey'
import type { SortKey } from '../chat/sessionOrder'

const LEGACY = 'mc-session-sort'

function harness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  // Every sort key the sidebar drew, render by render.
  const drawn: SortKey[] = []
  const hook = renderHook(() => {
    const out = useSessionSort({ queryClient: qc })
    drawn.push(out.sortKey)
    return out
  }, { wrapper })
  return { qc, hook, drawn }
}

/** Hold the next patchConfig call until `land()`; landing stores the value on the fake gateway. */
function holdNextPatch(): { land: () => void } {
  const held = { land: () => {} }
  mocks.patchConfig.mockImplementationOnce((path: string, value: unknown) => new Promise(resolve => {
    held.land = () => {
      if (path === 'dashboard.session_sort') mocks.server.dashboard.session_sort = value
      resolve({ ok: true })
    }
  }))
  return held
}

beforeEach(() => {
  localStorage.clear()
  mocks.server = { dashboard: {} }
  mocks.kirocrewConfig.mockReset().mockImplementation(async () => structuredClone(mocks.server))
  mocks.patchConfig.mockReset().mockImplementation(async (path: string, value: unknown) => {
    if (path === 'dashboard.session_sort') mocks.server.dashboard.session_sort = value
    return { ok: true }
  })
})

describe('useSessionSortKey', () => {
  it('reads the stored value and falls back to date-desc for an unknown one', async () => {
    // Fresh for the whole test, so no mount refetch races the cache writes below.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    qc.setQueryData(['kirocrewConfig'], { dashboard: { session_sort: 'name-desc' } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useSessionSortKey(), { wrapper })
    expect(result.current).toEqual({ sortKey: 'name-desc', known: true })
    act(() => { qc.setQueryData(['kirocrewConfig'], { dashboard: { session_sort: 'sideways' } }) })
    await waitFor(() => expect(result.current.sortKey).toBe('date-desc'))
    expect(result.current.known).toBe(true)
  })
})

describe('useSessionSort', () => {
  it('draws the gateway value, and date-desc before a body arrives', async () => {
    mocks.server.dashboard.session_sort = 'created-asc'
    const { hook } = harness()
    expect(hook.result.current.sortKey).toBe('date-desc')
    await waitFor(() => expect(hook.result.current.sortKey).toBe('created-asc'))
  })

  it('a menu pick is written through patchConfig and drawn at once', async () => {
    let land: () => void = () => {}
    const { qc, hook } = harness()
    await waitFor(() => expect(qc.getQueryData(['kirocrewConfig'])).toBeDefined())
    mocks.patchConfig.mockImplementationOnce((path: string, value: unknown) => new Promise(resolve => {
      land = () => { mocks.server.dashboard.session_sort = value; resolve({ ok: true }) }
    }))
    act(() => hook.result.current.setSortKey('name-asc'))
    await waitFor(() => expect(mocks.patchConfig).toHaveBeenCalledWith('dashboard.session_sort', 'name-asc'))
    // Optimistic: the pick is drawn while the save is in flight.
    expect(hook.result.current.sortKey).toBe('name-asc')
    await act(async () => { land() })
    await waitFor(() => expect(mocks.server.dashboard.session_sort).toBe('name-asc'))
    expect(hook.result.current.sortKey).toBe('name-asc')
    expect(hook.result.current.sortError).toBe('')
    expect(localStorage.getItem(LEGACY)).toBeNull()
  })

  it('two quick picks save in pick order, and the last one is drawn and kept', async () => {
    const { qc, hook, drawn } = harness()
    await waitFor(() => expect(qc.getQueryData(['kirocrewConfig'])).toBeDefined())
    const first = holdNextPatch()
    act(() => hook.result.current.setSortKey('name-asc'))
    act(() => hook.result.current.setSortKey('created-desc'))
    expect(hook.result.current.sortKey).toBe('created-desc')
    // One save on the wire at a time: the second waits for the first to land.
    await waitFor(() => expect(mocks.patchConfig).toHaveBeenCalledTimes(1))
    expect(mocks.patchConfig).toHaveBeenLastCalledWith('dashboard.session_sort', 'name-asc')
    await act(async () => { first.land() })
    await waitFor(() => expect(mocks.patchConfig).toHaveBeenCalledTimes(2))
    expect(mocks.patchConfig.mock.calls.map(call => call[1])).toEqual(['name-asc', 'created-desc'])
    await waitFor(() => expect(qc.getQueryData(['kirocrewConfig'])).toEqual({ dashboard: { session_sort: 'created-desc' } }))
    expect(mocks.server.dashboard.session_sort).toBe('created-desc')
    expect(hook.result.current.sortKey).toBe('created-desc')
    // From the second pick on, nothing else is drawn: not the first pick as it
    // lands, not the default.
    expect(new Set(drawn.slice(drawn.indexOf('created-desc')))).toEqual(new Set(['created-desc']))
    expect(hook.result.current.sortError).toBe('')
  })

  it('a refused pick puts the stored order back and says why, until the next pick or a dismiss', async () => {
    mocks.server.dashboard.session_sort = 'date-asc'
    const { hook } = harness()
    await waitFor(() => expect(hook.result.current.sortKey).toBe('date-asc'))
    mocks.patchConfig.mockRejectedValueOnce(new Error('refused'))
    act(() => hook.result.current.setSortKey('name-desc'))
    await waitFor(() => expect(hook.result.current.sortError).toBe('refused'))
    expect(hook.result.current.sortKey).toBe('date-asc')
    // A new pick retires the old notice as it starts.
    const next = holdNextPatch()
    act(() => hook.result.current.setSortKey('name-asc'))
    expect(hook.result.current.sortError).toBe('')
    await waitFor(() => expect(mocks.patchConfig).toHaveBeenLastCalledWith('dashboard.session_sort', 'name-asc'))
    await act(async () => { next.land() })
    await waitFor(() => expect(mocks.server.dashboard.session_sort).toBe('name-asc'))
    // The dismiss clears a notice too.
    mocks.patchConfig.mockRejectedValueOnce(new Error('refused again'))
    act(() => hook.result.current.setSortKey('created-asc'))
    await waitFor(() => expect(hook.result.current.sortError).toBe('refused again'))
    act(() => hook.result.current.dismissSortError())
    expect(hook.result.current.sortError).toBe('')
    expect(hook.result.current.sortKey).toBe('name-asc')
  })

  it('carries a browser-held choice to a gateway on the default once, then clears the local key', async () => {
    localStorage.setItem(LEGACY, 'name-asc')
    const { qc, hook } = harness()
    await waitFor(() => expect(localStorage.getItem(LEGACY)).toBeNull())
    expect(mocks.patchConfig).toHaveBeenCalledTimes(1)
    expect(mocks.patchConfig).toHaveBeenCalledWith('dashboard.session_sort', 'name-asc')
    await waitFor(() => expect(hook.result.current.sortKey).toBe('name-asc'))
    // A later config read back on the default is not a second carry-over.
    localStorage.setItem(LEGACY, 'created-desc')
    mocks.server.dashboard.session_sort = 'date-desc'
    await act(async () => { await qc.invalidateQueries({ queryKey: ['kirocrewConfig'] }) })
    await waitFor(() => expect(hook.result.current.sortKey).toBe('date-desc'))
    expect(mocks.patchConfig).toHaveBeenCalledTimes(1)
  })

  it('never overwrites a non-default gateway value, and still clears the local key', async () => {
    mocks.server.dashboard.session_sort = 'created-asc'
    localStorage.setItem(LEGACY, 'name-asc')
    const { hook } = harness()
    await waitFor(() => expect(localStorage.getItem(LEGACY)).toBeNull())
    expect(hook.result.current.sortKey).toBe('created-asc')
    expect(mocks.patchConfig).not.toHaveBeenCalled()
  })

  it('drops an unknown or default local value without writing anything', async () => {
    for (const stale of ['sideways', 'date-desc']) {
      localStorage.setItem(LEGACY, stale)
      const { hook } = harness()
      await waitFor(() => expect(localStorage.getItem(LEGACY)).toBeNull())
      expect(hook.result.current.sortKey).toBe('date-desc')
      hook.unmount()
    }
    expect(mocks.patchConfig).not.toHaveBeenCalled()
  })

  it('a pick made while the carry-over is in flight clears the local key, so the next load keeps the pick', async () => {
    localStorage.setItem(LEGACY, 'name-asc')
    const carry = holdNextPatch()
    const { hook } = harness()
    await waitFor(() => expect(mocks.patchConfig).toHaveBeenCalledWith('dashboard.session_sort', 'name-asc'))
    // The person picks the default order before the carried value lands.
    act(() => hook.result.current.setSortKey('date-desc'))
    await act(async () => { carry.land() })
    await waitFor(() => expect(mocks.server.dashboard.session_sort).toBe('date-desc'))
    await waitFor(() => expect(localStorage.getItem(LEGACY)).toBeNull())
    hook.unmount()
    // Next load: nothing is left to carry, so the pick is not written over.
    const reload = harness()
    await waitFor(() => expect(reload.qc.getQueryData(['kirocrewConfig'])).toBeDefined())
    await act(async () => {})
    expect(reload.qc.isMutating()).toBe(0)
    expect(mocks.patchConfig).toHaveBeenCalledTimes(2)
    expect(mocks.server.dashboard.session_sort).toBe('date-desc')
    expect(reload.hook.result.current.sortKey).toBe('date-desc')
  })

  it('a pick made before the first config read lands is not followed by a carry-over', async () => {
    localStorage.setItem(LEGACY, 'name-asc')
    const firstRead = { release: () => {} }
    mocks.kirocrewConfig.mockImplementationOnce(() => new Promise(resolve => {
      // The gateway's answer as it stood when the page asked: still the default.
      firstRead.release = () => resolve({ dashboard: {} })
    }))
    const pick = holdNextPatch()
    const { qc, hook, drawn } = harness()
    act(() => hook.result.current.setSortKey('name-desc'))
    await waitFor(() => expect(mocks.patchConfig).toHaveBeenCalledWith('dashboard.session_sort', 'name-desc'))
    // The stale read lands while the pick is still on the wire, and the sidebar
    // renders with it (its effects run) before the pick settles.
    const rendersBefore = drawn.length
    await act(async () => { firstRead.release() })
    await waitFor(() => expect(drawn.length).toBeGreaterThan(rendersBefore))
    await act(async () => {})
    // Only the pick is queued: no carry-over was scheduled behind it.
    expect(qc.isMutating()).toBe(1)
    await act(async () => { pick.land() })
    await waitFor(() => expect(qc.isMutating()).toBe(0))
    expect(mocks.patchConfig).toHaveBeenCalledTimes(1)
    expect(mocks.server.dashboard.session_sort).toBe('name-desc')
    await waitFor(() => expect(hook.result.current.sortKey).toBe('name-desc'))
    expect(localStorage.getItem(LEGACY)).toBeNull()
  })

  it('a refused carry-over keeps the local key for the next load and says nothing', async () => {
    localStorage.setItem(LEGACY, 'name-desc')
    mocks.patchConfig.mockRejectedValueOnce(new Error('refused'))
    const { qc, hook } = harness()
    await waitFor(() => expect(mocks.patchConfig).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(qc.isMutating()).toBe(0))
    expect(hook.result.current.sortKey).toBe('date-desc')
    expect(localStorage.getItem(LEGACY)).toBe('name-desc')
    expect(hook.result.current.sortError).toBe('')
  })
})
