export const MIN_TABLET_SHORTEST_SIDE_DP = 600
export const EXPANDED_TABLET_MIN_WIDTH_DP = 840

export type TabletLayout = 'unsupported' | 'condensed' | 'expanded'

export interface TabletCapability {
  readonly layout: TabletLayout
  readonly height: number
}

export function tabletCapability(width: number, height: number): TabletCapability {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0
  const shortestSide = Math.min(safeWidth, safeHeight)
  const supported = safeWidth > safeHeight && shortestSide >= MIN_TABLET_SHORTEST_SIDE_DP

  return {
    layout: !supported
      ? 'unsupported'
      : safeWidth >= EXPANDED_TABLET_MIN_WIDTH_DP
        ? 'expanded'
        : 'condensed',
    height: safeHeight
  }
}
