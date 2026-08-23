export const MIN_TABLET_SHORTEST_SIDE_DP = 600
export const EXPANDED_TABLET_MIN_WIDTH_DP = 840

export type TabletLayout = 'unsupported' | 'condensed' | 'expanded'
export type TabletOrientation = 'portrait' | 'landscape'

export interface TabletCapability {
  readonly supported: boolean
  readonly layout: TabletLayout
  readonly orientation: TabletOrientation
  readonly width: number
  readonly height: number
  readonly shortestSide: number
  readonly minimumShortestSide: number
}

export function tabletCapability(width: number, height: number): TabletCapability {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0
  const shortestSide = Math.min(safeWidth, safeHeight)
  const supported = shortestSide >= MIN_TABLET_SHORTEST_SIDE_DP

  return {
    supported,
    layout: !supported
      ? 'unsupported'
      : safeWidth >= EXPANDED_TABLET_MIN_WIDTH_DP
        ? 'expanded'
        : 'condensed',
    orientation: safeWidth > safeHeight ? 'landscape' : 'portrait',
    width: safeWidth,
    height: safeHeight,
    shortestSide,
    minimumShortestSide: MIN_TABLET_SHORTEST_SIDE_DP
  }
}
