import ConcurrencyCutChip, { SessionQueuedMarker } from './ConcurrencyCutChip'
import InboundLinkChip from './InboundLinkChip'

/**
 * The status chips the chat header shows after the session title, in order:
 * the inbound-channel link, the adaptive controller's concurrency cut, and the
 * open session's own queued marker. Each renders nothing (or an empty live
 * region) when it has nothing to say, so the row only grows while one does.
 */
export default function ChatHeaderChips({ slotKey }: { slotKey?: string }) {
  return (
    <>
      <InboundLinkChip slotKey={slotKey} />
      <ConcurrencyCutChip />
      <SessionQueuedMarker slotKey={slotKey} />
    </>
  )
}
