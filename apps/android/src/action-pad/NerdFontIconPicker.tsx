import { useDeferredValue, useMemo, useState } from 'react'
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { CODEY_NERD_FONT_FAMILIES } from '../fonts'
import {
  filterNerdFontIcons,
  getNerdFontIcons,
  type NerdFontIcon
} from '../fonts/nerd-font-icons'

const GRID_HORIZONTAL_PADDING = 16
const GRID_GAP = 8
const MIN_ICON_TILE_WIDTH = 112
const MAX_COLUMNS = 10
const NO_ICONS: readonly NerdFontIcon[] = Object.freeze([])

export interface NerdFontIconPickerProps {
  readonly visible: boolean
  readonly onDismiss: () => void
  readonly onSelect: (icon: NerdFontIcon) => void
}

export function NerdFontIconPicker({
  visible,
  onDismiss,
  onSelect
}: NerdFontIconPickerProps) {
  const { width } = useWindowDimensions()
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const columns = Math.min(MAX_COLUMNS, Math.max(
    3,
    Math.floor((width - (GRID_HORIZONTAL_PADDING * 2) + GRID_GAP) / (MIN_ICON_TILE_WIDTH + GRID_GAP))
  ))
  const tileWidth = Math.max(48, Math.floor(
    (width - (GRID_HORIZONTAL_PADDING * 2) - (GRID_GAP * (columns - 1))) / columns
  ))
  const icons = useMemo(
    () => {
      if (!visible) return NO_ICONS
      const allIcons = getNerdFontIcons()
      return deferredQuery.trim().length === 0
        ? allIcons
        : filterNerdFontIcons(deferredQuery, allIcons)
    },
    [deferredQuery, visible]
  )
  const resultMessage = `${icons.length} ${icons.length === 1 ? 'icon' : 'icons'}`

  return (
    <Modal
      animationType="slide"
      onRequestClose={onDismiss}
      presentationStyle="fullScreen"
      supportedOrientations={['portrait', 'landscape']}
      visible={visible}
    >
      <SafeAreaView
        accessibilityViewIsModal
        style={styles.screen}
        testID="nerd-font-icon-picker"
      >
        <View style={styles.header}>
          <View style={styles.titleBlock}>
            <Text accessibilityRole="header" style={styles.title}>Choose a Nerd Font icon</Text>
            <Text style={styles.subtitle}>Insert one glyph into the button label.</Text>
          </View>
          <Pressable
            accessibilityLabel="Close icon picker"
            accessibilityRole="button"
            onPress={onDismiss}
            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
          >
            <Text style={styles.closeButtonText}>Close</Text>
          </Pressable>
        </View>

        <View style={styles.searchBlock}>
          <TextInput
            accessibilityLabel="Search Nerd Font icons"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            clearButtonMode="while-editing"
            onChangeText={setQuery}
            placeholder="Search names, icon sets, or code points"
            placeholderTextColor="#718096"
            returnKeyType="search"
            spellCheck={false}
            style={styles.searchInput}
            value={query}
          />
          <Text
            accessibilityLiveRegion="polite"
            style={styles.resultCount}
            testID="nerd-font-icon-result-count"
          >
            {resultMessage}
          </Text>
        </View>

        <FlatList
          columnWrapperStyle={styles.gridRow}
          contentContainerStyle={[styles.gridContent, icons.length === 0 && styles.emptyGridContent]}
          data={icons}
          initialNumToRender={columns * 5}
          key={`nerd-font-icon-grid-${columns}`}
          keyExtractor={(icon) => String(icon.codepoint)}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          numColumns={columns}
          removeClippedSubviews
          renderItem={({ item }) => (
            <Pressable
              accessibilityLabel={`Insert ${item.source} ${item.name}, ${item.codepointLabel}`}
              accessibilityRole="button"
              onPress={() => onSelect(item)}
              style={({ pressed }) => [styles.iconTile, { width: tileWidth }, pressed && styles.pressed]}
            >
              <Text numberOfLines={1} style={styles.iconGlyph}>{item.glyph}</Text>
              <Text numberOfLines={2} style={styles.iconName}>{item.name}</Text>
              <Text numberOfLines={1} style={styles.iconSource}>{item.source} · {item.codepointLabel}</Text>
            </Pressable>
          )}
          ListEmptyComponent={(
            <View accessibilityLiveRegion="polite" style={styles.emptyState}>
              <Text style={styles.emptyTitle}>No icons found</Text>
              <Text style={styles.emptyMessage}>Try another name, icon set, hexadecimal code point, or U+ code.</Text>
            </View>
          )}
          style={styles.grid}
          testID="nerd-font-icon-grid"
          windowSize={7}
        />
      </SafeAreaView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0b0e12'
  },
  header: {
    minHeight: 64,
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
  subtitle: {
    color: '#9eabb8',
    fontSize: 13
  },
  closeButton: {
    minWidth: 48,
    minHeight: 48,
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#303946',
    borderRadius: 8,
    backgroundColor: '#24283b'
  },
  closeButtonText: {
    color: '#c0caf5',
    fontSize: 14,
    fontWeight: '600'
  },
  pressed: {
    opacity: 0.72
  },
  searchBlock: {
    paddingHorizontal: GRID_HORIZONTAL_PADDING,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 6
  },
  searchInput: {
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#303946',
    borderRadius: 8,
    backgroundColor: '#151b22',
    color: '#e7edf3',
    fontSize: 16
  },
  resultCount: {
    minHeight: 19,
    color: '#9eabb8',
    fontSize: 13,
    lineHeight: 19
  },
  grid: {
    flex: 1
  },
  gridContent: {
    paddingHorizontal: GRID_HORIZONTAL_PADDING,
    paddingTop: 4,
    paddingBottom: 32
  },
  emptyGridContent: {
    flexGrow: 1
  },
  gridRow: {
    gap: GRID_GAP,
    marginBottom: GRID_GAP
  },
  iconTile: {
    flexGrow: 0,
    flexShrink: 0,
    minWidth: 48,
    minHeight: 112,
    paddingHorizontal: 8,
    paddingVertical: 10,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#303946',
    borderRadius: 10,
    backgroundColor: '#151b22'
  },
  iconGlyph: {
    color: '#c0caf5',
    fontFamily: CODEY_NERD_FONT_FAMILIES.regular,
    fontSize: 30,
    fontWeight: 'normal',
    lineHeight: 38,
    textAlign: 'center'
  },
  iconName: {
    color: '#e7edf3',
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 16,
    textAlign: 'center'
  },
  iconSource: {
    color: '#9eabb8',
    fontSize: 10,
    lineHeight: 14,
    textAlign: 'center'
  },
  emptyState: {
    flex: 1,
    minHeight: 180,
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8
  },
  emptyTitle: {
    color: '#eef4fa',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center'
  },
  emptyMessage: {
    maxWidth: 420,
    color: '#9eabb8',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center'
  }
})
