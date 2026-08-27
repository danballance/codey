import type { ActionMenu } from "./types";

const UP_NAVIGATION_MENU = {
  label: "Up Arrow – Navigation",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "top",
          label: "gg Top",
          tap: { type: "input", nvimInput: "gg", after: "stay" },
        },
        {
          id: "block-up",
          label: "Block Up",
          tap: { type: "input", nvimInput: "{", after: "stay" },
        },
        {
          id: "five-lines-up",
          label: "+5 Lines",
          tap: { type: "input", nvimInput: "5k", after: "stay" },
        },
        {
          id: "ten-lines-up",
          label: "+10 Lines",
          tap: { type: "input", nvimInput: "10k", after: "stay" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "screen-top",
          label: "H Screen Top",
          tap: { type: "input", nvimInput: "H", after: "stay" },
        },
        {
          id: "half-page-up",
          label: "Half Page Up",
          tap: { type: "input", nvimInput: "<C-u>", after: "stay" },
        },
        {
          id: "full-page-up",
          label: "Full Page Up",
          tap: { type: "input", nvimInput: "<C-b>", after: "stay" },
        },
        {
          id: "back",
          label: "Back",
          tap: { type: "back", after: "stay" },
        },
      ],
    },
  ],
} as const satisfies ActionMenu;

const DOWN_NAVIGATION_MENU = {
  label: "Down Arrow – Navigation",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "bottom",
          label: "G Bottom",
          tap: { type: "input", nvimInput: "G", after: "stay" },
        },
        {
          id: "block-down",
          label: "Block Down",
          tap: { type: "input", nvimInput: "}", after: "stay" },
        },
        {
          id: "five-lines-down",
          label: "+5 Lines",
          tap: { type: "input", nvimInput: "5j", after: "stay" },
        },
        {
          id: "ten-lines-down",
          label: "+10 Lines",
          tap: { type: "input", nvimInput: "10j", after: "stay" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "screen-bottom",
          label: "L Screen Bot",
          tap: { type: "input", nvimInput: "L", after: "stay" },
        },
        {
          id: "half-page-down",
          label: "Half Page Down",
          tap: { type: "input", nvimInput: "<C-d>", after: "stay" },
        },
        {
          id: "full-page-down",
          label: "Full Page Down",
          tap: { type: "input", nvimInput: "<C-f>", after: "stay" },
        },
        {
          id: "back",
          label: "Back",
          tap: { type: "back", after: "stay" },
        },
      ],
    },
  ],
} as const satisfies ActionMenu;

const SEARCH_MENU = {
  label: "Search",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "grep",
          label: "Grep (Live)",
          tap: { type: "input", nvimInput: "<Space>sg", after: "root" },
        },
        {
          id: "files",
          label: "Find File",
          tap: { type: "input", nvimInput: "<Space>sf", after: "root" },
        },
        {
          id: "buffer",
          label: "Buffer Search",
          tap: { type: "input", nvimInput: "<Space>/", after: "root" },
        },
        {
          id: "symbols",
          label: "Symbol",
          tap: { type: "input", nvimInput: "gO", after: "root" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "recent",
          label: "Recent Files",
          tap: { type: "input", nvimInput: "<Space>s.", after: "root" },
        },
        {
          id: "replace",
          label: "Replace",
          tap: { type: "input", nvimInput: ":%s/", after: "root" },
        },
        {
          id: "word",
          label: "Word Under Cursor",
          tap: { type: "input", nvimInput: "<Space>sw", after: "root" },
        },
        {
          id: "diagnostics",
          label: "Diagnostics",
          tap: { type: "input", nvimInput: "<Space>sd", after: "root" },
        },
        {
          id: "back",
          label: "Back",
          tap: { type: "back", after: "stay" },
        },
      ],
    },
  ],
} as const satisfies ActionMenu;

const WINDOW_MENU = {
  label: "Window",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "left",
          label: "← Left",
          tap: { type: "input", nvimInput: "<C-w>h", after: "root" },
        },
        {
          id: "down",
          label: "↓ Down",
          tap: { type: "input", nvimInput: "<C-w>j", after: "root" },
        },
        {
          id: "up",
          label: "↑ Up",
          tap: { type: "input", nvimInput: "<C-w>k", after: "root" },
        },
        {
          id: "right",
          label: "→ Right",
          tap: { type: "input", nvimInput: "<C-w>l", after: "root" },
        },
        {
          id: "split",
          label: "Split",
          tap: { type: "input", nvimInput: "<C-w>s", after: "root" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "vertical-split",
          label: "V Split",
          tap: { type: "input", nvimInput: "<C-w>v", after: "root" },
        },
        {
          id: "close",
          label: "Close",
          tap: { type: "input", nvimInput: "<C-w>c", after: "root" },
        },
        {
          id: "only",
          label: "Only",
          tap: { type: "input", nvimInput: "<C-w>o", after: "root" },
        },
        {
          id: "next",
          label: "Next",
          tap: { type: "input", nvimInput: "<C-w>w", after: "root" },
        },
        {
          id: "back",
          label: "Back",
          tap: { type: "back", after: "stay" },
        },
      ],
    },
  ],
} as const satisfies ActionMenu;

