import { TMS9918A } from './TMS9918A'
import { Video } from './Video'
import type { VdpModel, VideoCard } from './VideoCard'

/**
 * A new card of the given model, for io8.
 *
 * Kept out of `VideoCard.ts` so that importing the types does not pull in both
 * cards.
 */
export function createVideoCard(model: VdpModel): VideoCard {
  switch (model) {
    case 'tms9918a':
      return new TMS9918A()
    case 'picovdp':
      return new Video()
  }
}
