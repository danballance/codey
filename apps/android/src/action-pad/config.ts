import type { ActionMenu } from "./types";
import { validateActionMenu } from "./validation";

const UP_NAVIGATION_MENU = {
  id: "up-navigation",
  label: "Up Arrow – Navigation",
  afterInput: "stay",
  groups: {
    leading: [
      { id: "top", label: "gg Top", type: "input", nvimInput: "gg" },
      { id: "block-up", label: "Block Up", type: "input", nvimInput: "{" },
      {
        id: "five-lines-up",
        label: "+5 Lines",
        type: "input",
        nvimInput: "5k",
      },
      {
        id: "ten-lines-up",
        label: "+10 Lines",
        type: "input",
        nvimInput: "10k",
      },
    ],
    trailing: [
      {
        id: "screen-top",
        label: "H Screen Top",
        type: "input",
        nvimInput: "H",
      },
      {
        id: "half-page-up",
        label: "Half Page Up",
        type: "input",
        nvimInput: "<C-u>",
      },
      {
        id: "full-page-up",
        label: "Full Page Up",
        type: "input",
        nvimInput: "<C-b>",
      },
    ],
  },
} as const satisfies ActionMenu;

const DOWN_NAVIGATION_MENU = {
  id: "down-navigation",
  label: "Down Arrow – Navigation",
  afterInput: "stay",
  groups: {
    leading: [
      { id: "bottom", label: "G Bottom", type: "input", nvimInput: "G" },
      { id: "block-down", label: "Block Down", type: "input", nvimInput: "}" },
      {
        id: "five-lines-down",
        label: "+5 Lines",
        type: "input",
        nvimInput: "5j",
      },
      {
        id: "ten-lines-down",
        label: "+10 Lines",
        type: "input",
        nvimInput: "10j",
      },
    ],
    trailing: [
      {
        id: "screen-bottom",
        label: "L Screen Bot",
        type: "input",
        nvimInput: "L",
      },
      {
        id: "half-page-down",
        label: "Half Page Down",
        type: "input",
        nvimInput: "<C-d>",
      },
      {
        id: "full-page-down",
        label: "Full Page Down",
        type: "input",
        nvimInput: "<C-f>",
      },
    ],
  },
} as const satisfies ActionMenu;

const SEARCH_MENU = {
  id: "search",
  label: "Search",
  afterInput: "root",
  groups: {
    leading: [
      {
        id: "grep",
        label: "Grep (Live)",
        type: "input",
        nvimInput: "<Space>sg",
      },
      {
        id: "files",
        label: "Find File",
        type: "input",
        nvimInput: "<Space>sf",
      },
      {
        id: "buffer",
        label: "Buffer Search",
        type: "input",
        nvimInput: "<Space>/",
      },
      { id: "symbols", label: "Symbol", type: "input", nvimInput: "gO" },
    ],
    trailing: [
      {
        id: "recent",
        label: "Recent Files",
        type: "input",
        nvimInput: "<Space>s.",
      },
      { id: "replace", label: "Replace", type: "input", nvimInput: ":%s/" },
      {
        id: "word",
        label: "Word Under Cursor",
        type: "input",
        nvimInput: "<Space>sw",
      },
      {
        id: "diagnostics",
        label: "Diagnostics",
        type: "input",
        nvimInput: "<Space>sd",
      },
    ],
  },
} as const satisfies ActionMenu;

const WINDOW_MENU = {
  id: "window",
  label: "Window",
  afterInput: "root",
  groups: {
    leading: [
      { id: "left", label: "← Left", type: "input", nvimInput: "<C-w>h" },
      { id: "down", label: "↓ Down", type: "input", nvimInput: "<C-w>j" },
      { id: "up", label: "↑ Up", type: "input", nvimInput: "<C-w>k" },
      { id: "right", label: "→ Right", type: "input", nvimInput: "<C-w>l" },
      { id: "split", label: "Split", type: "input", nvimInput: "<C-w>s" },
    ],
    trailing: [
      {
        id: "vertical-split",
        label: "V Split",
        type: "input",
        nvimInput: "<C-w>v",
      },
      { id: "close", label: "Close", type: "input", nvimInput: "<C-w>c" },
      { id: "only", label: "Only", type: "input", nvimInput: "<C-w>o" },
      { id: "next", label: "Next", type: "input", nvimInput: "<C-w>w" },
    ],
  },
} as const satisfies ActionMenu;

