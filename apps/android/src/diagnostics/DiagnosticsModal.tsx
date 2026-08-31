import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import {
  DIAGNOSTIC_CATEGORIES,
  DIAGNOSTIC_LEVELS,
  diagnosticLogger,
  type DiagnosticCategory,
  type DiagnosticEntry,
  type DiagnosticLevel,
  type DiagnosticLogger
} from './logger'

export interface DiagnosticsModalProps {
  readonly visible: boolean
  readonly onClose: () => void
  readonly logger?: DiagnosticLogger
}

const SEARCH_DEBOUNCE_MS = 200
const FOLLOW_BOTTOM_THRESHOLD = 48

export function DiagnosticsModal({
  visible,
  onClose,
  logger = diagnosticLogger
}: DiagnosticsModalProps) {
  const subscribe = useCallback(
    (onStoreChange: () => void) => logger.subscribe(onStoreChange),
    [logger]
  )
  const getSnapshot = useCallback(() => logger.getSnapshot(), [logger])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [selectedLevels, setSelectedLevels] = useState<ReadonlySet<DiagnosticLevel>>(
    () => new Set(DIAGNOSTIC_LEVELS)
  )
  const [selectedCategories, setSelectedCategories] = useState<ReadonlySet<DiagnosticCategory>>(
    () => new Set(DIAGNOSTIC_CATEGORIES)
  )
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [expandedSequences, setExpandedSequences] = useState<ReadonlySet<number>>(
    () => new Set()
  )
  const [follow, setFollow] = useState(true)
  const list = useRef<FlatList<DiagnosticEntry>>(null)
  const newestSequence = snapshot.entries.at(-1)?.sequence ?? 0
  const pausedAfterSequence = useRef(newestSequence)

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timeout)
  }, [search])

  const filteredEntries = useMemo(() => snapshot.entries.filter((entry) => {
    if (!selectedLevels.has(entry.level) || !selectedCategories.has(entry.category)) return false
    if (debouncedSearch.length === 0) return true
    return [entry.event, entry.message, entry.category, entry.detailsText]
      .join('\n')
      .toLowerCase()
      .includes(debouncedSearch)
  }), [debouncedSearch, selectedCategories, selectedLevels, snapshot.entries])
  const newestFilteredSequence = filteredEntries.at(-1)?.sequence ?? 0

  const matchingAfterPause = follow ? 0 : filteredEntries.reduce(
    (count, entry) => count + Number(entry.sequence > pausedAfterSequence.current),
    0
  )

  const scrollToNewest = useCallback((animated: boolean) => {
    list.current?.scrollToEnd({ animated })
  }, [])

  useEffect(() => {
    if (!visible || !follow || filteredEntries.length === 0) return
    const frame = requestAnimationFrame(() => scrollToNewest(false))
    return () => cancelAnimationFrame(frame)
  }, [follow, newestFilteredSequence, scrollToNewest, visible])

  const pauseFollowing = useCallback(() => {
    if (!follow) return
    pausedAfterSequence.current = newestSequence
    setFollow(false)
  }, [follow, newestSequence])

  const resumeFollowing = useCallback(() => {
    pausedAfterSequence.current = newestSequence
    setFollow(true)
    requestAnimationFrame(() => scrollToNewest(true))
  }, [newestSequence, scrollToNewest])

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!follow) return
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height)
    if (distanceFromBottom > FOLLOW_BOTTOM_THRESHOLD) pauseFollowing()
  }, [follow, pauseFollowing])

  const toggleLevel = useCallback((level: DiagnosticLevel) => {
    setSelectedLevels((current) => toggled(current, level))
  }, [])

  const toggleCategory = useCallback((category: DiagnosticCategory) => {
    setSelectedCategories((current) => toggled(current, category))
  }, [])

  const toggleExpanded = useCallback((sequence: number) => {
    setExpandedSequences((current) => toggled(current, sequence))
  }, [])

  const confirmClear = useCallback(() => {
    Alert.alert(
      'Clear in-app logs?',
      'This removes the retained process history from this viewer. Logcat is unchanged.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            logger.clear()
            pausedAfterSequence.current = newestSequence
            setExpandedSequences(new Set())
          }
        }
      ]
    )
  }, [logger, newestSequence])

  const runStart = formatRunStart(snapshot.runStartedAt)

  return (
    <Modal
      animationType="fade"
      hardwareAccelerated
      onRequestClose={onClose}
      onShow={() => {
        if (follow) requestAnimationFrame(() => scrollToNewest(false))
      }}
      presentationStyle="fullScreen"
      visible={visible}
    >
      <SafeAreaView
        accessibilityViewIsModal
        style={styles.screen}
        testID="diagnostics-modal"
      >
        <View style={styles.header}>
          <View style={styles.titleBlock}>
            <Text accessibilityRole="header" style={styles.title}>Operational logs</Text>
            <Text selectable style={styles.runText} testID="diagnostics-run-summary">
              {`Run ${snapshot.runId} · started ${runStart}`}
            </Text>
            <Text style={styles.countText} testID="diagnostics-counts">
              {`${snapshot.entries.length} retained · ${filteredEntries.length} filtered · ${snapshot.evictedCount} evicted`}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityLabel="Clear in-app logs"
              accessibilityRole="button"
              disabled={snapshot.entries.length === 0}
              onPress={confirmClear}
              style={({ pressed }) => [
                styles.secondaryButton,
                snapshot.entries.length === 0 && styles.disabled,
                pressed && styles.pressed
              ]}
              testID="diagnostics-clear"
            >
              <Text style={styles.secondaryButtonText}>Clear</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Close logs"
              accessibilityRole="button"
              onPress={onClose}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
              testID="diagnostics-close"
            >
              <Text style={styles.closeButtonText}>Close</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.filters}>
          <TextInput
            accessibilityLabel="Search operational logs"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus={false}
            onChangeText={setSearch}
            placeholder="Search event, message, category, or details"
            placeholderTextColor="#66727f"
            selectionColor="#7aa2f7"
            style={styles.search}
            testID="diagnostics-search"
            value={search}
          />

          <View style={styles.filterGroup}>
            <Text style={styles.filterLabel}>Levels</Text>
            <ScrollView
              contentContainerStyle={styles.chips}
              horizontal
              keyboardShouldPersistTaps="handled"
              showsHorizontalScrollIndicator={false}
            >
              {DIAGNOSTIC_LEVELS.map((level) => (
                <FilterChip
                  key={level}
                  label={level}
                  onPress={() => toggleLevel(level)}
                  selected={selectedLevels.has(level)}
                  testID={`diagnostics-level-${level}`}
                />
              ))}
            </ScrollView>
          </View>

          <View style={styles.filterGroup}>
            <Text style={styles.filterLabel}>Categories</Text>
            <ScrollView
              contentContainerStyle={styles.chips}
              horizontal
              keyboardShouldPersistTaps="handled"
              showsHorizontalScrollIndicator={false}
            >
              {DIAGNOSTIC_CATEGORIES.map((category) => (
                <FilterChip
                  key={category}
                  label={category}
                  onPress={() => toggleCategory(category)}
                  selected={selectedCategories.has(category)}
                  testID={`diagnostics-category-${category}`}
                />
              ))}
            </ScrollView>
          </View>
        </View>

        {!follow ? (
          <View accessibilityLiveRegion="polite" style={styles.followBar} testID="diagnostics-follow-paused">
            <Text style={styles.followText}>
              {matchingAfterPause === 1
                ? '1 new matching entry'
                : `${matchingAfterPause} new matching entries`}
            </Text>
            <Pressable
              accessibilityLabel="Resume following newest log entry"
              accessibilityRole="button"
              onPress={resumeFollowing}
              style={({ pressed }) => [styles.resumeButton, pressed && styles.pressed]}
              testID="diagnostics-resume"
            >
              <Text style={styles.resumeButtonText}>Resume</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.followBar} testID="diagnostics-following">
            <Text style={styles.followText}>Following newest entry</Text>
            <Pressable
              accessibilityLabel="Pause following log entries"
              accessibilityRole="button"
              onPress={pauseFollowing}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              testID="diagnostics-pause"
            >
              <Text style={styles.secondaryButtonText}>Pause</Text>
            </Pressable>
          </View>
        )}

        {snapshot.entries.length === 0 ? (
          <EmptyState
            message="Operational entries will appear here as the app runs."
            testID="diagnostics-empty"
            title="No logs captured yet"
          />
        ) : filteredEntries.length === 0 ? (
          <EmptyState
            message="Change the search or select more levels and categories."
            testID="diagnostics-filter-empty"
            title="No logs match the current filters"
          />
        ) : (
          <FlatList<DiagnosticEntry>
            contentContainerStyle={styles.listContent}
            data={filteredEntries}
            initialNumToRender={30}
            keyExtractor={(entry) => String(entry.sequence)}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            maxToRenderPerBatch={40}
            onContentSizeChange={() => {
              if (follow && visible) scrollToNewest(false)
            }}
            onScroll={handleScroll}
            ref={list}
            renderItem={({ item }) => (
              <DiagnosticEntryRow
                entry={item}
                expanded={expandedSequences.has(item.sequence)}
                onToggle={() => toggleExpanded(item.sequence)}
              />
            )}
            scrollEventThrottle={32}
            style={styles.list}
            testID="diagnostics-list"
            windowSize={11}
          />
        )}
      </SafeAreaView>
    </Modal>
  )
}

