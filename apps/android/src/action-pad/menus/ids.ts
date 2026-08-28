export const MENU_IDS = {
  HOME: "home",
  COMMAND: "command",
  LEADER: "leader",
  MOTIONS: "motions",
  TEXT_OBJECTS: "text-objects",
  UP_NAVIGATION: "up-navigation",
  DOWN_NAVIGATION: "down-navigation",
  SEARCH: "search",
  WINDOW: "window",
  CODE: "code",
  DELETE: "delete",
  YANK: "yank",
} as const;

export type ActionPadMenuId = (typeof MENU_IDS)[keyof typeof MENU_IDS];