const CODE_MENU = {
  id: "code",
  label: "Code",
  afterInput: "root",
  groups: {
    leading: [
      {
        id: "definition",
        label: "Definition",
        type: "input",
        nvimInput: "grd",
      },
      {
        id: "references",
        label: "References",
        type: "input",
        nvimInput: "grr",
      },
      {
        id: "implementation",
        label: "Implementation",
        type: "input",
        nvimInput: "gri",
      },
      { id: "type-definition", label: "Type", type: "input", nvimInput: "grt" },
      { id: "hover", label: "Hover", type: "input", nvimInput: "K" },
    ],
    trailing: [
      {
        id: "code-action",
        label: "Code Action",
        type: "input",
        nvimInput: "gra",
      },
      { id: "rename", label: "Rename", type: "input", nvimInput: "grn" },
      { id: "format", label: "Format", type: "input", nvimInput: "<Space>f" },
      {
        id: "diagnostic",
        label: "Diagnostic",
        type: "input",
        nvimInput: "<C-w>d",
      },
    ],
  },
} as const satisfies ActionMenu;

const LEADER_MENU = {
  id: "leader",
  label: "Leader",
  afterInput: "root",
  groups: {
    leading: [
      { id: "search", label: "Search", type: "menu", menu: SEARCH_MENU },
      { id: "files", label: "Files", type: "input", nvimInput: "<Space>sf" },
      {
        id: "buffers",
        label: "Buffers",
        type: "input",
        nvimInput: "<Space><Space>",
      },
      { id: "window", label: "Window", type: "menu", menu: WINDOW_MENU },
      { id: "code", label: "Code", type: "menu", menu: CODE_MENU },
    ],
    trailing: [
      {
        id: "project-tree",
        label: "Project Tree",
        type: "input",
        nvimInput: "<Space>e",
      },
      { id: "outline", label: "Outline", type: "input", nvimInput: "<Space>o" },
      {
        id: "terminal",
        label: "Terminal",
        type: "input",
        nvimInput: ":terminal<CR>",
      },
      { id: "help", label: "Help", type: "input", nvimInput: "<Space>sh" },
    ],
  },
} as const satisfies ActionMenu;

const COMMAND_MENU = {
  id: "command",
  label: "Cmd",
  afterInput: "root",
  groups: {
    leading: [
      { id: "save", label: "Save", type: "input", nvimInput: ":w<CR>" },
      {
        id: "save-all",
        label: "Save All",
        type: "input",
        nvimInput: ":wa<CR>",
      },
      { id: "quit", label: "Quit", type: "input", nvimInput: ":q<CR>" },
      {
        id: "force-quit",
        label: "Force Quit",
        type: "input",
        nvimInput: ":q!<CR>",
      },
    ],
    trailing: [
      {
        id: "write-quit",
        label: "Write and Quit",
        type: "input",
        nvimInput: ":wq<CR>",
      },
      { id: "undo", label: "Undo", type: "input", nvimInput: "u" },
      { id: "redo", label: "Redo", type: "input", nvimInput: "<C-r>" },
    ],
  },
} as const satisfies ActionMenu;

export const ACTION_PAD_MENU = {
  id: "root",
  label: "Home",
  afterInput: "root",
  groups: {
    leading: [
      { id: "ctrl", label: "Ctrl", type: "modifier", modifier: "ctrl" },
      { id: "escape", label: "Esc", type: "key", key: "Escape" },
      { id: "tab", label: "Tab", type: "key", key: "Tab" },
      { id: "enter", label: "Enter", type: "key", key: "Enter" },
      { id: "backspace", label: "Backspace", type: "key", key: "Backspace" },
      {
        id: "left",
        label: "←",
        accessibilityLabel: "Left",
        type: "key",
        key: "ArrowLeft",
      },
    ],
    trailing: [
      {
        id: "down",
        label: "↓",
        accessibilityLabel: "Down; hold for navigation options",
        type: "dual",
        key: "ArrowDown",
        menu: DOWN_NAVIGATION_MENU,
      },
      {
        id: "up",
        label: "↑",
        accessibilityLabel: "Up; hold for navigation options",
        type: "dual",
        key: "ArrowUp",
        menu: UP_NAVIGATION_MENU,
      },
      {
        id: "right",
        label: "→",
        accessibilityLabel: "Right",
        type: "key",
        key: "ArrowRight",
      },
      { id: "leader", label: "Leader", type: "menu", menu: LEADER_MENU },
      { id: "command", label: "Cmd", type: "menu", menu: COMMAND_MENU },
      { id: "keyboard", label: "Keyboard", type: "keyboard" },
    ],
  },
} as const satisfies ActionMenu;

validateActionMenu(ACTION_PAD_MENU);
