/** The sidebar's session sort: read from the gateway config, written by the sort
 *  menu, and the one-time carry-over of a choice an earlier build kept in this
 *  browser. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, type QueryClient } from '@tanstack/react-query'
import { useOptimisticConfigPaths, setConfigPathValue } from '../settings/useOptimisticConfigPaths'
import { useSessionSortKey } from '../../hooks/useSessionSortKey'
import { api } from '../../api/client'
import { errMessage } from '../../utils/thunkError'
import { i18nT } from '../../i18n/t'
import { safeRemoveItem } from '../../utils/safeStorage'
import {
  DEFAULT_SESSION_SORT, LEGACY_SESSION_SORT_STORAGE_KEY, SESSION_SORT_CONFIG_PATH,
  readLegacySessionSortKey, type SortKey,
} from '../chat/sessionOrder'

type SessionSortWrite = { key: SortKey; carryOver: boolean }

export interface SessionSort {
  sortKey: SortKey
  setSortKey: (key: SortKey) => void
  /**
   * Why the last pick from the menu did not take, for the sidebar's notice: ''
   * once a newer pick starts or the notice is dismissed. A carry-over failure is
   * never reported; the person did not ask for that write.
   */
  sortError: string
  dismissSortError: () => void
}

export function useSessionSort({ queryClient }: { queryClient: QueryClient }): SessionSort {
  const cfgOverlay = useOptimisticConfigPaths(queryClient)
  const { sortKey: storedSortKey, known } = useSessionSortKey()
  const [sortError, setSortError] = useState('')
  // Drawn optimistically, unlike the folder order: nothing outside this browser
  // orders sessions by this value, so a pick re-sorts at once, as it did when
  // the choice lived in local storage, and a refused save puts the stored
  // order back with the failure said.
  const sortKey = cfgOverlay.shown(SESSION_SORT_CONFIG_PATH, storedSortKey)
  const overlayOpts = cfgOverlay.mutationOpts<SessionSortWrite>({
    queryKey: ['kirocrewConfig'],
    mutationFn: ({ key }) => api.patchConfig(SESSION_SORT_CONFIG_PATH, key),
    path: () => SESSION_SORT_CONFIG_PATH,
    displayValue: ({ key }) => key,
    applyToCache: (cached, { key }) => setConfigPathValue(cached, SESSION_SORT_CONFIG_PATH, key),
    onFailure: (e, { carryOver }) => {
      if (!carryOver) setSortError(errMessage(e) || i18nT('components.errorBoundary.something_went_wrong'))
    },
    onSupersede: () => setSortError(''),
  })
  const sortMut = useMutation({
    ...overlayOpts,
    // Any save that lands, carried or picked, leaves nothing in this browser to
    // carry. Kept on the mutation, not on one mutate call: a call's own
    // callbacks are dropped when a later call starts, so a pick made while the
    // carry-over is in flight would leave a stale browser value for the next
    // load to write over that pick.
    onSuccess: (data, vars, token) => {
      safeRemoveItem(LEGACY_SESSION_SORT_STORAGE_KEY)
      return overlayOpts.onSuccess(data, vars, token)
    },
    // One save on the wire at a time, in pick order, so the server persists the
    // last pick rather than whichever request arrived last.
    scope: { id: SESSION_SORT_CONFIG_PATH },
  })
  const { mutate } = sortMut
  // Whether this load's carry-over has been decided (see the effect below).
  const carryChecked = useRef(false)
  const setSortKey = useCallback((key: SortKey) => {
    // A pick decides the carry-over too: nothing older may follow it. Without
    // this, a pick made before the first config read lands lets that read (it
    // still shows the default) queue the carried value behind the pick, and
    // the carried value is then what the gateway keeps.
    carryChecked.current = true
    mutate({ key, carryOver: false })
  }, [mutate])
  const dismissSortError = useCallback(() => setSortError(''), [])

  // Carry-over: an earlier build kept the choice in this browser only. Once the
  // gateway's value is known, a valid browser choice is written there only when
  // the gateway still holds the default, so a choice made in another browser is
  // never overwritten. The browser key is removed once nothing is left to carry:
  // straight away when it is skipped, after a save lands when it is carried (the
  // mutation's onSuccess above), so a refused write leaves it for the next load
  // to try again.
  useEffect(() => {
    if (!known || carryChecked.current) return
    carryChecked.current = true
    const legacy = readLegacySessionSortKey()
    if (legacy === null || legacy === DEFAULT_SESSION_SORT || storedSortKey !== DEFAULT_SESSION_SORT) {
      safeRemoveItem(LEGACY_SESSION_SORT_STORAGE_KEY)
      return
    }
    mutate({ key: legacy, carryOver: true })
  }, [known, storedSortKey, mutate])

  return { sortKey, setSortKey, sortError, dismissSortError }
}
