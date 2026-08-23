import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type ComponentType,
  type RefAttributes
} from 'react'
import { requireNativeView } from 'expo'
import type { StyleProp, ViewStyle } from 'react-native'

export type CodeyImeInputMode = 'terminal' | 'composed'

export interface CodeyImeEventMetadata {
  readonly sequence: number
  readonly receivedAtUptimeMs: number
  readonly connectionGeneration: number
}

export interface CodeyImeKeyEvent extends Partial<CodeyImeEventMetadata> {
  readonly key: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly meta: boolean
  readonly repeat: boolean
}

export interface CodeyImeHandle {
  focus(): Promise<void>
  blur(): Promise<void>
  sendOrderedInput(keys: string): Promise<void>
  settleComposition(): Promise<void>
}

export type CodeyImeOrderedSegment =
  | { readonly type: 'text'; readonly text: string }
  | ({ readonly type: 'key' } & CodeyImeKeyEvent)
  | { readonly type: 'input'; readonly keys: string }

export interface CodeyImeOrderedInputEvent extends CodeyImeEventMetadata {
  readonly nativeDurationMs: number
  readonly compositionDrained: boolean
  readonly segments: readonly CodeyImeOrderedSegment[]
}

interface NativeImeEvent<T> {
  readonly nativeEvent: T
}

interface CodeyImeNativeRef {
  focusIme(): Promise<void>
  blurIme(): Promise<void>
  sendOrderedInput(keys: string): Promise<void>
  settleComposition(): Promise<void>
}

interface NativeCodeyImeProps {
  readonly style?: StyleProp<ViewStyle>
  readonly inputMode: CodeyImeInputMode
  readonly onCommittedText?: (
    event: NativeImeEvent<{ readonly text: string } & CodeyImeEventMetadata>
  ) => void
  readonly onKey?: (event: NativeImeEvent<CodeyImeKeyEvent>) => void
  readonly onOrderedInput?: (event: NativeImeEvent<CodeyImeOrderedInputEvent>) => void
}

export interface CodeyImeProps {
  readonly style?: StyleProp<ViewStyle>
  readonly inputMode?: CodeyImeInputMode
  readonly onCommittedText: (text: string, metadata?: CodeyImeEventMetadata) => void
  readonly onKey: (event: CodeyImeKeyEvent) => void
  readonly onOrderedInput: (event: CodeyImeOrderedInputEvent) => void
}

const NativeCodeyIme = requireNativeView<NativeCodeyImeProps>(
  'CodeyIme'
) as ComponentType<NativeCodeyImeProps & RefAttributes<CodeyImeNativeRef>>

export const CodeyIme = forwardRef<CodeyImeHandle, CodeyImeProps>(function CodeyIme(
  { style, inputMode = 'terminal', onCommittedText, onKey, onOrderedInput },
  forwardedRef
) {
  const nativeRef = useRef<CodeyImeNativeRef | null>(null)
  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: async () => nativeRef.current?.focusIme(),
      blur: async () => nativeRef.current?.blurIme(),
      sendOrderedInput: async (keys) => nativeRef.current?.sendOrderedInput(keys),
      settleComposition: async () => nativeRef.current?.settleComposition()
    }),
    []
  )

  return (
    <NativeCodeyIme
      ref={nativeRef}
      style={style}
      inputMode={inputMode}
      onCommittedText={(event) => {
        const { text, ...metadata } = event.nativeEvent
        onCommittedText(text, metadata)
      }}
      onKey={(event) => onKey(event.nativeEvent)}
      onOrderedInput={(event) => onOrderedInput(event.nativeEvent)}
    />
  )
})
