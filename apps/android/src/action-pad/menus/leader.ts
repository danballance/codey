import { MENU_IDS } from "./ids";
import type { ActionMenuDefinition } from "./types";

export const LEADER_MENU = {
  label: "Leader",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "search",
          label: "Search",
          tap: { type: "menu", menuId: MENU_IDS.SEARCH, after: "stay" },
        },
        {
          id: "files",
          label: "Files",
          tap: { type: "input", nvimInput: "<Space>sf", after: "root" },
        },
        {
          id: "buffers",
          label: "Buffers",
          tap: { type: "input", nvimInput: "<Space><Space>", after: "root" },
        },
        {
          id: "window",
          label: "Window",
          tap: { type: "menu", menuId: MENU_IDS.WINDOW, after: "stay" },
        },
        {
          id: "code",
          label: "Code",
          tap: { type: "menu", menuId: MENU_IDS.CODE, after: "stay" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "project-tree",
          label: "Project Tree",
          tap: { type: "input", nvimInput: "<Space>e", after: "root" },
        },
        {
          id: "outline",
          label: "Outline",
          tap: { type: "input", nvimInput: "<Space>o", after: "root" },
        },
        {
          id: "terminal",
          label: "Terminal",
          tap: { type: "input", nvimInput: ":terminal<CR>", after: "root" },
        },
        {
          id: "help",
          label: "Help",
          tap: { type: "input", nvimInput: "<Space>sh", after: "root" },
        },
        {
          id: "back",
          label: "Back",
          tap: { type: "back", after: "stay" },
        },
      ],
    },
  ],
} as const satisfies ActionMenuDefinition;
