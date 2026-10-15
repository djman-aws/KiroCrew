import { useQuery } from '@tanstack/react-query'
import { Gauge, Hourglass } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { ThrottleView } from '../api/tasks'
import { i18nT } from '../i18n/t'
import { isMemoryWait } from '../pages/chat/subagentQueuedReason'
import { useAppSelector } from '../store'

/**
 * Chat-header chip for a concurrency cut the adaptive controller holds.
 *
 * The controller lowers the execution cap (and the spawn gate for backend
 * starts) under pressure, and while it does, work queues for a slot. The Tasks
 * & capacity card shows that, but the chat tab is where the operator waits, and
 * a turn whose work is queued there reads exactly like a dead session. So the
 * header carries one chip while a cut is in force, naming the reduced cap and
 * how much is queued, and linking to the card that explains it.
 *
 * The gateway decides what counts as a cut (`throttle_view`): a cap below the
 * value a fresh process starts it at. The chip renders that verdict and nothing
 * of its own, so it cannot disagree with the card about whether the cap is low.
 *
 * Beside it, {@link SessionQueuedMarker} marks THIS session when its own
 * subagent starts are among the queued work, so the open tab says whether the
 * cut is what it is waiting on.
 */

/** How often the header re-reads the controller. A cut lasts minutes, not
 *  seconds, and the chip is mounted on every chat page, so this stays slower
 *  than the capacity card's 5 s. */
export const THROTTLE_REFETCH_MS = 15_000

/** The Tasks & capacity card: System > Services on the Developer page. */
export const CAPACITY_CARD_PATH = '/developer?tab=system&plane=services'

/** The controller's cut reading, shared by every header consumer (one query). */
export function useThrottleView(): ThrottleView | undefined {
  const { data } = useQuery({
    queryKey: ['spawnAdaptive'],
    queryFn: () => api.spawnAdaptive(),
    refetchInterval: THROTTLE_REFETCH_MS,
    // A failed read renders nothing rather than a stale or invented cut.
    retry: false,
  })
  return data?.throttle
}

/**
 * The chip's label for a cut, or null when there is none to show. The
 * execution cap is named first because it is the one queued work waits on; a
 * gate-only cut names backend starts, paused or reduced.
 */
export function throttleChipLabel(view: ThrottleView | undefined): string | null {
  if (!view?.cut) return null
  const queued = Math.max(0, Math.floor(Number(view.queued) || 0))
  const exec = view.exec
  if (exec?.cut && exec.cap != null && exec.configured != null) {
    return queued > 0
      ? i18nT('components.concurrencyCutChip.exec_reduced_queued', { cap: exec.cap, configured: exec.configured, queued })
      : i18nT('components.concurrencyCutChip.exec_reduced', { cap: exec.cap, configured: exec.configured })
  }
  const gate = view.gate
  if (gate?.paused) return i18nT('components.concurrencyCutChip.gate_paused')
  if (gate?.cut && gate.cap != null && gate.configured != null) {
    return i18nT('components.concurrencyCutChip.gate_reduced', { cap: gate.cap, configured: gate.configured })
  }
  return null
}

export default function ConcurrencyCutChip() {
  const view = useThrottleView()
  const label = throttleChipLabel(view)
  const hint = i18nT('components.concurrencyCutChip.hint')
  // The live region stays mounted so a cut that lands while the tab is open is
  // announced, and it carries the cut alone: the queued count moves on every
  // read, and announcing each move would talk over the transcript.
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {throttleChipLabel(view ? { ...view, queued: 0 } : undefined) ?? ''}
      </span>
      {label && (
        <Link
          to={CAPACITY_CARD_PATH}
          className="pointer-events-auto inline-flex min-w-0 items-center gap-1.5 rounded-md border border-warn/40 bg-warn/10 px-2 py-0.5 text-[11px] text-text no-underline hover:border-warn transition-colors"
          title={hint}
        >
          <Gauge size={11} className="shrink-0 text-warn" aria-hidden />
          <span className="truncate max-w-[40ch]">{label}</span>
          {/* The hint as a description for touch, keyboard and AT readers, who
              never see a hover title; the label stays the link's name. */}
          <span className="sr-only">{hint}</span>
        </Link>
      )}
    </>
  )
}

/**
 * Marks the open session when its own subagent starts are queued for an
 * execution slot while the controller holds the execution cap below its
 * configured value. A memory wait is left to the sidebar's own memory wording:
 * it waits on free memory, which a cap cut does not explain.
 */
export function SessionQueuedMarker({ slotKey }: { slotKey?: string }) {
  const view = useThrottleView()
  const queued = useAppSelector(st => (slotKey ? st.chat.subagentQueued?.[slotKey] ?? 0 : 0))
  const reason = useAppSelector(st => (slotKey ? st.chat.subagentQueuedReason?.[slotKey] : undefined))
  if (!slotKey || !view?.exec?.cut || queued <= 0 || isMemoryWait(reason)) return null
  const hint = i18nT('components.concurrencyCutChip.session_queued_hint')
  return (
    <span
      className="pointer-events-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-bg-hover px-2 py-0.5 text-[11px] text-muted"
      title={hint}
      data-testid="session-queued-marker"
    >
      <Hourglass size={11} className="shrink-0" aria-hidden />
      {i18nT('components.concurrencyCutChip.session_queued', { queued })}
      <span className="sr-only">{hint}</span>
    </span>
  )
}