interface FilterChipProps {
  readonly label: string
  readonly selected: boolean
  readonly onPress: () => void
  readonly testID: string
}

function FilterChip({ label, selected, onPress, testID }: FilterChipProps) {
  return (
    <Pressable
      accessibilityLabel={`${selected ? 'Hide' : 'Show'} ${label} logs`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && styles.pressed
      ]}
      testID={testID}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  )
}

interface DiagnosticEntryRowProps {
  readonly entry: DiagnosticEntry
  readonly expanded: boolean
  readonly onToggle: () => void
}

function DiagnosticEntryRow({ entry, expanded, onToggle }: DiagnosticEntryRowProps) {
  const hasDetails = entry.detailsText.length > 0
  const hasMetadata = entry.operationId !== undefined || entry.parentOperationId !== undefined ||
    entry.durationMs !== undefined || entry.truncated
  const expandable = hasDetails || hasMetadata

  return (
    <View style={styles.entry} testID={`diagnostics-entry-${entry.sequence}`}>
      <Pressable
        accessibilityHint={expandable ? 'Shows or hides the entry details' : undefined}
        accessibilityLabel={`${entry.level} ${entry.category} ${entry.event}: ${entry.message}`}
        accessibilityRole={expandable ? 'button' : 'text'}
        accessibilityState={expandable ? { expanded } : undefined}
        disabled={!expandable}
        onPress={onToggle}
        style={({ pressed }) => [styles.entrySummary, pressed && styles.entryPressed]}
        testID={`diagnostics-entry-summary-${entry.sequence}`}
      >
        <View style={styles.entryTopLine}>
          <Text selectable style={styles.timestamp}>{formatTimestamp(entry.timestamp)}</Text>
          <Text style={[styles.level, levelStyle(entry.level)]}>{entry.level.toUpperCase()}</Text>
          <Text numberOfLines={1} selectable style={styles.category}>{entry.category}</Text>
          <Text numberOfLines={1} selectable style={styles.event}>{entry.event}</Text>
          {entry.durationMs !== undefined ? (
            <Text selectable style={styles.duration}>{formatDuration(entry.durationMs)}</Text>
          ) : null}
          {expandable ? <Text style={styles.disclosure}>{expanded ? '▾' : '▸'}</Text> : null}
        </View>
        <Text selectable style={styles.message}>{entry.message}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.details} testID={`diagnostics-entry-details-${entry.sequence}`}>
          <Text selectable style={styles.metadata}>
            {entryMetadata(entry)}
          </Text>
          {hasDetails ? (
            <Text selectable style={styles.rawDetails}>{entry.detailsText}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

function EmptyState({ title, message, testID }: {
  readonly title: string
  readonly message: string
  readonly testID: string
}) {
  return (
    <View accessibilityLiveRegion="polite" style={styles.empty} testID={testID}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyMessage}>{message}</Text>
    </View>
  )
}

function toggled<T>(current: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(current)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

function formatRunStart(timestamp: number): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString()
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '--:--:--.---'
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':') + `.${String(date.getMilliseconds()).padStart(3, '0')}`
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs)) return '— ms'
  return `${durationMs < 10 ? durationMs.toFixed(1) : Math.round(durationMs)} ms`
}

