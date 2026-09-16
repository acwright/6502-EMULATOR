import type { VdpModel } from '../core/IO/VideoCard'

/**
 * The video card a machine gets when nothing names one.
 *
 * The TMS9918A until the PICOVDP clears its hardware gate (firmware proven on
 * the board, BIOS 2.0 released, the docs rewritten); the flip is a release of
 * its own. Unpinned callers — an embed without `vdp=`, `make run`, WIZARDSLAB —
 * keep the machine they had in 2.7.0 until then.
 */
export const DEFAULT_VDP: VdpModel = 'tms9918a'
