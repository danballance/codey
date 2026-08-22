import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type ComponentType,
  type RefAttributes
} from 'react'
import { requireNativeView } from 'expo'
import type { StyleProp, ViewStyle } from 'react-native'

export interface CodeyImeKeyEvent {
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
  sendKey(event: CodeyImeKeyEvent): Promise<void>
}

interface NativeImeEvent<T> {
  readonly nativeEvent: T
}

interface CodeyImeNativeRef {
  focusIme(): Promise<void>
  blurIme(): Promise<void>
  sendImeKey(
    key: string,
    ctrl: boolean,
    alt: boolean,
    shift: boolean,
    meta: boolean,
    repeat: boolean
  ): Promise<void>
}

interface NativeCodeyImeProps {
  readonly style?: StyleProp<ViewStyle>
  readonly onCommittedText?: (event: NativeImeEvent<{ readonly text: string }>) => void
  readonly onKey?: (event: NativeImeEvent<CodeyImeKeyEvent>) => void
}

export interface CodeyImeProps {
  readonly style?: StyleProp<ViewStyle>
  readonly onCommittedText: (text: string) => void
  readonly onKey: (event: CodeyImeKeyEvent) => void
}

const NativeCodeyIme = requireNativeView<NativeCodeyImeProps>(
  'CodeyIme'
) as ComponentType<NativeCodeyImeProps & RefAttributes<CodeyImeNativeRef>>

export const CodeyIme = forwardRef<CodeyImeHandle, CodeyImeProps>(function CodeyIme(
  { style, onCommittedText, onKey },
  forwardedRef
) {
  const nativeRef = useRef<CodeyImeNativeRef | null>(null)
  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: async () => nativeRef.current?.focusIme(),
      blur: async () => nativeRef.current?.blurIme(),
      sendKey: async (event) =>
        nativeRef.current?.sendImeKey(
          event.key,
          event.ctrl,
          event.alt,
          event.shift,
          event.meta,
          event.repeat
        )
    }),
    []
  )

  return (
    <NativeCodeyIme
      ref={nativeRef}
      style={style}
      onCommittedText={(event) => onCommittedText(event.nativeEvent.text)}
      onKey={(event) => onKey(event.nativeEvent)}
    />
  )
})
