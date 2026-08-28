import type {
  ActionAfter,
  ActionButtonStyles,
} from "../types";
import type { ActionPadMenuId } from "./ids";

export type ActionMenuDefinitionInteraction =
  | {
      readonly type: "input";
      readonly nvimInput: string;
      readonly after: ActionAfter;
    }
  | {
      readonly type: "menu";
      readonly menuId: ActionPadMenuId;
      readonly after: ActionAfter;
    }
  | {
      readonly type: "back";
      readonly after: ActionAfter;
    }
  | {
      readonly type: "keyboard";
      readonly after: ActionAfter;
    };

interface ActionMenuDefinitionButtonBase {
  readonly id: string;
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly styles?: ActionButtonStyles;
}

export type ActionMenuDefinitionButton = ActionMenuDefinitionButtonBase &
  (
    | {
        readonly tap: ActionMenuDefinitionInteraction;
        readonly longPress?: ActionMenuDefinitionInteraction;
      }
    | {
        readonly tap?: never;
        readonly longPress: ActionMenuDefinitionInteraction;
      }
  );

export interface ActionMenuDefinitionGroup {
  readonly id: string;
  readonly buttons: readonly ActionMenuDefinitionButton[];
}

export interface ActionMenuDefinition {
  readonly label: string;
  readonly groups: readonly ActionMenuDefinitionGroup[];
}
