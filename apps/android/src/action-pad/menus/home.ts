import { MENU_IDS } from "./ids";
import type { ActionMenuDefinition } from "./types";

export const HOME_MENU = {
  label: "Home",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "escape",
          label: "Esc",
          tap: { type: "input", nvimInput: "<Esc>", after: "root" },
        },
        {
          id: "directory",
          label: "Directory",
          tap: { type: "input", nvimInput: "<Esc>-", after: "root" },
        },
        {
          id: "command",
          label: "Cmd",
          tap: { type: "menu", menuId: MENU_IDS.COMMAND, after: "stay" },
        },
        {
          id: "leader",
          label: "Leader",
          tap: { type: "menu", menuId: MENU_IDS.LEADER, after: "stay" },
        },
        {
          id: "yank",
          label: "Yank",
          tap: { type: "menu", menuId: MENU_IDS.YANK, after: "stay" },
        },
        {
          id: "delete",
          label: "Delete",
          tap: { type: "menu", menuId: MENU_IDS.DELETE, after: "stay" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "motions",
          label: "Motions",
          tap: { type: "menu", menuId: MENU_IDS.MOTIONS, after: "stay" },
        },
        {
          id: "text-objects",
          label: "TextObjects",
          tap: {
            type: "menu",
            menuId: MENU_IDS.TEXT_OBJECTS,
            after: "stay",
          },
        },
        {
          id: "down",
          label: "⬇",
          accessibilityLabel: "Down",
          accessibilityHint: "Hold for navigation options",
          tap: { type: "input", nvimInput: "<Down>", after: "root" },
          longPress: {
            type: "menu",
            menuId: MENU_IDS.DOWN_NAVIGATION,
            after: "stay",
          },
        },
        {
          id: "up",
          label: "⬆",
          accessibilityLabel: "Up",
          accessibilityHint: "Hold for navigation options",
          tap: { type: "input", nvimInput: "<Up>", after: "root" },
          longPress: {
            type: "menu",
            menuId: MENU_IDS.UP_NAVIGATION,
            after: "stay",
          },
        },
        {
          id: "left",
          label: "⬅",
          tap: { type: "input", nvimInput: "<Left>", after: "root" },
        },
        {
          id: "right",
          label: "➡",
          accessibilityLabel: "Right",
          tap: { type: "input", nvimInput: "<Right>", after: "root" },
        },
        {
          id: "keyboard",
          label: "Keyboard",
          tap: { type: "keyboard", after: "stay" },
        },
        {
          id: "enter",
          label: "Enter",
          tap: { type: "input", nvimInput: "<CR>", after: "stay" },
        },
      ],
    },
  ],
} as const satisfies ActionMenuDefinition;
