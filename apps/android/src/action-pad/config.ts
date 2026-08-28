import { CODE_MENU } from "./menus/code";
import { COMMAND_MENU } from "./menus/command";
import { DOWN_NAVIGATION_MENU } from "./menus/down-navigation";
import { HOME_MENU } from "./menus/home";
import { MENU_IDS, type ActionPadMenuId } from "./menus/ids";
import { LEADER_MENU } from "./menus/leader";
import { MOTIONS_MENU } from "./menus/motions";
import { resolveActionMenu } from "./menus/resolve";
import { SEARCH_MENU } from "./menus/search";
import { TEXT_OBJECTS_MENU } from "./menus/text-objects";
import type { ActionMenuDefinition } from "./menus/types";
import { UP_NAVIGATION_MENU } from "./menus/up-navigation";
import { WINDOW_MENU } from "./menus/window";
import {YANK_MENU} from "./menus/yank";
import {DELETE_MENU} from "./menus/delete";

const MENU_DEFINITIONS = {
  [MENU_IDS.HOME]: HOME_MENU,
  [MENU_IDS.COMMAND]: COMMAND_MENU,
  [MENU_IDS.LEADER]: LEADER_MENU,
  [MENU_IDS.MOTIONS]: MOTIONS_MENU,
  [MENU_IDS.TEXT_OBJECTS]: TEXT_OBJECTS_MENU,
  [MENU_IDS.UP_NAVIGATION]: UP_NAVIGATION_MENU,
  [MENU_IDS.DOWN_NAVIGATION]: DOWN_NAVIGATION_MENU,
  [MENU_IDS.SEARCH]: SEARCH_MENU,
  [MENU_IDS.WINDOW]: WINDOW_MENU,
  [MENU_IDS.CODE]: CODE_MENU,
  [MENU_IDS.YANK]: YANK_MENU,
  [MENU_IDS.DELETE]: DELETE_MENU,
} as const satisfies Record<ActionPadMenuId, ActionMenuDefinition>;

export const ACTION_PAD_MENU = resolveActionMenu(
  MENU_IDS.HOME,
  MENU_DEFINITIONS,
);