function entryMetadata(entry: DiagnosticEntry): string {
  const metadata = [`sequence=${entry.sequence}`, `elapsed=${formatDuration(entry.elapsedMs)}`]
  if (entry.operationId !== undefined) metadata.push(`operation=${entry.operationId}`)
  if (entry.parentOperationId !== undefined) metadata.push(`parent=${entry.parentOperationId}`)
  if (entry.durationMs !== undefined) metadata.push(`duration=${formatDuration(entry.durationMs)}`)
  if (entry.truncated) metadata.push('truncated=true')
  return metadata.join(' · ')
}

function levelStyle(level: DiagnosticEntry['level']) {
  switch (level) {
    case 'debug': return styles.levelDebug
    case 'info': return styles.levelInfo
    case 'warn': return styles.levelWarn
    case 'error': return styles.levelError
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0b0e12'
  },
  header: {
    minHeight: 76,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#27303a'
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  title: {
    color: '#eef4fa',
    fontSize: 20,
    fontWeight: '700'
  },
  runText: {
    color: '#a9b4c0',
    fontSize: 11
  },
  countText: {
    color: '#7d8996',
    fontSize: 11
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  closeButton: {
    minHeight: 38,
    minWidth: 68,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#2f81f7'
  },
  closeButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700'
  },
  secondaryButton: {
    minHeight: 34,
    minWidth: 58,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#394452',
    backgroundColor: '#171d25'
  },
  secondaryButtonText: {
    color: '#c8d1dc',
    fontSize: 12,
    fontWeight: '600'
  },
  filters: {
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#202832',
    backgroundColor: '#10151b'
  },
  search: {
    minHeight: 38,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#394452',
    borderRadius: 8,
    color: '#eef4fa',
    backgroundColor: '#0b0e12',
    fontSize: 13
  },
  filterGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  filterLabel: {
    width: 66,
    color: '#8e9aa7',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase'
  },
  chips: {
    flexDirection: 'row',
    gap: 6,
    paddingRight: 8
  },
  chip: {
    minHeight: 28,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#394452',
    borderRadius: 14,
    backgroundColor: '#11171e'
  },
  chipSelected: {
    borderColor: '#5278b8',
    backgroundColor: '#1d3352'
  },
  chipText: {
    color: '#76828e',
    fontSize: 11,
    fontWeight: '600'
  },
  chipTextSelected: {
    color: '#d5e5ff'
  },
  followBar: {
    minHeight: 40,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#202832',
    backgroundColor: '#10151b'
  },
  followText: {
    flex: 1,
    color: '#a9b4c0',
    fontSize: 12
  },
  resumeButton: {
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 7,
    backgroundColor: '#2f81f7'
  },
  resumeButtonText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700'
  },
  list: {
    flex: 1
  },
  listContent: {
    paddingVertical: 4
  },
  entry: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#27303a'
  },
  entrySummary: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 4
  },
  entryPressed: {
    backgroundColor: '#161e28'
  },
  entryTopLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7
  },
  timestamp: {
    color: '#7d8996',
    fontFamily: 'monospace',
    fontSize: 11
  },
  level: {
    width: 46,
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '700'
  },
  levelDebug: {
    color: '#8b949e'
  },
  levelInfo: {
    color: '#79c0ff'
  },
  levelWarn: {
    color: '#e3b341'
  },
  levelError: {
    color: '#ff7b72'
  },
  category: {
    maxWidth: 100,
    color: '#9ece6a',
    fontFamily: 'monospace',
    fontSize: 11
  },
  event: {
    flex: 1,
    minWidth: 0,
    color: '#c8d1dc',
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '600'
  },
  duration: {
    color: '#7d8996',
    fontFamily: 'monospace',
    fontSize: 10
  },
  disclosure: {
    width: 14,
    color: '#8e9aa7',
    fontSize: 12,
    textAlign: 'center'
  },
  message: {
    color: '#e1e7ed',
    fontSize: 12,
    lineHeight: 17
  },
  details: {
    gap: 7,
    paddingHorizontal: 14,
    paddingTop: 1,
    paddingBottom: 11,
    backgroundColor: '#0f141a'
  },
  metadata: {
    color: '#7d8996',
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 15
  },
  rawDetails: {
    padding: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#27303a',
    borderRadius: 6,
    color: '#c9d1d9',
    backgroundColor: '#080b0f',
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 15
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 32
  },
  emptyTitle: {
    color: '#d8e0e8',
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center'
  },
  emptyMessage: {
    maxWidth: 420,
    color: '#84909d',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center'
  },
  pressed: {
    opacity: 0.72
  },
  disabled: {
    opacity: 0.4
  }
})