const CODE_MENU = {
  label: "Code",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "definition",
          label: "Definition",
          tap: { type: "input", nvimInput: "grd", after: "root" },
        },
        {
          id: "references",
          label: "References",
          tap: { type: "input", nvimInput: "grr", after: "root" },
        },
        {
          id: "implementation",
          label: "Implementation",
          tap: { type: "input", nvimInput: "gri", after: "root" },
        },
        {
          id: "type-definition",
          label: "Type",
          tap: { type: "input", nvimInput: "grt", after: "root" },
        },
        {
          id: "hover",
          label: "Hover",
          tap: { type: "input", nvimInput: "K", after: "root" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "code-action",
          label: "Code Action",
          tap: { type: "input", nvimInput: "gra", after: "root" },
        },
        {
          id: "rename",
          label: "Rename",
          tap: { type: "input", nvimInput: "grn", after: "root" },
        },
        {
          id: "format",
          label: "Format",
          tap: { type: "input", nvimInput: "<Space>f", after: "root" },
        },
        {
          id: "diagnostic",
          label: "Diagnostic",
          tap: { type: "input", nvimInput: "<C-w>d", after: "root" },
        },
        {
          id: "back",
          label: "Back",
          tap: { type: "back", after: "stay" },
        },
      ],
    },
  ],
} as const satisfies ActionMenu;

const LEADER_MENU = {
  label: "Leader",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "search",
          label: "Search",
          tap: { type: "menu", menu: SEARCH_MENU, after: "stay" },
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
          tap: { type: "menu", menu: WINDOW_MENU, after: "stay" },
        },
        {
          id: "code",
          label: "Code",
          tap: { type: "menu", menu: CODE_MENU, after: "stay" },
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
} as const satisfies ActionMenu;

const COMMAND_MENU = {
  label: "Cmd",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "save",
          label: "Save",
          tap: { type: "input", nvimInput: ":w<CR>", after: "root" },
        },
        {
          id: "save-all",
          label: "Save All",
          tap: { type: "input", nvimInput: ":wa<CR>", after: "root" },
        },
        {
          id: "quit",
          label: "Quit",
          tap: { type: "input", nvimInput: ":q<CR>", after: "root" },
        },
        {
          id: "force-quit",
          label: "Force Quit",
          tap: { type: "input", nvimInput: ":q!<CR>", after: "root" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "write-quit",
          label: "Write and Quit",
          tap: { type: "input", nvimInput: ":wq<CR>", after: "root" },
        },
        {
          id: "undo",
          label: "Undo",
          tap: { type: "input", nvimInput: "u", after: "root" },
        },
        {
          id: "redo",
          label: "Redo",
          tap: { type: "input", nvimInput: "<C-r>", after: "root" },
        },
        {
          id: "back",
          label: "Back",
          tap: { type: "back", after: "stay" },
        },
      ],
    },
  ],
} as const satisfies ActionMenu;

const MOTIONS_MENU = {
  label: "Motions",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "save",
          label: "Save",
          tap: { type: "input", nvimInput: ":w<CR>", after: "root" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "write-quit",
          label: "Write and Quit",
          tap: { type: "input", nvimInput: ":wq<CR>", after: "root" },
        },
      ],
    },
  ],
} as const satisfies ActionMenu;

const TEXT_OBJECTS_MENU = {
  label: "TextObjects",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "save",
          label: "Save",
          tap: { type: "input", nvimInput: ":w<CR>", after: "root" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "write-quit",
          label: "Write and Quit",
          tap: { type: "input", nvimInput: ":wq<CR>", after: "root" },
        },
      ],
    },
  ],
} as const satisfies ActionMenu;

export const ACTION_PAD_MENU = {
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
          tap: { type: "menu", menu: COMMAND_MENU, after: "stay" },
        },
        {
          id: "leader",
          label: "Leader",
          tap: { type: "menu", menu: LEADER_MENU, after: "stay" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "motions",
          label: "Motions",
          tap: { type: "menu", menu: MOTIONS_MENU, after: "stay" },
        },
        {
          id: "text-objects",
          label: "TextObjects",
          tap: { type: "menu", menu: TEXT_OBJECTS_MENU, after: "stay" },
        },
        {
          id: "down",
          label: "↓",
          accessibilityLabel: "Down",
          accessibilityHint: "Hold for navigation options",
          tap: { type: "input", nvimInput: "<Down>", after: "root" },
          longPress: {
            type: "menu",
            menu: DOWN_NAVIGATION_MENU,
            after: "stay",
          },
        },
        {
          id: "up",
          label: "↑",
          accessibilityLabel: "Up",
          accessibilityHint: "Hold for navigation options",
          tap: { type: "input", nvimInput: "<Up>", after: "root" },
          longPress: { type: "menu", menu: UP_NAVIGATION_MENU, after: "stay" },
        },
        {
          id: "left",
          label: "=",
          tap: { type: "input", nvimInput: "<Left>", after: "root" },
        },
        {
          id: "right",
          label: "→",
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
} as const satisfies ActionMenu;
