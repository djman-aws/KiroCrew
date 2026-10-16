/**
 * Markdown-only agents on a harness that cannot load them.
 *
 * An agent defined only as `~/.kiro/agents/<name>.md` runs on the harnesses the
 * gateway names in `markdown_spec_backends` (`ACP_BACKENDS_MARKDOWN_AGENT_SPECS`)
 * and nowhere else: kiro-cli loads JSON specs only, so it refuses the session
 * after the pick. The catalog (`GET /api/agents/catalog`) sends the per-row fact
 * (`markdown_only`), the harness the asking chat runs (`session_backend`) and
 * the capable set; this module turns those into the row's badge. Display-only:
 * the row stays selectable and the gateway's own refusal still explains a pick.
 */

/** Why a row would not start here: the harness it would run on and the ones that can. */
export interface MarkdownBlock {
  /** The harness this chat (or, with no chat, a new session) runs, config spelling. */
  backend: string
  /** The harnesses that load a markdown spec, config spelling, in server order. */
  capable: string[]
}

/** The catalog body's two harness facts. Absent on an older gateway. */
export interface MarkdownHarnessFacts {
  session_backend?: unknown
  markdown_spec_backends?: unknown
}

/**
 * The badge facts for one row, or `undefined` when there is nothing to say.
 *
 * Quiet on anything unknown: an older gateway that sends no facts, a row with
 * no `markdown_only`, an empty capable set. A badge on a guess would tell a user
 * a runnable agent cannot run.
 */
export function markdownBlock(
  row: { markdown_only?: unknown },
  facts: MarkdownHarnessFacts | undefined,
): MarkdownBlock | undefined {
  if (row.markdown_only !== true || !facts) return undefined
  const backend = facts.session_backend
  const capable = facts.markdown_spec_backends
  if (typeof backend !== 'string' || !backend) return undefined
  if (!Array.isArray(capable)) return undefined
  const names = capable.filter((b): b is string => typeof b === 'string' && b !== '')
  if (names.length === 0 || names.includes(backend)) return undefined
  return { backend, capable: names }
}

/** Every row of a catalog body with its `markdown_block` stamped (or cleared). */
export function withMarkdownBlocks<T extends { markdown_only?: unknown }>(
  rows: readonly T[],
  facts: MarkdownHarnessFacts | undefined,
): (T & { markdown_block?: MarkdownBlock })[] {
  return rows.map(row => {
    const block = markdownBlock(row, facts)
    return block ? { ...row, markdown_block: block } : row
  })
}
